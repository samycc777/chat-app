import express, { Request, Response, Router } from 'express';
import { randomUUID } from 'crypto';
import db from './database';
import { AuthRequest } from './auth';
import { rateLimit } from './rateLimit';

// The app shrinks a chosen picture to a small square JPEG before sending it, so a real one is a few
// dozen kilobytes; the limit leaves room for that and nothing much bigger.
export const MAX_AVATAR_BYTES = 300 * 1024;

// A picture's address is its own random ID, made new each time someone changes their picture.
// An image cannot send the session header, so the address itself is the pass: it is only ever
// given to people in the same room, and a replaced picture's old address stops working.
export const avatarUrl = (avatarId: string | null | undefined) => avatarId ? `/api/avatars/${avatarId}` : null;

// socket.ts tells everyone in the room when someone's picture changes; set when it starts.
let profileChanged: (userId: string) => void = () => {};
export function onProfileChanged(listener: (userId: string) => void) { profileChanged = listener; }

const isJpeg = (data: Buffer) => data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

const replaceAvatar = db.transaction((userId: string, data: Buffer) => {
  const id = randomUUID();
  db.prepare('DELETE FROM avatars WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO avatars (id, user_id, data, created_at) VALUES (?, ?, ?, ?)').run(id, userId, data, Date.now());
  return id;
});

// Mounted under the signed-in API, at /me/avatar.
export const avatarRouter = Router();
avatarRouter.put('/', rateLimit<AuthRequest>(30, 60 * 60_000, req => req.userId!),
  express.raw({ type: 'image/jpeg', limit: MAX_AVATAR_BYTES }), (req: AuthRequest, res: Response) => {
    if (!Buffer.isBuffer(req.body) || !isJpeg(req.body)) { res.status(400).json({ error: 'The picture must be a JPEG image' }); return; }
    const id = replaceAvatar(req.userId!, req.body);
    profileChanged(req.userId!);
    res.json({ avatarUrl: avatarUrl(id) });
  });
avatarRouter.delete('/', (req: AuthRequest, res: Response) => {
  db.prepare('DELETE FROM avatars WHERE user_id = ?').run(req.userId!);
  profileChanged(req.userId!);
  res.json({ avatarUrl: null });
});

export function serveAvatar(req: Request, res: Response) {
  const id = typeof req.params.id === 'string' && /^[0-9a-f-]{36}$/i.test(req.params.id) ? req.params.id : '';
  const avatar = id ? db.prepare('SELECT data FROM avatars WHERE id = ?').get(id) as { data: Buffer } | undefined : undefined;
  if (!avatar) { res.status(404).json({ error: 'Not found' }); return; }
  // A changed picture gets a new address, so this one never changes and phones keep it for a day
  // instead of downloading every face again at each call.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.type('image/jpeg').send(avatar.data);
}
