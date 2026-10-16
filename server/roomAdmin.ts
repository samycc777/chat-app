import { Request, Response, Router } from 'express';
import { randomBytes } from 'crypto';
import db from './database';
import { operatorRefused } from './rooms';
import { closeRoom } from './socket';

// The owner looks after customers' rooms with the creation key (ROOM_CREATION_KEY), the same way
// they make them: a room whose link has gone where it should not gets a new key, and a customer who
// leaves has their room deleted. The home room is not here: its key is INVITE_KEY in the deployment
// settings, and changing that already ends its sessions.

export const roomAdminRouter = Router();
const customerRoom = db.prepare('SELECT id, name FROM rooms WHERE id = ?');

// A new key ends every session opened with the old one at once (their token no longer matches the
// key, see keyFingerprint in auth.ts), so whoever had the old link is out, and only people who are
// given the new link come back. Membership is part of having the link, so it goes too: until
// someone joins again, they get no notifications of the room's calls.
roomAdminRouter.post('/:id/new-key', (req: Request, res: Response) => {
  if (operatorRefused(req, res)) return;
  const room = customerRoom.get(req.params.id) as { id: string; name: string } | undefined;
  if (!room) { res.status(404).json({ error: 'No such room' }); return; }
  const key = randomBytes(15).toString('hex');
  db.transaction(() => {
    db.prepare('UPDATE rooms SET invite_key = ? WHERE id = ?').run(key, room.id);
    db.prepare('DELETE FROM sessions WHERE room_id = ?').run(room.id);
    db.prepare('DELETE FROM room_members WHERE room_id = ?').run(room.id);
  })();
  closeRoom(room.id, "the room's key changed");
  res.setHeader('Cache-Control', 'no-store');
  res.json({ id: room.id, name: room.name, invite: key });
});

// Deleting a room deletes everything about it: its call, sessions and members, and the people who
// were in no other room, with their pictures and devices for notifications, since the server would
// otherwise keep them with no way for them to ever come back.
roomAdminRouter.delete('/:id', (req: Request, res: Response) => {
  if (operatorRefused(req, res)) return;
  const room = customerRoom.get(req.params.id) as { id: string } | undefined;
  if (!room) { res.status(404).json({ error: 'No such room' }); return; }
  closeRoom(room.id, 'the room was deleted');
  db.transaction(() => {
    const onlyHere = (db.prepare(`SELECT user_id FROM room_members WHERE room_id = ?
      AND user_id NOT IN (SELECT user_id FROM room_members WHERE room_id != ?)`).all(room.id, room.id) as { user_id: string }[])
      .map(row => row.user_id);
    db.prepare('DELETE FROM sessions WHERE room_id = ?').run(room.id);
    db.prepare('DELETE FROM room_members WHERE room_id = ?').run(room.id);
    for (const userId of onlyHere) {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
      // Their other sessions, if any, and their picture go with them (ON DELETE CASCADE).
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
    // The room's call channel goes with it (ON DELETE CASCADE).
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  })();
  res.json({ ok: true });
});
