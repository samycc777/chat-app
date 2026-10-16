import { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import { v4 as uuid } from 'uuid';
import db from './database';
import { production } from './config';
import { HOME_ROOM } from './channels';
import { addRoomMember, getRoom, roomForKey } from './rooms';
import { createLimiter } from './rateLimit';
import { avatarUrl } from './avatars';

const JWT_SECRET = process.env.JWT_SECRET || (production
  ? (() => { throw new Error('JWT_SECRET is required in production'); })()
  : 'local-development-only-change-me');
if (production && JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
const AVATAR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
// Wrong keys lock an address out only briefly, so friends sharing one network recover quickly from
// a mangled link, while the hourly cap keeps guessing a key impractically slow.
const failedJoinLimits = [createLimiter(10, 60_000), createLimiter(100, 60 * 60_000)];

export interface Session { userId: string; roomId: string; sessionId?: string; }
export interface AuthRequest extends Request { userId?: string; roomId?: string; sessionId?: string; }

// Friends open the app from their home screen for weeks, so a session lasts a month; changing
// the invite key still ends every session at once, and signing out ends that one.
const SESSION_DAYS = 30;

// A session stays valid only while the invite key it was opened with is unchanged, so changing the
// key in the deployment settings signs out everyone who does not have the new link. A room that no
// longer exists has no fingerprint, which ends its sessions too.
function keyFingerprint(roomId = HOME_ROOM) {
  const room = getRoom(roomId);
  return room ? createHmac('sha256', JWT_SECRET).update(`invite:${room.key}`).digest('base64url').slice(0, 22) : null;
}

const sessionRow = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND room_id = ? AND expires_at > ?');
export function verifyToken(token: string): Session | null {
  let claims: { userId?: unknown; roomId?: unknown; code?: unknown; sid?: unknown; purpose?: unknown };
  try { claims = jwt.verify(token, JWT_SECRET) as typeof claims; } catch { return null; }
  // Other passes signed with the same secret (the home-screen hand-off below) are not sessions.
  if (claims.purpose !== undefined) return null;
  // Sessions from before rooms existed carry no room; they were all opened in the home room.
  const roomId = claims.roomId === undefined ? HOME_ROOM : claims.roomId;
  if (typeof claims.userId !== 'string' || typeof roomId !== 'string' || !claims.code || claims.code !== keyFingerprint(roomId)) return null;
  // A session with an ID must still have its row: signing out, or deleting one's data, removes it.
  // Sessions from before rows existed have no ID and run until they expire.
  if (claims.sid !== undefined && (typeof claims.sid !== 'string' || !sessionRow.get(claims.sid, claims.userId, roomId, Date.now()))) return null;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(claims.userId) as { id: string } | undefined;
  return user ? { userId: user.id, roomId, ...(typeof claims.sid === 'string' ? { sessionId: claims.sid } : {}) } : null;
}

function openSession(userId: string, roomId: string) {
  const now = Date.now();
  const id = uuid();
  // Expired rows are only clutter, so each new session sweeps them away.
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO sessions (id, user_id, room_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, roomId, now, now + SESSION_DAYS * 24 * 60 * 60_000);
  return jwt.sign({ userId, roomId, sid: id, code: keyFingerprint(roomId) }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'No token provided' }); return; }
  const session = verifyToken(token);
  if (!session) { res.status(401).json({ error: 'Invalid or expired session' }); return; }
  req.userId = session.userId;
  req.roomId = session.roomId;
  req.sessionId = session.sessionId;
  next();
}

// An iPhone's Home Screen app starts with empty storage, so the page puts a hand-off pass in the
// app's start link (see homeScreen.ts and the manifest route in index.ts) that lets the new app
// carry on as the same person. Before, the link carried the device's permanent identity, which
// then sat in the app's start link and could be copied out of it for good. A hand-off pass lasts
// two days, and it works only from the network it was made on: the Home Screen app is added and
// opened on the same phone a moment later, while anyone else could make a pass for their own
// account and send it in a link, signing a friend's new device in as them without noticing.
const HANDOFF_FORMAT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const networkOf = (ip: string) => createHmac('sha256', JWT_SECRET).update(`network:${ip}`).digest('base64url').slice(0, 22);
export const handoffFormat = (value: string) => value.length <= 1000 && HANDOFF_FORMAT.test(value);
export function makeHandoff(userId: string, ip: string) {
  return jwt.sign({ purpose: 'handoff', net: networkOf(ip) }, JWT_SECRET, { subject: userId, expiresIn: '2d' });
}
function handoffUser(handoff: unknown, ip: string): string | null {
  if (typeof handoff !== 'string' || !handoffFormat(handoff)) return null;
  let claims: { purpose?: unknown; sub?: unknown; net?: unknown };
  try { claims = jwt.verify(handoff, JWT_SECRET) as typeof claims; } catch { return null; }
  if (claims.purpose !== 'handoff' || typeof claims.sub !== 'string' || claims.net !== networkOf(ip)) return null;
  return claims.sub;
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
  const room = roomForKey(typeof body.inviteKey === 'string' ? body.inviteKey : '');
  if (!room) {
    for (const limit of failedJoinLimits) limit.hit(ip);
    res.status(401).json({ error: 'Invalid invite link' }); return;
  }
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId : '';
  const displayName = cleanDisplayName(body.displayName);
  if (!/^[0-9a-f-]{36}$/i.test(visitorId)) { res.status(400).json({ error: 'Invalid visitor identity' }); return; }
  if (displayName.length > 60) { res.status(400).json({ error: 'Display name must be at most 60 characters' }); return; }

  const userColumns = 'SELECT id, username, display_name, avatar_color, status, visitor_id FROM users';
  let user = db.prepare(`${userColumns} WHERE visitor_id = ?`).get(visitorId) as any;
  // A new device with a valid hand-off becomes the person who made it, and learns their identity.
  // A hand-off that does not check out is ignored, and the device starts as a new person.
  let adopted = false;
  if (!user) {
    const handedOff = handoffUser(body.handoff, ip);
    user = handedOff ? db.prepare(`${userColumns} WHERE id = ?`).get(handedOff) : undefined;
    adopted = Boolean(user);
    // Someone from the class app's days may never have had a device identity; this one becomes it.
    if (user && !user.visitor_id) {
      db.prepare('UPDATE users SET visitor_id = ? WHERE id = ?').run(visitorId, user.id);
      user.visitor_id = visitorId;
    }
  }
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
    user = { id, username, display_name: displayName, avatar_color: avatarColor, status: '', visitor_id: visitorId };
  }
  addRoomMember(room.id, user.id);
  const token = openSession(user.id, room.id);
  res.json({ token, room: { id: room.id, name: room.name || null }, ...(adopted ? { visitorId: user.visitor_id } : {}), user: {
    id: user.id, username: user.username, displayName: user.display_name,
    avatarColor: user.avatar_color, status: user.status || '',
    avatarUrl: avatarUrl((db.prepare('SELECT id FROM avatars WHERE user_id = ?').get(user.id) as { id: string } | undefined)?.id),
  } });
});
export default router;
