import { Response } from 'express';
import db from './database';
import { AuthRequest } from './auth';
import { endConnections, removeFromAllCalls } from './socket';

// Signing out ends the session on the server, not only on the device, so a copy of its token
// (from a shared tablet, a backup or a screenshot of the storage) stops working too. Sessions from
// before sessions had rows cannot be ended this way; they run out within a month.
export function signOut(req: AuthRequest, res: Response) {
  const sessionId = req.sessionId;
  if (sessionId) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    endConnections(session => session.sessionId === sessionId, 'they signed out');
  }
  res.json({ ok: true });
}

// Deletes everything the server keeps about the person asking: their name, picture, devices for
// notifications, rooms joined and every session, on every device. Their connections close first,
// so everyone in their rooms sees them leave and their calls end while they are still known.
export function deleteMyData(req: AuthRequest, res: Response) {
  const userId = req.userId!;
  endConnections(session => session.userId === userId, 'their data was deleted');
  removeFromAllCalls(userId);
  db.transaction(() => {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM room_members WHERE user_id = ?').run(userId);
    // Their sessions and picture go with them (ON DELETE CASCADE).
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  })();
  res.json({ ok: true });
}
