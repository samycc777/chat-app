import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';

const production = process.env.NODE_ENV === 'production';
if (production && !process.env.DATA_DIR) throw new Error('DATA_DIR must point to persistent storage in production');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'chat.db'));

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
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf')),
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

export const CLASSROOM_ID = 'classroom';
const classroomExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(CLASSROOM_ID);
if (!classroomExists) {
  db.prepare("INSERT INTO conversations (id, type, name) VALUES (?, 'group', 'Classroom')").run(CLASSROOM_ID);
}

// Apply additive schema changes to databases created before attachment IDs existed.
const messageColumns = db.pragma('table_info(messages)') as { name: string }[];
if (!messageColumns.some(column => column.name === 'attachment_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN attachment_id TEXT');
}

// Safely adopt old locally stored chat uploads into the private attachment table.
const uploadsDir = path.join(dataDir, 'uploads');
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

export default db;
