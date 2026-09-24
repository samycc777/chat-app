import { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import { v4 as uuid } from 'uuid';
import db from './database';
import { inviteKey, inviteKeyMatches, production } from './config';
import { createLimiter } from './rateLimit';

const JWT_SECRET = process.env.JWT_SECRET || (production
  ? (() => { throw new Error('JWT_SECRET is required in production'); })()
  : 'local-development-only-change-me');
if (production && JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
// Wrong keys lock an address out only briefly, so friends sharing one network recover quickly from
// a mangled link, while the hourly cap keeps guessing a key impractically slow.
const failedJoinLimits = [createLimiter(10, 60_000), createLimiter(100, 60 * 60_000)];

export interface Session { userId: string; }
export interface AuthRequest extends Request { userId?: string; }

// A session stays valid only while the invite key it was opened with is unchanged, so changing the
// key in the deployment settings signs out everyone who does not have the new link.
function keyFingerprint() {
  return createHmac('sha256', JWT_SECRET).update(`invite:${inviteKey()}`).digest('base64url').slice(0, 22);
}

export function verifyToken(token: string): Session | null {
  let claims: { userId?: unknown; code?: unknown };
  try { claims = jwt.verify(token, JWT_SECRET) as typeof claims; } catch { return null; }
  if (typeof claims.userId !== 'string' || claims.code !== keyFingerprint()) return null;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(claims.userId) as { id: string } | undefined;
  return user ? { userId: user.id } : null;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }
  const session = verifyToken(token);
  if (!session) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
  req.userId = session.userId;
  next();
}

// Control and bidirectional-override characters could make a name render as someone else's.
export function cleanDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '')
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
  if (!inviteKeyMatches(typeof body.inviteKey === 'string' ? body.inviteKey : '')) {
    for (const limit of failedJoinLimits) limit.hit(ip);
    res.status(401).json({ error: 'Invalid invite link' }); return;
  }
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId : '';
  const displayName = cleanDisplayName(body.displayName);
  if (!/^[0-9a-f-]{36}$/i.test(visitorId)) { res.status(400).json({ error: 'Invalid visitor identity' }); return; }
  if (displayName.length > 60) { res.status(400).json({ error: 'Display name must be at most 60 characters' }); return; }

  let user = db.prepare('SELECT id, username, display_name, avatar_color, status FROM users WHERE visitor_id = ?').get(visitorId) as any;
  if (!user && !displayName) { res.status(400).json({ error: 'Display name is required' }); return; }
  if (user) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName || user.display_name, user.id);
    user.display_name = displayName || user.display_name;
  } else {
    const id = uuid();
    const username = `visitor_${id.replace(/-/g, '')}`;
    const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, avatar_color, visitor_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, username, displayName, 'disabled', avatarColor, visitorId, '');
    user = { id, username, display_name: displayName, avatar_color: avatarColor, status: '' };
  }
  // Friends open the app from their home screen for weeks, so a session lasts a month; changing
  // the invite key still ends every session at once.
  const token = jwt.sign({ userId: user.id, code: keyFingerprint() }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: {
    id: user.id, username: user.username, displayName: user.display_name,
    avatarColor: user.avatar_color, status: user.status || '',
  } });
});
export default router;
