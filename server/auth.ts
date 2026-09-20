import { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import db, { CLASSROOM_ID } from './database';

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production'
  ? (() => { throw new Error('JWT_SECRET is required in production'); })()
  : 'local-development-only-change-me');
if (process.env.NODE_ENV === 'production' && JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

export interface AuthRequest extends Request { userId?: string; }
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }
  const userId = verifyToken(token);
  if (!userId || !db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(CLASSROOM_ID, userId)) {
    res.status(401).json({ error: 'Invalid or expired classroom session' }); return;
  }
  req.userId = userId;
  next();
}

export function verifyToken(token: string): string | null {
  try { return (jwt.verify(token, JWT_SECRET) as { userId: string }).userId; } catch { return null; }
}

const router = Router();
router.post('/join', (req: Request, res: Response) => {
  const classCode = typeof req.body.classCode === 'string' ? req.body.classCode : '';
  const visitorId = typeof req.body.visitorId === 'string' ? req.body.visitorId : '';
  const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
  if (classCode !== '0000') { res.status(401).json({ error: 'Incorrect class code' }); return; }
  if (!/^[0-9a-f-]{36}$/i.test(visitorId)) { res.status(400).json({ error: 'Invalid visitor identity' }); return; }
  if (displayName.length > 60) { res.status(400).json({ error: 'Display name must be at most 60 characters' }); return; }

  let user = db.prepare('SELECT id, username, display_name, avatar_color, status FROM users WHERE visitor_id = ?').get(visitorId) as any;
  if (!user && !displayName) { res.status(400).json({ error: 'Display name is required' }); return; }
  if (user && displayName) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, user.id);
    user.display_name = displayName;
  }
  if (!user) {
    const id = uuid();
    const username = `visitor_${id.replace(/-/g, '')}`;
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, avatar_color, visitor_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, username, displayName, 'disabled', avatarColor, visitorId);
    user = { id, username, display_name: displayName, avatar_color: avatarColor, status: 'In class' };
  }
  db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(CLASSROOM_ID, user.id);
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, conversationId: CLASSROOM_ID, user: {
    id: user.id, username: user.username, displayName: user.display_name,
    avatarColor: user.avatar_color, status: user.status || 'In class',
  } });
});
export default router;
