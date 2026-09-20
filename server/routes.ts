import { Response, Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from './database';
import { AuthRequest, authMiddleware } from './auth';
import { CLASSROOM_ID } from './database';
import { MAX_UPLOAD_BYTES } from './config';

const router = Router();
router.use(authMiddleware);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const uploadsDir = path.join(dataDir, 'uploads');

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    cb(null, uuid());
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });

interface IceServerConfig { urls: string | string[]; username?: string; credential?: string; }

async function getIceServers(): Promise<IceServerConfig[]> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const apiKey = process.env.TWILIO_API_KEY?.trim();
  const apiSecret = process.env.TWILIO_API_SECRET;
  const configured = Boolean(accountSid || apiKey || apiSecret);
  if (!configured && process.env.NODE_ENV !== 'production') {
    return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  }
  if (!accountSid || !apiKey || !apiSecret) {
    throw new Error('Twilio TURN is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY, and TWILIO_API_SECRET.');
  }

  let response: globalThis.Response;
  try {
    response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Tokens.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Ttl: '3600' }),
    });
  } catch {
    throw new Error('Twilio TURN credentials are temporarily unavailable.');
  }
  if (!response.ok) throw new Error('Twilio TURN credentials are temporarily unavailable.');

  let data: { ice_servers?: IceServerConfig[] };
  try {
    data = await response.json() as { ice_servers?: IceServerConfig[] };
  } catch {
    throw new Error('Twilio returned an invalid TURN configuration.');
  }
  if (!Array.isArray(data.ice_servers) || !data.ice_servers.length) {
    throw new Error('Twilio returned an invalid TURN configuration.');
  }
  return data.ice_servers;
}

router.get('/ice-config', async (_req: AuthRequest, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ iceServers: await getIceServers() });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'ICE configuration unavailable.' });
  }
});

router.get('/upload-config', (_req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ maxUploadBytes: MAX_UPLOAD_BYTES });
});

function memberOf(conversationId: string, userId: string) {
  return conversationId === CLASSROOM_ID && Boolean(db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(CLASSROOM_ID, userId));
}

function detectMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

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
      u.username as sender_username, u.display_name as sender_display_name, u.avatar_color as sender_avatar_color
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
        `SELECT m.id, m.content, m.type, m.sender_id, u.display_name as sender_display_name
         FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
      ).get(m.reply_to) as any;
      if (replied) {
        replyTo = {
          id: replied.id, content: replied.content, type: replied.type,
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
        avatarColor: m.sender_avatar_color,
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
