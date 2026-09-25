import db from './database';

// Every place that sends messages to the app builds them here, so history, live messages and
// search results always have the same shape.
const MESSAGE_COLUMNS = `
  m.rowid AS seq, m.id, m.conversation_id, m.sender_id, m.content, m.type, m.file_name, m.attachment_id,
  m.reply_to, m.edited_at, m.deleted, m.created_at, m.pinned_at,
  u.username AS sender_username, u.display_name AS sender_display_name, u.avatar_color AS sender_avatar_color,
  a.mime_type AS attachment_mime, a.duration_ms AS attachment_duration
`;
export const MESSAGE_FROM = `
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN attachments a ON a.id = m.attachment_id
`;
export const MESSAGE_SELECT = `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}`;

const replyQuery = db.prepare(
  `SELECT m.id, m.content, m.type, m.deleted, m.sender_id, u.display_name AS sender_display_name
   FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
);

export function replySummary(replyTo: string) {
  const replied = replyQuery.get(replyTo) as any;
  return replied ? {
    id: replied.id, content: replied.deleted ? null : replied.content, type: replied.type, deleted: !!replied.deleted,
    senderId: replied.sender_id, senderDisplayName: replied.sender_display_name,
  } : null;
}

export function toMessage(m: any) {
  const deleted = !!m.deleted;
  return {
    id: m.id, seq: m.seq, conversationId: m.conversation_id, senderId: m.sender_id,
    content: deleted ? null : m.content, type: m.type,
    fileUrl: null, attachmentId: deleted ? null : m.attachment_id, fileName: deleted ? null : m.file_name,
    mimeType: deleted ? null : m.attachment_mime ?? null, durationMs: deleted ? null : m.attachment_duration ?? null,
    replyTo: m.reply_to ? replySummary(m.reply_to) : null, editedAt: m.edited_at, deleted, createdAt: m.created_at,
    pinnedAt: deleted ? null : m.pinned_at ?? null,
    sender: { username: m.sender_username, displayName: m.sender_display_name, avatarColor: m.sender_avatar_color },
  };
}

const byIdQuery = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`);
export function messageById(id: string) {
  const row = byIdQuery.get(id);
  return row ? toMessage(row) : null;
}

// A mention is written into the message as <@userId>, so it survives the person changing their
// name; @everyone reaches the whole server.
const MENTION = /<@([0-9a-f-]{36})>/gi;
export const EVERYONE_MENTION = '@everyone';

export function mentionedUserIds(content: string | null | undefined): string[] {
  if (!content) return [];
  return [...new Set([...content.matchAll(MENTION)].map(match => match[1].toLowerCase()))];
}

export function mentionsEveryone(content: string | null | undefined) {
  return !!content && /(^|\s)@everyone\b/i.test(content);
}

const nameQuery = db.prepare('SELECT display_name FROM users WHERE id = ?');
// Shows mentions as @Name, for places that display plain text such as notifications.
export function plainText(content: string | null | undefined) {
  if (!content) return '';
  return content.replace(MENTION, (_match, userId: string) => {
    const user = nameQuery.get(userId) as { display_name: string } | undefined;
    return `@${user?.display_name ?? '?'}`;
  });
}
