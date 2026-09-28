import { Request, Response, Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { v4 as uuid } from 'uuid';
import db from './database';
import { inviteKey, inviteKeyMatches, normalizeCode, production, serverName } from './config';
import { createChannel, HOME_ROOM } from './channels';
import { cleanDisplayName } from './auth';
import { createLimiter } from './rateLimit';

// Every customer gets a room of their own: its own name, its own invite link and its own call,
// with nobody from another room able to see or hear them. The home room is the one the server
// started with, for the friends and the class; it is never billed and keeps its key in the
// deployment settings (INVITE_KEY), so its link and sessions are unchanged.

export interface Room { id: string; name: string; key: string; }

export function homeRoom(): Room {
  return { id: HOME_ROOM, name: serverName(), key: inviteKey() };
}

const roomById = db.prepare('SELECT id, name, invite_key AS key FROM rooms WHERE id = ?');
const roomByKey = db.prepare('SELECT id, name, invite_key AS key FROM rooms WHERE invite_key = ?');

export function getRoom(id: string): Room | undefined {
  return id === HOME_ROOM ? homeRoom() : roomById.get(id) as Room | undefined;
}

/** The room an invite key opens, if any. */
export function roomForKey(entered: string): Room | undefined {
  if (inviteKeyMatches(entered)) return homeRoom();
  const key = normalizeCode(entered);
  return key ? roomByKey.get(key) as Room | undefined : undefined;
}

/** The Socket.IO room every connection of a room joins, for what everyone in it should hear. */
export const roomChannel = (roomId: string) => `room:${roomId}`;

export function addRoomMember(roomId: string, userId: string) {
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(roomId, userId, Date.now());
}

export function cleanRoomName(value: unknown): string {
  return cleanDisplayName(value).slice(0, 60);
}

// A room's key is its invite link, so it is long enough that guessing one is hopeless. It uses
// only lowercase letters and digits, because keys are compared without case (see normalizeCode).
export function createRoom(name: string): Room {
  const room = { id: uuid(), name, key: randomBytes(15).toString('hex') };
  db.transaction(() => {
    db.prepare('INSERT INTO rooms (id, name, invite_key, created_at) VALUES (?, ?, ?, ?)').run(room.id, room.name, room.key, Date.now());
    // Named after the room, so a notification of its call says whose call it is.
    createChannel(name.slice(0, 40), 'voice', room.id);
  })();
  return room;
}

// Until paying for a room exists, making one on the live site needs ROOM_CREATION_KEY, which only
// the owner knows. On a developer's computer anyone can make one. Read on every use, like INVITE_KEY.
export function roomCreationAllowed(entered: unknown): boolean {
  const key = normalizeCode(process.env.ROOM_CREATION_KEY || '');
  if (!key) return !production;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return typeof entered === 'string' && timingSafeEqual(digest(normalizeCode(entered)), digest(key));
}

// A wrong creation key counts against the address, like a wrong invite key does.
const failedCreations = createLimiter(10, 60 * 60_000);
const createdRooms = createLimiter(20, 60 * 60_000);

export const roomsRouter = Router();
roomsRouter.post('/', (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  const limited = [failedCreations, createdRooms].map(limit => limit.exhausted(ip)).find(result => result.exhausted);
  if (limited) {
    res.setHeader('Retry-After', limited.retryAfterSeconds);
    res.status(429).json({ error: 'Too many attempts' }); return;
  }
  if (!roomCreationAllowed(req.body?.creationKey)) {
    failedCreations.hit(ip);
    res.status(403).json({ error: 'Creating rooms is closed' }); return;
  }
  const name = cleanRoomName(req.body?.name);
  if (!name) { res.status(400).json({ error: 'Room name is required' }); return; }
  createdRooms.hit(ip);
  const room = createRoom(name);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ id: room.id, name: room.name, invite: room.key });
});
