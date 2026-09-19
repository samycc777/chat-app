import { Response, Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import path from 'path';
import db from './database';
import { AuthRequest, authMiddleware } from './auth';

const router = Router();
router.use(authMiddleware);

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const uploadsDir = path.join(dataDir, 'uploads');

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

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

router.get('/users/search', (req: AuthRequest, res: Response) => {
  const q = req.query.q as string;
  if (!q || q.length < 1) { res.json([]); return; }
  const users = db.prepare(
    `SELECT id, username, display_name, avatar_color, status FROM users
     WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 20`
  ).all(`%${q}%`, `%${q}%`, req.userId!) as any[];
  res.json(users.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarColor: u.avatar_color, status: u.status,
  })));
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
    WHERE cm.user_id = ?
    ORDER BY last_message_time DESC NULLS LAST
  `).all(req.userId!, req.userId!, req.userId!) as any[];

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

router.post('/conversations', (req: AuthRequest, res: Response) => {
  const { type, memberIds, name } = req.body;

  if (type === 'direct') {
    if (!memberIds || memberIds.length !== 1) {
      res.status(400).json({ error: 'Direct conversation needs exactly one other member' });
      return;
    }
    const existing = db.prepare(`
      SELECT c.id FROM conversations c
      WHERE c.type = 'direct'
        AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)
        AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)
        AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 2
    `).get(req.userId!, memberIds[0]) as any;

    if (existing) {
      res.json({ id: existing.id, existing: true });
      return;
    }
  }

  const id = uuid();
  const allMembers = [req.userId!, ...(memberIds || [])];

  const insertConversation = db.prepare(
    'INSERT INTO conversations (id, type, name, created_by) VALUES (?, ?, ?, ?)'
  );
  const insertMember = db.prepare(
    'INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)'
  );

  db.transaction(() => {
    insertConversation.run(id, type || 'direct', name || null, req.userId!);
    for (const memberId of allMembers) {
      insertMember.run(id, memberId);
    }
  })();

  res.status(201).json({ id });
});

router.get('/conversations/:id/messages', (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const before = req.query.before as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const isMember = db.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).get(id, req.userId!);
  if (!isMember) { res.status(403).json({ error: 'Not a member' }); return; }

  let query = `
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.type, m.file_url, m.file_name,
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
      fileUrl: m.deleted ? null : m.file_url, fileName: m.deleted ? null : m.file_name,
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
  const isImage = req.file.mimetype.startsWith('image/');
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    type: isImage ? 'image' : 'file',
  });
});

export default router;
