import { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import { v4 as uuid } from 'uuid';
import db, { CLASSROOM_ID } from './database';
import { classCode, production, Role, roleForCode } from './config';
import { createLimiter } from './rateLimit';

const JWT_SECRET = process.env.JWT_SECRET || (production
  ? (() => { throw new Error('JWT_SECRET is required in production'); })()
  : 'local-development-only-change-me');
if (production && JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
// Wrong codes lock an address out only briefly, so a class sharing one school network recovers
// quickly from a mistyped code, while the hourly cap keeps guessing a code impractically slow.
const failedJoinLimits = [createLimiter(10, 60_000), createLimiter(100, 60 * 60_000)];

export interface Session { userId: string; role: Role; }
export interface AuthRequest extends Request { userId?: string; role?: Role; }

// A session stays valid only while the code it was opened with is unchanged, so changing a
// code in the deployment settings signs out everyone who does not know the new one.
function codeFingerprint(role: Role) {
  return createHmac('sha256', JWT_SECRET).update(`${role}:${classCode(role)}`).digest('base64url').slice(0, 22);
}

// A removed session gets its own answer, so the student is told the teacher removed them.
export function verifyToken(token: string): Session | 'removed' | null {
  let claims: { userId?: unknown; code?: unknown };
  try { claims = jwt.verify(token, JWT_SECRET) as typeof claims; } catch { return null; }
  if (typeof claims.userId !== 'string' || typeof claims.code !== 'string') return null;
  const user = db.prepare(`
    SELECT u.id, u.role, u.removed_at FROM users u
    JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = ?
    WHERE u.id = ?
  `).get(CLASSROOM_ID, claims.userId) as { id: string; role: Role; removed_at: number | null } | undefined;
  if (!user || claims.code !== codeFingerprint(user.role)) return null;
  if (user.removed_at) return 'removed';
  return { userId: user.id, role: user.role };
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }
  const session = verifyToken(token);
  if (session === 'removed') { res.status(403).json({ error: 'Removed from class' }); return; }
  if (!session) { res.status(401).json({ error: 'Invalid or expired classroom session' }); return; }
  req.userId = session.userId;
  req.role = session.role;
  next();
}

// Control and bidirectional-override characters could make a name render as someone else's.
export function cleanDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const router = Router();
router.post('/join', (req: Request, res: Response) => {
  const body = req.body ?? {};
  const ip = req.ip || 'unknown';
  const lockout = failedJoinLimits.map(limit => limit.exhausted(ip)).find(result => result.exhausted);
  if (lockout) {
    res.setHeader('Retry-After', lockout.retryAfterSeconds);
    res.status(429).json({ error: 'Too many attempts' }); return;
  }
  const role = roleForCode(typeof body.classCode === 'string' ? body.classCode : '');
  if (!role) {
    for (const limit of failedJoinLimits) limit.hit(ip);
    res.status(401).json({ error: 'Incorrect class code' }); return;
  }
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId : '';
  const displayName = cleanDisplayName(body.displayName);
  if (!/^[0-9a-f-]{36}$/i.test(visitorId)) { res.status(400).json({ error: 'Invalid visitor identity' }); return; }
  if (displayName.length > 60) { res.status(400).json({ error: 'Display name must be at most 60 characters' }); return; }

  let user = db.prepare('SELECT id, username, display_name, avatar_color, status, role, removed_at FROM users WHERE visitor_id = ?').get(visitorId) as any;
  if (!user && !displayName) { res.status(400).json({ error: 'Display name is required' }); return; }
  // Someone the teacher removed cannot come back with the class code; the teacher code still works.
  if (user?.removed_at && role !== 'teacher') { res.status(403).json({ error: 'Removed from class' }); return; }
  if (user) {
    db.prepare('UPDATE users SET display_name = ?, role = ?, removed_at = NULL WHERE id = ?').run(displayName || user.display_name, role, user.id);
    user.display_name = displayName || user.display_name;
    user.role = role;
  } else {
    const id = uuid();
    const username = `visitor_${id.replace(/-/g, '')}`;
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, avatar_color, visitor_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, username, displayName, 'disabled', avatarColor, visitorId, role);
    user = { id, username, display_name: displayName, avatar_color: avatarColor, status: 'In class', role };
  }
  db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(CLASSROOM_ID, user.id);
  const token = jwt.sign({ userId: user.id, code: codeFingerprint(role) }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, conversationId: CLASSROOM_ID, user: {
    id: user.id, username: user.username, displayName: user.display_name,
    avatarColor: user.avatar_color, status: user.status || 'In class', role,
  } });
});
export default router;
