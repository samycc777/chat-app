import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { DATA_DIR, UPLOADS_DIR } from './config';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'chat.db'));

db.pragma('journal_mode = WAL');
// The daily backup and a request can touch the database at the same moment; waiting a little is
// better than failing the request with "database is locked".
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// Copies of the database sit next to it in backups/, so a bad change or a broken disk write can be
// undone by hand. Routine copies (at every start and once a day) keep the newest few; the copy made
// just before the schema changes is kept until someone removes it, because it is the only way back.
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const KEPT_ROUTINE_BACKUPS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function backupDatabase(reason: string): string {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUPS_DIR, `chat-${stamp}-${reason}.db`);
  // VACUUM INTO writes a complete, compact copy that is consistent even while the server is running.
  db.prepare('VACUUM INTO ?').run(file);
  const routine = fs.readdirSync(BACKUPS_DIR).filter(name => /^chat-.*-(startup|daily)\.db$/.test(name)).sort();
  for (const old of routine.slice(0, -KEPT_ROUTINE_BACKUPS)) fs.rmSync(path.join(BACKUPS_DIR, old), { force: true });
  console.log(`Database backed up to ${file}`);
  return file;
}

const hasData = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get());

// The schema changes in numbered steps. The number of the last step applied is kept in the
// database itself (PRAGMA user_version), so each step runs exactly once, in order, on every copy of
// the database however old it is. Step 1 is the part of the schema still in use as it grew before
// the steps were numbered: it checks for each piece before adding it, so it also brings up to date
// a database that already has some of it (or, on the class's server, the class app's own database).
const oldChatFiles = new Set<string>();
const migrations: (() => void)[] = [
  function baseline() {
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
    `);
    const userColumns = db.pragma('table_info(users)') as { name: string }[];
    // Each person is recognised by the identity their browser or app keeps (see auth.ts).
    if (!userColumns.some(column => column.name === 'visitor_id')) db.exec('ALTER TABLE users ADD COLUMN visitor_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_visitor_id ON users(visitor_id)');
    // Which notifications a person wants: 'all', 'mentions' (now calls only, like 'all') or 'off'.
    if (!userColumns.some(column => column.name === 'notify_level')) {
      db.exec("ALTER TABLE users ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'all'");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text', 'voice')),
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL
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

      -- Each customer has a room of their own, with its own invite key and its own call. The room
      -- this server started with (the friends' and the class's) is not a row here: it is the home
      -- room, whose key stays in the deployment settings, and its channel has no room_id.
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        invite_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      -- Who has joined each room, so notifications stay inside it. The home room's ID is 'home'.
      CREATE TABLE IF NOT EXISTS room_members (
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

      -- Everyone's own picture, small enough to keep in the database beside them. Its ID is its
      -- address (see avatars.ts), so a new picture gets a new row.
      CREATE TABLE IF NOT EXISTS avatars (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const channelColumns = db.pragma('table_info(channels)') as { name: string }[];
    if (!channelColumns.some(column => column.name === 'room_id')) {
      db.exec('ALTER TABLE channels ADD COLUMN room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE');
    }
    // A new server starts with the home room's call.
    if (!db.prepare("SELECT 1 FROM channels WHERE kind = 'voice' AND room_id IS NULL").get()) {
      db.prepare("INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, 'General', 'voice', 1, ?)").run(uuid(), Date.now());
    }
    // Everyone who joined before rooms existed joined the home room. Only once: later people may
    // have joined other rooms only.
    if (!db.prepare("SELECT 1 FROM app_settings WHERE key = 'room_members_started'").get()) {
      db.prepare("INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) SELECT 'home', id, ? FROM users").run(Date.now());
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('room_members_started', '1')").run();
    }
  },

  // The app shows only the call, so the text channels, their messages, files, reactions, pins,
  // read markers and recordings, kept unused since, are removed for good: nobody can see them,
  // and keeping people's old messages without a way to read or delete them is not fair to them.
  // The files themselves are deleted after this step (see removeOldChatFiles). People, their
  // pictures, rooms and each room's call stay.
  function removeTextChat() {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    if (tables.has('attachments')) {
      for (const { disk_name } of db.prepare('SELECT disk_name FROM attachments').all() as { disk_name: string }[]) oldChatFiles.add(disk_name);
    }
    if (tables.has('recordings')) {
      for (const { disk_name } of db.prepare('SELECT disk_name FROM recordings').all() as { disk_name: string }[]) oldChatFiles.add(disk_name);
    }
    if (tables.has('messages')) {
      // Files from before attachments existed are named only in their message.
      const legacy = db.prepare("SELECT file_url FROM messages WHERE file_url LIKE '/uploads/%'").all() as { file_url: string }[];
      for (const { file_url } of legacy) oldChatFiles.add(file_url.slice('/uploads/'.length));
    }
    // Tables that point at others go first, so nothing is left pointing at a removed row.
    for (const table of ['message_reactions', 'message_reads', 'channel_reads', 'recordings', 'attachments', 'messages', 'conversation_members', 'conversations']) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DELETE FROM channels WHERE kind = 'text'");
    db.exec("DELETE FROM app_settings WHERE key = 'reads_started'");
  },

  // Every session is a row, so signing out ends it on the server too, rather than only forgetting
  // it on the device (see auth.ts). Sessions opened before this step have no row and stay valid
  // until their month is up.
  function addSessions() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room_id);
    `);
  },
];

const version = db.pragma('user_version', { simple: true }) as number;
if (version > migrations.length) {
  throw new Error(`chat.db is at schema version ${version}, newer than this server knows (${migrations.length}); deploy the newer server`);
}
if (hasData) {
  // A failed copy before a schema change stops the start: the change may remove data for good.
  if (version < migrations.length) backupDatabase(`before-v${migrations.length}`);
  else {
    try { backupDatabase('startup'); } catch (error) { console.error('Could not back up the database at start:', error); }
  }
}
for (let step = version; step < migrations.length; step++) {
  db.transaction(() => {
    migrations[step]();
    db.pragma(`user_version = ${step + 1}`);
  })();
  if (hasData) console.log(`Database schema moved to version ${step + 1}`);
}

// Deleted only once the step that forgets them is saved, so a failed step leaves every file there.
function removeOldChatFiles() {
  let removed = 0;
  for (const name of oldChatFiles) {
    // Names come from old rows; anything that is not a plain file name in the folder is skipped.
    if (!name || path.basename(name) !== name) continue;
    try {
      fs.rmSync(path.join(UPLOADS_DIR, name), { force: true });
      removed++;
    } catch (error) {
      console.error(`Could not delete the old chat file ${name}:`, error);
    }
  }
  if (oldChatFiles.size) console.log(`Deleted ${removed} old chat files`);
  oldChatFiles.clear();
}
removeOldChatFiles();

const dailyBackups = setInterval(() => {
  try { backupDatabase('daily'); } catch (error) { console.error('Daily database backup failed:', error); }
}, DAY_MS);
// The timer alone must not keep the process (or a test run) alive.
dailyBackups.unref();

// On shutdown, everything still in the write-ahead log goes into the database file itself, so the
// file is complete on its own (for a copy, or a new server version opening it).
export function closeDatabase() {
  clearInterval(dailyBackups);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

export default db;
