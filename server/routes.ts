import { Response, Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from './database';
import { AuthRequest, authMiddleware } from './auth';
import { CLASSROOM_ID } from './database';
import { MAX_UPLOAD_BYTES, UPLOADS_DIR } from './config';
import { detectMime } from './attachments';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { getLessonSession } from './lesson';

const router = Router();
router.use(authMiddleware);

const uploadsDir = UPLOADS_DIR;

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    cb(null, uuid());
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });

router.get('/upload-config', (_req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ maxUploadBytes: MAX_UPLOAD_BYTES });
});

router.post('/livekit/token', async (req: AuthRequest, res: Response) => {
  const conversationId = req.body?.conversationId;
  if (typeof conversationId !== 'string' || !memberOf(conversationId, req.userId!)) {
    res.status(403).json({ error: 'Not a classroom member' }); return;
  }
  const session = getLessonSession(conversationId);
  if (!session) { res.status(409).json({ error: 'No lesson is active' }); return; }

  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    res.status(503).json({ error: 'Lesson streaming is not configured' }); return;
  }

  const isPresenter = session.presenterId === req.userId;
  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId!) as { display_name?: string } | undefined;
  const token = new AccessToken(apiKey, apiSecret, {
    identity: req.userId!,
    name: user?.display_name || 'Classroom member',
    ttl: '1h',
    // Lets every lesson client recognise the teacher, even one who is not presenting.
    attributes: { role: req.role! },
  });
  token.addGrant({
    roomJoin: true,
    room: session.roomName,
    canSubscribe: true,
    canPublish: true,
    // Raised hands and reactions travel over LiveKit data messages.
    canPublishData: true,
    canPublishSources: isPresenter
      ? [TrackSource.SCREEN_SHARE, TrackSource.MICROPHONE]
      : [TrackSource.MICROPHONE],
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url, token: await token.toJwt(), roomName: session.roomName, encryptionKey: session.encryptionKey, startedAt: session.startedAt });
});

function memberOf(conversationId: string, userId: string) {
  return conversationId === CLASSROOM_ID && Boolean(db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(CLASSROOM_ID, userId));
}

router.get('/me', (req: AuthRequest, res: Response) => {
  const user = db.prepare(
    'SELECT id, username, display_name, avatar_color, status, role FROM users WHERE id = ?'
  ).get(req.userId!) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color,
    status: user.status,
    role: user.role,
  });
});

router.get('/conversations', (req: AuthRequest, res: Response) => {
  const conversations = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at,
      (SELECT content FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT sender_id FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message_sender,
      (SELECT type FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message_type,
      (SELECT created_at FROM messages WHERE conversation_id = c.id AND deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_message_time,
      (SELECT COUNT(*) FROM messages m
       WHERE m.conversation_id = c.id AND m.deleted = 0 AND m.sender_id != ?
       AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?)) as unread_count
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.user_id = ? AND c.id = ?
    ORDER BY last_message_time DESC NULLS LAST
  `).all(req.userId!, req.userId!, req.userId!, CLASSROOM_ID) as any[];

  const result = conversations.map(c => {
    const members = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_color, u.status, u.last_seen
      FROM users u JOIN conversation_members cm ON cm.user_id = u.id
      WHERE cm.conversation_id = ?
    `).all(c.id) as any[];

    return {
      id: c.id, type: c.type, name: c.name, createdAt: c.created_at,
      lastMessage: c.last_message, lastMessageSender: c.last_message_sender,
      lastMessageType: c.last_message_type, lastMessageTime: c.last_message_time,
      unreadCount: c.unread_count,
      members: members.map(m => ({
        id: m.id, username: m.username, displayName: m.display_name,
        avatarColor: m.avatar_color, status: m.status, lastSeen: m.last_seen,
      })),
    };
  });

  res.json(result);
});

router.get('/conversations/:id/messages', (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const before = req.query.before as string | undefined;
  const parsedLimit = req.query.limit === undefined ? 50 : (typeof req.query.limit === 'string' ? Number(req.query.limit) : Number.NaN);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) { res.status(400).json({ error: 'Invalid message limit' }); return; }
  const limit = parsedLimit;
  if (before !== undefined && (typeof before !== 'string' || !/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) {
    res.status(400).json({ error: 'Invalid message cursor' }); return;
  }

  const isMember = db.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).get(id, req.userId!);
  if (id !== CLASSROOM_ID || !isMember) { res.status(403).json({ error: 'Not a classroom member' }); return; }

  let query = `
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.type, m.file_url, m.file_name, m.attachment_id,
      m.reply_to, m.edited_at, m.deleted, m.created_at,
      u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color,
      u.role as sender_role
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ?
  `;
  const params: any[] = [id];

  if (before) {
    query += ' AND m.created_at < ?';
    params.push(parseInt(before));
  }

  query += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(limit);

  const messages = (db.prepare(query).all(...params) as any[]).reverse();

  const result = messages.map(m => {
    let replyTo = null;
    if (m.reply_to) {
      const replied = db.prepare(
        `SELECT m.id, m.content, m.type, m.deleted, m.sender_id, u.display_name as sender_display_name
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
      ).get(m.reply_to) as any;
      if (replied) {
        replyTo = {
          id: replied.id, content: replied.deleted ? null : replied.content, type: replied.type, deleted: !!replied.deleted,
          senderId: replied.sender_id, senderDisplayName: replied.sender_display_name,
        };
      }
    }
    return {
      id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
      content: m.deleted ? null : m.content, type: m.type,
      fileUrl: null, attachmentId: m.deleted ? null : m.attachment_id, fileName: m.deleted ? null : m.file_name,
      replyTo, editedAt: m.edited_at, deleted: !!m.deleted, createdAt: m.created_at,
      sender: {
        username: m.sender_username, displayName: m.sender_display_name,
        avatarColor: m.sender_avatar_color, role: m.sender_role,
      },
    };
  });

  res.json(result);
});

router.post('/upload', upload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
  const conversationId = req.body.conversationId;
  const storedPath = path.join(uploadsDir, req.file.filename);
  if (typeof conversationId !== 'string' || !memberOf(conversationId, req.userId!)) {
    fs.unlinkSync(storedPath); res.status(403).json({ error: 'Not a conversation member' }); return;
  }
  const mimeType = detectMime(fs.readFileSync(storedPath).subarray(0, 16));
  if (!mimeType) { fs.unlinkSync(storedPath); res.status(415).json({ error: 'Only images and PDFs are allowed' }); return; }
  const id = uuid();
  const originalName = path.basename(req.file.originalname.replace(/[\\/]/g, '_')).slice(0, 180) || 'attachment';
  db.prepare('INSERT INTO attachments (id, conversation_id, uploader_id, disk_name, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, conversationId, req.userId!, req.file.filename, originalName, mimeType, req.file.size, Date.now());
  res.json({
    attachmentId: id,
    name: originalName,
    type: mimeType === 'application/pdf' ? 'file' : 'image',
  });
});

router.get('/attachments/:id', (req: AuthRequest, res: Response) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id) as any;
  if (!attachment || !memberOf(attachment.conversation_id, req.userId!)) {
    res.status(404).json({ error: 'Attachment not found' }); return;
  }
  const diskPath = path.join(uploadsDir, attachment.disk_name);
  if (!fs.existsSync(diskPath)) { res.status(404).json({ error: 'Attachment file not found' }); return; }
  res.setHeader('Content-Type', attachment.mime_type);
  res.setHeader('Content-Length', attachment.size);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(diskPath);
});

export default router;
