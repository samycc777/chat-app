import { v4 as uuid } from 'uuid';
import db from './database';
import { cleanDisplayName } from './auth';
import { removeAttachmentIfUnused } from './attachments';

export type ChannelKind = 'text' | 'voice';
export interface Channel { id: string; name: string; kind: ChannelKind; position: number; }

export function listChannels(): Channel[] {
  return db.prepare('SELECT id, name, kind, position FROM channels ORDER BY position, created_at').all() as Channel[];
}

export function getChannel(id: unknown): Channel | undefined {
  if (typeof id !== 'string') return undefined;
  return db.prepare('SELECT id, name, kind, position FROM channels WHERE id = ?').get(id) as Channel | undefined;
}

export const isTextChannel = (id: unknown) => getChannel(id)?.kind === 'text';
export const isVoiceChannel = (id: unknown) => getChannel(id)?.kind === 'voice';

export function cleanChannelName(value: unknown): string {
  return cleanDisplayName(value).slice(0, 40);
}

export function createChannel(name: string, kind: ChannelKind): Channel {
  const id = uuid();
  const position = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM channels').get() as { next: number }).next;
  db.transaction(() => {
    if (kind === 'text') db.prepare("INSERT INTO conversations (id, type, name) VALUES (?, 'group', ?)").run(id, name);
    db.prepare('INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, kind, position, Date.now());
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
