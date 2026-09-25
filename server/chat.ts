import { Server, Socket } from 'socket.io';
import db, { searchText } from './database';
import { getChannel } from './channels';
import { MESSAGE_SELECT, reactionsOf, toMessage } from './messages';

// Reactions are a short fixed set, none with faces, so every message's reactions stay tidy.
export const REACTION_EMOJIS = ['👍', '❤️', '✅', '🤲', '👏', '🌟'];
const MAX_PINS_PER_CHANNEL = 50;

// A channel's unread count leaves out your own messages. People start with the history read when
// they join, so a channel with no read position is one made since, and all of it is new to them.
const readsQuery = db.prepare(`
  SELECT c.id AS channelId, COALESCE(r.last_read_seq, 0) AS lastReadSeq,
    COUNT(m.id) AS unread,
    COUNT(CASE WHEN m.content LIKE '%<@' || @me || '>%' OR m.content LIKE '%@everyone%' THEN 1 END) AS mentions
  FROM channels c
  LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = @me
  LEFT JOIN messages m ON m.conversation_id = c.id AND m.rowid > COALESCE(r.last_read_seq, 0)
    AND m.sender_id != @me AND m.deleted = 0
  WHERE c.kind = 'text' AND (@channel IS NULL OR c.id = @channel)
  GROUP BY c.id
`);
export type ReadState = { channelId: string; lastReadSeq: number; unread: number; mentions: number };
export const readState = (userId: string, channelId: string | null = null) =>
  readsQuery.all({ me: userId, channel: channelId }) as ReadState[];

const markReadQuery = db.prepare(`
  INSERT INTO channel_reads (user_id, channel_id, last_read_seq) VALUES (?, ?, ?)
  ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)
`);

const MEMBER_COLUMNS = (db.pragma('table_info(users)') as { name: string }[]).map(column => column.name);
// People the Arabic class app removed stay out of the member list and the mention picker.
const membersQuery = db.prepare(`
  SELECT id, display_name AS displayName, avatar_color AS avatarColor, last_seen AS lastSeen FROM users
  ${MEMBER_COLUMNS.includes('removed_at') ? 'WHERE removed_at IS NULL' : ''}
  ORDER BY display_name COLLATE NOCASE
`);
export const members = () => membersQuery.all();

const liveMessage = db.prepare("SELECT conversation_id FROM messages WHERE id = ? AND deleted = 0");

// Reading, reacting and pinning, which every text channel shares.
export function registerChatEvents(io: Server, socket: Socket, userId: string) {
  socket.emit('members', { users: members() });
  socket.emit('read_state', { channels: readState(userId) });

  socket.on('mark_read', (data: { channelId: unknown; seq: unknown }) => {
    const channel = getChannel(data?.channelId);
    if (channel?.kind !== 'text' || !Number.isSafeInteger(data.seq) || (data.seq as number) < 0) return;
    const newest = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS seq FROM messages WHERE conversation_id = ?').get(channel.id) as { seq: number };
    markReadQuery.run(userId, channel.id, Math.min(data.seq as number, newest.seq));
    // Every device of this person clears the channel, not only the one that read it.
    io.to(`user:${userId}`).emit('read_state', { channels: readState(userId, channel.id) });
  });

  socket.on('react', (data: { messageId: unknown; emoji: unknown; on: unknown }) => {
    if (typeof data?.messageId !== 'string' || typeof data.emoji !== 'string' || typeof data.on !== 'boolean') return;
    if (!REACTION_EMOJIS.includes(data.emoji) || !liveMessage.get(data.messageId)) return;
    if (data.on) {
      db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
        .run(data.messageId, userId, data.emoji, Date.now());
    } else {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(data.messageId, userId, data.emoji);
    }
    io.to('everyone').emit('reactions', { messageId: data.messageId, reactions: reactionsOf(data.messageId) });
  });

  // Anyone can pin, as everyone can do everything on this server.
  socket.on('pin_message', (data: { messageId: unknown; pinned: unknown }, callback?: unknown) => {
    const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
    if (typeof data?.messageId !== 'string' || typeof data.pinned !== 'boolean') return reply({ error: 'Invalid message' });
    const message = liveMessage.get(data.messageId) as { conversation_id: string } | undefined;
    if (!message) return reply({ error: 'Invalid message' });
    if (data.pinned) {
      const pins = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND pinned_at IS NOT NULL AND deleted = 0').get(message.conversation_id) as { count: number };
      if (pins.count >= MAX_PINS_PER_CHANNEL) return reply({ error: 'Too many pins' });
    }
    const pinnedAt = data.pinned ? Date.now() : null;
    db.prepare('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(pinnedAt, data.pinned ? userId : null, data.messageId);
    io.to('everyone').emit('message_pinned', { messageId: data.messageId, conversationId: message.conversation_id, pinnedAt });
    reply({ ok: true });
  });
}

export function pinnedMessages(channelId: string) {
  return (db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.pinned_at IS NOT NULL AND m.deleted = 0 ORDER BY m.pinned_at DESC`)
    .all(channelId) as any[]).map(toMessage);
}

// Newest matches first. The words are compared without vowel marks, so a search typed without
// them still finds a fully voweled message.
export function searchMessages(query: string, channelId: string | null) {
  const needle = searchText(query).trim();
  if (!needle) return [];
  return (db.prepare(`
    ${MESSAGE_SELECT}
    JOIN channels c ON c.id = m.conversation_id
    WHERE m.deleted = 0 AND m.type != 'system' AND (@channel IS NULL OR m.conversation_id = @channel)
      AND (instr(search_text(m.content), @needle) > 0 OR instr(search_text(m.file_name), @needle) > 0)
    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 40
  `).all({ channel: channelId, needle }) as any[]).map(toMessage);
}
