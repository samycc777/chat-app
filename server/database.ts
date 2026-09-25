import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { DATA_DIR, UPLOADS_DIR } from './config';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'chat.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#6366f1',
    status TEXT DEFAULT 'Hey there! I am using ChatApp',
    last_seen INTEGER DEFAULT (strftime('%s','now') * 1000),
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
    name TEXT,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    content TEXT,
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'image', 'file', 'system')),
    file_url TEXT,
    file_name TEXT,
    attachment_id TEXT,
    reply_to TEXT REFERENCES messages(id),
    edited_at INTEGER,
    deleted INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS message_reads (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    read_at INTEGER DEFAULT (strftime('%s','now') * 1000),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_message_reads_user ON message_reads(user_id);
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    disk_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
`);

const userColumns = db.pragma('table_info(users)') as { name: string }[];
if (!userColumns.some(column => column.name === 'visitor_id')) {
  db.exec('ALTER TABLE users ADD COLUMN visitor_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_visitor_id ON users(visitor_id)');
}

// A text channel is also a row in conversations, so its messages and files keep their existing
// tables and are removed with it; a voice channel has no messages and exists only here.
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('text', 'voice')),
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// Hangout replaced the Arabic class app on the class's own server, where the whole class chat was
// one conversation with this ID. That chat becomes #general, so every message, reply and file stays
// where it is, and each person is still recognised by their browser's visitor ID.
const CLASS_CHAT_ID = 'classroom';
if (!db.prepare('SELECT 1 FROM channels LIMIT 1').get()) {
  const now = Date.now();
  const classChat = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(CLASS_CHAT_ID);
  const general = classChat ? CLASS_CHAT_ID : uuid();
  if (classChat) db.prepare("UPDATE conversations SET name = 'general' WHERE id = ?").run(general);
  else db.prepare("INSERT INTO conversations (id, type, name) VALUES (?, 'group', ?)").run(general, 'general');
  const addChannel = db.prepare('INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, ?, ?, ?, ?)');
  addChannel.run(general, 'general', 'text', 0, now);
  addChannel.run(uuid(), 'General', 'voice', 1, now);
}

// Apply additive schema changes to databases created before attachment IDs existed.
const messageColumns = db.pragma('table_info(messages)') as { name: string }[];
if (!messageColumns.some(column => column.name === 'attachment_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN attachment_id TEXT');
}

// Safely adopt old locally stored chat uploads into the private attachment table.
const uploadsDir = UPLOADS_DIR;
if (fs.existsSync(uploadsDir)) {
  const legacyMessages = db.prepare("SELECT id, conversation_id, sender_id, file_url, file_name FROM messages WHERE attachment_id IS NULL AND file_url LIKE '/uploads/%'").all() as any[];
  const addAttachment = db.prepare('INSERT INTO attachments (id, conversation_id, uploader_id, disk_name, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const connectMessage = db.prepare('UPDATE messages SET attachment_id = ? WHERE id = ?');
  for (const message of legacyMessages) {
    const diskName = path.basename(String(message.file_url).slice('/uploads/'.length));
    if (diskName !== String(message.file_url).slice('/uploads/'.length) || !/^[a-f0-9-]+\.(?:jpe?g|png|gif|webp|pdf)$/i.test(diskName)) continue;
    const diskPath = path.join(uploadsDir, diskName);
    if (!fs.existsSync(diskPath)) continue;
    const bytes = fs.readFileSync(diskPath);
    const mime = bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf'
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
      : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ? 'image/gif'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp'
      : null;
    if (!mime) continue;
    const attachmentId = uuid();
    const createdAt = Date.now();
    addAttachment.run(attachmentId, message.conversation_id, message.sender_id, diskName,
      String(message.file_name || diskName).slice(0, 180), mime, bytes.length, createdAt);
    connectMessage.run(attachmentId, message.id);
  }
}

// Voice messages and lesson recordings are sound and video files, which the original attachments
// table refused by name. SQLite cannot change a CHECK, so the table is rebuilt once without it; the
// upload route decides what may be stored instead.
const attachmentsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get() as { sql: string }).sql;
if (attachmentsSql.includes('CHECK(mime_type')) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE attachments_new (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES users(id),
        disk_name TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO attachments_new SELECT id, conversation_id, uploader_id, disk_name, original_name, mime_type, size, created_at FROM attachments;
      DROP TABLE attachments;
      ALTER TABLE attachments_new RENAME TO attachments;
      CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
    `);
  })();
}
const attachmentColumns = db.pragma('table_info(attachments)') as { name: string }[];
// Recorded sound often has no length in its own header, so the recorder's measurement is kept.
if (!attachmentColumns.some(column => column.name === 'duration_ms')) {
  db.exec('ALTER TABLE attachments ADD COLUMN duration_ms INTEGER');
}

// Pinned messages stay on the message itself, so a deleted message leaves the pins with it.
if (!messageColumns.some(column => column.name === 'pinned_at')) {
  db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER');
  db.exec('ALTER TABLE messages ADD COLUMN pinned_by TEXT REFERENCES users(id)');
}

// How much of each channel a person has read, kept on the server so every device agrees. The
// position is a message's row number, which is its order of arrival.
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_reads (
    user_id TEXT NOT NULL REFERENCES users(id),
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_seq INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  -- One row per device that asked for notifications: a browser's Web Push subscription, or an
  -- Android (Firebase) or iPhone (Apple) app's device token.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK(kind IN ('web', 'fcm', 'apns')),
    endpoint TEXT NOT NULL UNIQUE,
    keys TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

  -- Values the server makes for itself once and keeps, such as its Web Push keys.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Which notifications a person wants: 'all', 'mentions' (mentions and calls only) or 'off'.
const userColumnsNow = db.pragma('table_info(users)') as { name: string }[];
if (!userColumnsNow.some(column => column.name === 'notify_level')) {
  db.exec("ALTER TABLE users ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'all'");
}

// Unread markers arrived after people had been chatting for months. Everything already sent counts
// as read, once, so nobody opens the app to thousands of old messages marked new.
if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'reads_started'").get()) {
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO channel_reads (user_id, channel_id, last_read_seq)
      SELECT u.id, c.id, (SELECT COALESCE(MAX(m.rowid), 0) FROM messages m WHERE m.conversation_id = c.id)
      FROM users u, channels c WHERE c.kind = 'text'
    `);
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('reads_started', '1')").run();
  })();
}

// Search ignores vowel marks, the stretching line and the different ways of writing alif, yaa and
// taa marbuta, so كتاب finds كِتَابٌ.
export function searchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0629/g, '\u0647');
}
db.function('search_text', { deterministic: true }, searchText);

export default db;
