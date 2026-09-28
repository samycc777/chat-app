import { v4 as uuid } from 'uuid';
import db from './database';
import { cleanDisplayName } from './auth';
import { removeAttachmentIfUnused } from './attachments';

export type ChannelKind = 'text' | 'voice';
export interface Channel { id: string; name: string; kind: ChannelKind; position: number; }

// The room the server started with, whose channels have no room_id (see database.ts). Text channels
// exist only there; every other room has just its call.
export const HOME_ROOM = 'home';
const IN_ROOM = "COALESCE(room_id, 'home') = ?";

// Everything here stays inside one room, so nobody can reach another room's channels by their ID.
export function listChannels(roomId = HOME_ROOM): Channel[] {
  return db.prepare(`SELECT id, name, kind, position FROM channels WHERE ${IN_ROOM} ORDER BY position, created_at`).all(roomId) as Channel[];
}

export function getChannel(id: unknown, roomId = HOME_ROOM): Channel | undefined {
  if (typeof id !== 'string') return undefined;
  return db.prepare(`SELECT id, name, kind, position FROM channels WHERE id = ? AND ${IN_ROOM}`).get(id, roomId) as Channel | undefined;
}

export const isTextChannel = (id: unknown) => getChannel(id)?.kind === 'text';
export const isVoiceChannel = (id: unknown, roomId = HOME_ROOM) => getChannel(id, roomId)?.kind === 'voice';

export function cleanChannelName(value: unknown): string {
  return cleanDisplayName(value).slice(0, 40);
}

export function createChannel(name: string, kind: ChannelKind, roomId = HOME_ROOM): Channel {
  const id = uuid();
  const position = (db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels WHERE ${IN_ROOM}`).get(roomId) as { next: number }).next;
  db.transaction(() => {
    if (kind === 'text') db.prepare("INSERT INTO conversations (id, type, name) VALUES (?, 'group', ?)").run(id, name);
    db.prepare('INSERT INTO channels (id, name, kind, position, created_at, room_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, kind, position, Date.now(), roomId === HOME_ROOM ? null : roomId);
  })();
  return { id, name, kind, position };
}

export function renameChannel(id: string, name: string) {
  db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id);
  db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, id);
}

// A deleted text channel takes its messages and their files with it.
export function deleteChannel(channel: Channel) {
  const attachments = db.prepare('SELECT id FROM attachments WHERE conversation_id = ?').all(channel.id) as { id: string }[];
  db.transaction(() => {
    db.prepare('UPDATE messages SET deleted = 1, attachment_id = NULL WHERE conversation_id = ?').run(channel.id);
    for (const attachment of attachments) removeAttachmentIfUnused(attachment.id);
    db.prepare('DELETE FROM message_reads WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').run(channel.id);
    // Replies in other channels cannot point into this one, so its messages can go all at once.
    db.prepare('UPDATE messages SET reply_to = NULL WHERE conversation_id = ?').run(channel.id);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(channel.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(channel.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
  })();
}
