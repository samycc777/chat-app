import { v4 as uuid } from 'uuid';
import db from './database';

// Each room has one fixed voice channel, which is its call. The channel's ID names the call's
// LiveKit room (see voice.ts), so it never changes. The app looks for the channel by its kind,
// which is why the kind is still sent although every channel is a voice channel now.
export type ChannelKind = 'voice';
export interface Channel { id: string; name: string; kind: ChannelKind; position: number; }

// The room the server started with, whose channel has no room_id (see database.ts).
export const HOME_ROOM = 'home';
const IN_ROOM = "COALESCE(room_id, 'home') = ?";

// Everything here stays inside one room, so nobody can reach another room's call by its ID.
export function listChannels(roomId = HOME_ROOM): Channel[] {
  return db.prepare(`SELECT id, name, kind, position FROM channels WHERE kind = 'voice' AND ${IN_ROOM} ORDER BY position, created_at`).all(roomId) as Channel[];
}

export function getChannel(id: unknown, roomId = HOME_ROOM): Channel | undefined {
  if (typeof id !== 'string') return undefined;
  return db.prepare(`SELECT id, name, kind, position FROM channels WHERE id = ? AND kind = 'voice' AND ${IN_ROOM}`).get(id, roomId) as Channel | undefined;
}

export const isVoiceChannel = (id: unknown, roomId = HOME_ROOM) => Boolean(getChannel(id, roomId));

export function createVoiceChannel(name: string, roomId: string): Channel {
  const channel: Channel = { id: uuid(), name, kind: 'voice', position: 0 };
  db.prepare('INSERT INTO channels (id, name, kind, position, created_at, room_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(channel.id, name, channel.kind, channel.position, Date.now(), roomId === HOME_ROOM ? null : roomId);
  return channel;
}
