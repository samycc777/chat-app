import { Response, Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from './database';
import { AuthRequest, authMiddleware } from './auth';
import { getCall, screenIdentity } from './voice';
import { isTextChannel, isVoiceChannel } from './channels';
import { MAX_UPLOAD_BYTES, UPLOADS_DIR } from './config';
import { detectMime } from './attachments';
import { MESSAGE_SELECT, toMessage } from './messages';
import { pinnedMessages, searchMessages } from './chat';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { liveKitConfig } from './livekit';
import { rateLimit } from './rateLimit';
import { pushRouter } from './push';

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

// The phone apps share the screen from their Android code, which joins the call as a second,
// screen-only participant. It may publish nothing but the screen and receives nobody, so it adds
// no extra download to the phone that is already in the call.
router.post('/livekit/screen-token', async (req: AuthRequest, res: Response) => {
  const channelId = req.body?.channelId;
  if (!isVoiceChannel(channelId)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  const call = getCall(channelId);
  if (!call?.members.has(req.userId!)) { res.status(409).json({ error: 'Not in this voice channel' }); return; }

  const config = liveKitConfig();
  if (!config) { res.status(503).json({ error: 'Calls are not configured' }); return; }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.userId!) as { display_name?: string } | undefined;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: screenIdentity(req.userId!),
    name: user?.display_name || 'Friend',
    ttl: '6h',
  });
  token.addGrant({
    roomJoin: true,
    room: call.roomName,
    canSubscribe: false,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  call.phoneScreens.add(req.userId!);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: config.url, token: await token.toJwt() });
});

router.get('/me', (req: AuthRequest, res: Response) => {
  const user = db.prepare(
    'SELECT id, username, display_name, avatar_color, status, notify_level FROM users WHERE id = ?'
  ).get(req.userId!) as any;
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color,
    status: user.status,
    notifyLevel: user.notify_level,
  });
});

router.use('/push', pushRouter);

const MESSAGE_ID = /^[0-9a-f-]{36}$/i;
const TIMESTAMP = /^\d+$/;

router.get('/conversations/:id/messages', (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { before, beforeId, after, afterId, around } = req.query;
  const parsedLimit = req.query.limit === undefined ? 50 : (typeof req.query.limit === 'string' ? Number(req.query.limit) : Number.NaN);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) { res.status(400).json({ error: 'Invalid message limit' }); return; }
  const limit = parsedLimit;
  const badTimestamp = (value: unknown) => value !== undefined && (typeof value !== 'string' || !TIMESTAMP.test(value) || !Number.isSafeInteger(Number(value)));
  const badId = (value: unknown) => value !== undefined && (typeof value !== 'string' || !MESSAGE_ID.test(value));
  if (badTimestamp(before) || badTimestamp(after) || badId(beforeId) || badId(afterId) || badId(around)) {
    res.status(400).json({ error: 'Invalid message cursor' }); return;
  }

  if (!isTextChannel(id)) { res.status(404).json({ error: 'Unknown channel' }); return; }

  // Messages sent in the same millisecond keep the order they arrived in (their row number), so
  // paging from a given message never skips or repeats one of them.
  const page = (direction: 'older' | 'newer', createdAt?: number, messageId?: string, count = limit, inclusive = false) => {
    let query = `${MESSAGE_SELECT} WHERE m.conversation_id = ?`;
    const params: any[] = [id];
    const [compare, order] = direction === 'older' ? ['<', 'DESC'] : ['>', 'ASC'];
    if (createdAt !== undefined && messageId) {
      query += ` AND (m.created_at ${compare} ? OR (m.created_at = ? AND m.rowid ${compare}${inclusive ? '=' : ''} (SELECT rowid FROM messages WHERE id = ?)))`;
      params.push(createdAt, createdAt, messageId);
    } else if (createdAt !== undefined) {
      query += ` AND m.created_at ${compare} ?`;
      params.push(createdAt);
    }
    query += ` ORDER BY m.created_at ${order}, m.rowid ${order} LIMIT ?`;
    params.push(count);
    const rows = (db.prepare(query).all(...params) as any[]).map(toMessage);
    return direction === 'older' ? rows.reverse() : rows;
  };

  // Opening a search result or a pin shows the conversation around that message.
  if (typeof around === 'string') {
    const target = db.prepare('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?').get(around, id) as { created_at: number } | undefined;
    if (!target) { res.status(404).json({ error: 'Message not found' }); return; }
    const half = Math.floor(limit / 2);
    res.json([...page('older', target.created_at, around, half), ...page('newer', target.created_at, around, limit - half, true)]);
    return;
  }
  if (after !== undefined) { res.json(page('newer', Number(after), afterId as string | undefined)); return; }
  res.json(page('older', before === undefined ? undefined : Number(before), beforeId as string | undefined));
});

router.get('/conversations/:id/pins', (req: AuthRequest, res: Response) => {
  if (!isTextChannel(req.params.id)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  res.json(pinnedMessages(req.params.id as string));
});

router.get('/search', (req: AuthRequest, res: Response) => {
  const { q, channelId } = req.query;
  if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100) { res.status(400).json({ error: 'Invalid search' }); return; }
  if (channelId !== undefined && !isTextChannel(channelId)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  res.json(searchMessages(q, typeof channelId === 'string' ? channelId : null));
});

router.post('/upload', rateLimit<AuthRequest>(20, 60_000, req => req.userId!), upload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
  const conversationId = req.body.conversationId;
  const storedPath = path.join(uploadsDir, req.file.filename);
  if (!isTextChannel(conversationId)) {
    fs.unlinkSync(storedPath); res.status(404).json({ error: 'Unknown channel' }); return;
  }
  const mimeType = detectMime(fs.readFileSync(storedPath).subarray(0, 16), req.file.mimetype);
  if (!mimeType) { fs.unlinkSync(storedPath); res.status(415).json({ error: 'Only images, PDFs, sound and video are allowed' }); return; }
  // Only sound and video have a length, measured by the device that recorded it.
  const duration = Number(req.body.durationMs);
  const durationMs = /^(audio|video)\//.test(mimeType) && Number.isSafeInteger(duration) && duration > 0 && duration <= 12 * 3600_000 ? duration : null;
  const id = uuid();
  const originalName = path.basename(req.file.originalname.replace(/[\\/]/g, '_')).slice(0, 180) || 'attachment';
  db.prepare('INSERT INTO attachments (id, conversation_id, uploader_id, disk_name, original_name, mime_type, size, created_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, conversationId, req.userId!, req.file.filename, originalName, mimeType, req.file.size, Date.now(), durationMs);
  // Sound and video are sent as file messages; the app shows them by their type.
  res.json({
    attachmentId: id,
    name: originalName,
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    mimeType,
    durationMs,
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
