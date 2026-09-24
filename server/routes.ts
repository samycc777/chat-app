import { Response, Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from './database';
import { AuthRequest, authMiddleware } from './auth';
import { getCall } from './voice';
import { isTextChannel, isVoiceChannel } from './channels';
import { MAX_UPLOAD_BYTES, UPLOADS_DIR } from './config';
import { detectMime } from './attachments';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { liveKitConfig } from './livekit';
import { rateLimit } from './rateLimit';

const router = Router();
router.use(authMiddleware);
router.use(rateLimit<AuthRequest>(300, 60_000, req => req.userId!));

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

// Only someone the server has put in the voice channel gets into its call, so nobody can listen in
// without showing up in the sidebar.
router.post('/livekit/token', async (req: AuthRequest, res: Response) => {
  const channelId = req.body?.channelId;
  if (!isVoiceChannel(channelId)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  const call = getCall(channelId);
  if (!call?.members.has(req.userId!)) { res.status(409).json({ error: 'Not in this voice channel' }); return; }

  const config = liveKitConfig();
  if (!config) { res.status(503).json({ error: 'Calls are not configured' }); return; }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId!) as { display_name?: string } | undefined;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: req.userId!,
    name: user?.display_name || 'Friend',
    ttl: '6h',
  });
  // Everyone is equal in a call: anyone can talk, show their camera and share their screen.
  token.addGrant({
    roomJoin: true,
    room: call.roomName,
    canSubscribe: true,
    canPublish: true,
    // Reactions travel over LiveKit data messages.
    canPublishData: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: config.url, token: await token.toJwt(), roomName: call.roomName, startedAt: call.startedAt });
});

router.get('/me', (req: AuthRequest, res: Response) => {
  const user = db.prepare(
    'SELECT id, username, display_name, avatar_color, status FROM users WHERE id = ?'
  ).get(req.userId!) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color,
    status: user.status,
  });
});

router.get('/conversations/:id/messages', (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const before = req.query.before as string | undefined;
  const beforeId = req.query.beforeId as string | undefined;
  const parsedLimit = req.query.limit === undefined ? 50 : (typeof req.query.limit === 'string' ? Number(req.query.limit) : Number.NaN);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) { res.status(400).json({ error: 'Invalid message limit' }); return; }
  const limit = parsedLimit;
  if (before !== undefined && (typeof before !== 'string' || !/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) {
    res.status(400).json({ error: 'Invalid message cursor' }); return;
  }
  if (beforeId !== undefined && (typeof beforeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(beforeId))) {
    res.status(400).json({ error: 'Invalid message cursor' }); return;
  }

  if (!isTextChannel(id)) { res.status(404).json({ error: 'Unknown channel' }); return; }

  let query = `
    SELECT m.rowid AS seq, m.id, m.conversation_id, m.sender_id, m.content, m.type, m.file_url, m.file_name, m.attachment_id,
      m.reply_to, m.edited_at, m.deleted, m.created_at,
      u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ?
  `;
  const params: any[] = [id];

  // Messages sent in the same millisecond keep the order they arrived in (their row number), so
  // paging from a given message never skips or repeats one of them.
  if (before && beforeId) {
    query += ' AND (m.created_at < ? OR (m.created_at = ? AND m.rowid < (SELECT rowid FROM messages WHERE id = ?)))';
    params.push(Number(before), Number(before), beforeId);
  } else if (before) {
    query += ' AND m.created_at < ?';
    params.push(Number(before));
  }

  query += ' ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?';
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
      id: m.id, seq: m.seq, conversationId: m.conversation_id, senderId: m.sender_id,
      content: m.deleted ? null : m.content, type: m.type,
      fileUrl: null, attachmentId: m.deleted ? null : m.attachment_id, fileName: m.deleted ? null : m.file_name,
      replyTo, editedAt: m.edited_at, deleted: !!m.deleted, createdAt: m.created_at,
      sender: {
        username: m.sender_username, displayName: m.sender_display_name,
        avatarColor: m.sender_avatar_color,
      },
    };
  });

  res.json(result);
});

router.post('/upload', rateLimit<AuthRequest>(20, 60_000, req => req.userId!), upload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
  const conversationId = req.body.conversationId;
  const storedPath = path.join(uploadsDir, req.file.filename);
  if (!isTextChannel(conversationId)) {
    fs.unlinkSync(storedPath); res.status(404).json({ error: 'Unknown channel' }); return;
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
  if (!attachment) {
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
