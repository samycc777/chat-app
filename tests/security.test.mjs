import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromClient = createRequire(path.join(root, 'client', 'package.json'));
const { io } = requireFromClient('socket.io-client');
let tempDir;
let appServer;
let baseUrl;
let db;
const sockets = [];

// Stands in for LiveKit's server API: records every call and reports configured room participants.
const liveKit = { server: null, calls: [], participants: new Map() };
function startFakeLiveKit() {
  liveKit.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const data = body ? JSON.parse(body) : {};
      liveKit.calls.push({ method, data });
      res.setHeader('Content-Type', 'application/json');
      if (method === 'ListParticipants') res.end(JSON.stringify({ participants: liveKit.participants.get(data.room) ?? [] }));
      else if (method === 'MutePublishedTrack') res.end(JSON.stringify({ track: { sid: data.trackSid, muted: data.muted } }));
      else res.end('{}');
    });
  });
  return new Promise(resolve => liveKit.server.listen(0, '127.0.0.1', resolve));
}
const liveKitCalls = method => liveKit.calls.filter(call => call.method === method);
async function withoutLiveKit(run) {
  const saved = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  try { return await run(); } finally { Object.assign(process.env, saved); }
}
// Stands in for a browser's push service: keeps every notification sent to each subscription,
// decrypted the way the browser would, and answers 410 Gone for subscriptions that have ended.
const pushService = { server: null, received: [], gone: new Set() };
function startFakePushService() {
  pushService.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const name = req.url.split('/').pop();
      pushService.received.push({ name, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = pushService.gone.has(name) ? 410 : 201;
      res.end();
    });
  });
  return new Promise(resolve => pushService.server.listen(0, '127.0.0.1', resolve));
}
// A browser's side of a subscription: its own P-256 key pair and a shared secret.
function browserSubscription(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const endpoint = `http://127.0.0.1:${pushService.server.address().port}/push/${name}`;
  return { ecdh, auth, endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
// Decrypts an aes128gcm Web Push message (RFC 8291) with the browser's keys.
function decryptPush(subscription, body) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const serverKey = body.subarray(21, 21 + idLength);
  const cipherText = body.subarray(21 + idLength);
  const hkdf = (ikm, hkdfSalt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, hkdfSalt, info, length));
  const shared = subscription.ecdh.computeSecret(serverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscription.ecdh.getPublicKey(), serverKey]);
  const ikm = hkdf(shared, subscription.auth, keyInfo, 32);
  const key = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(cipherText.subarray(-16));
  const padded = Buffer.concat([decipher.update(cipherText.subarray(0, -16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8'));
}
const pushesTo = subscription => pushService.received
  .filter(entry => entry.name === subscription.endpoint.split('/').pop())
  .map(entry => decryptPush(subscription, entry.body));
async function subscribe(token, subscription, extra = {}) {
  return fetch(`${baseUrl}/api/push/subscribe`, {
    method: 'POST', headers: jsonAuth(token), body: JSON.stringify({ kind: 'web', endpoint: subscription.endpoint, keys: subscription.keys, ...extra }),
  });
}
const setLevel = (token, level) => fetch(`${baseUrl}/api/push/level`, { method: 'PUT', headers: jsonAuth(token), body: JSON.stringify({ level }) });

async function eventually(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

let visitorSequence = 1;
function nextVisitorId() {
  return `00000000-0000-4000-8000-${String(visitorSequence++).padStart(12, '0')}`;
}
function joinRequest(body) {
  return fetch(`${baseUrl}/api/auth/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function join(displayName, inviteKey = '0000') {
  const response = await joinRequest({ inviteKey, visitorId: nextVisitorId(), displayName });
  assert.equal(response.status, 200);
  return response.json();
}
const auth = token => ({ Authorization: `Bearer ${token}` });
const jsonAuth = token => ({ ...auth(token), 'Content-Type': 'application/json' });
const firstChannel = kind => db.prepare('SELECT id FROM channels WHERE kind = ? ORDER BY position LIMIT 1').get(kind).id;
const callToken = (token, channelId) => fetch(`${baseUrl}/api/livekit/token`, {
  method: 'POST', headers: jsonAuth(token), body: JSON.stringify({ channelId }),
});
const screenToken = (token, channelId) => fetch(`${baseUrl}/api/livekit/screen-token`, {
  method: 'POST', headers: jsonAuth(token), body: JSON.stringify({ channelId }),
});
const emitWithAck = (socket, event, data) => new Promise(resolve => socket.emit(event, data, resolve));
const nextEvent = (socket, event) => new Promise(resolve => socket.once(event, resolve));
// Resolves with the first event that passes the check, skipping updates that were already on their way.
const eventWhere = (socket, event, check) => new Promise(resolve => {
  function heard(data) { if (check(data)) { socket.off(event, heard); resolve(data); } }
  socket.on(event, heard);
});
const membersIn = (state, channelId) => state.calls.find(call => call.channelId === channelId)?.members.map(member => member.displayName) ?? [];
const quietFor = (socket, event, ms = 150) => new Promise(resolve => {
  const timer = setTimeout(() => { socket.off(event, heard); resolve(true); }, ms);
  function heard() { clearTimeout(timer); resolve(false); }
  socket.once(event, heard);
});

async function connect(token) {
  const socket = io(baseUrl, { auth: { token }, transports: ['websocket'] });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangout-security-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = 'test-only-signing-secret-that-is-long-enough';
  // The site's address signs its Web Push notifications.
  process.env.ALLOWED_ORIGINS = 'https://majlis.test';
  await startFakeLiveKit();
  await startFakePushService();
  Object.assign(process.env, {
    LIVEKIT_URL: `ws://127.0.0.1:${liveKit.server.address().port}`, LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret',
  });
  const serverModule = await import('../server/index.ts');
  appServer = serverModule.server;
  await new Promise(resolve => appServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
  ({ default: db } = await import('../server/database.ts'));
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  if (appServer?.listening) await new Promise(resolve => appServer.close(resolve));
  if (liveKit.server?.listening) await new Promise(resolve => liveKit.server.close(resolve));
  if (pushService.server?.listening) await new Promise(resolve => pushService.server.close(resolve));
  db?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});


test('everyone can read and post in text channels, see files, and nobody gets into unknown channels', async () => {
  const general = firstChannel('text');
  const alice = await join('Alice');
  const bob = await join('Bob');
  const form = new FormData();
  form.append('conversationId', general);
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F+4AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'tiny.png');
  const uploaded = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(alice.token), body: form });
  assert.equal(uploaded.status, 200);
  const { attachmentId } = await uploaded.json();
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth(bob.token) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth('invalid') })).status, 401);
  assert.equal((await fetch(`${baseUrl}/uploads/${attachmentId}`, { headers: auth('invalid') })).status, 404);

  const [aliceSocket, bobSocket] = await Promise.all([connect(alice.token), connect(bob.token)]);
  const bobHears = nextEvent(bobSocket, 'new_message');
  const ack = await emitWithAck(aliceSocket, 'send_message', { conversationId: general, content: 'hello', type: 'text' });
  assert.ok(ack.id);
  const heard = await bobHears;
  assert.equal(heard.content, 'hello');
  assert.equal(heard.conversationId, general);
  assert.equal(heard.sender.role, undefined);
  assert.deepEqual(await emitWithAck(aliceSocket, 'send_message', { conversationId: 'nowhere', content: 'x', type: 'text' }), { error: 'Unknown channel' });
  assert.equal((await fetch(`${baseUrl}/api/conversations/nowhere/messages`, { headers: auth(alice.token) })).status, 404);
  const voice = firstChannel('voice');
  assert.equal((await fetch(`${baseUrl}/api/conversations/${voice}/messages`, { headers: auth(alice.token) })).status, 404);
});

test('sound and video can be shared, with their type and length, while other files are refused', async () => {
  const general = firstChannel('text');
  const dana = await join('Dana');
  const upload = async (bytes, type, name, durationMs) => {
    const form = new FormData();
    form.append('conversationId', general);
    if (durationMs !== undefined) form.append('durationMs', String(durationMs));
    form.append('file', new Blob([bytes], { type }), name);
    return fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(dana.token), body: form });
  };
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);
  const voice = await upload(webm, 'audio/webm;codecs=opus', 'voice.webm', 4200);
  assert.equal(voice.status, 200);
  const voiceResult = await voice.json();
  assert.deepEqual([voiceResult.type, voiceResult.mimeType, voiceResult.durationMs], ['file', 'audio/webm', 4200]);
  const video = await (await upload(webm, 'video/webm', 'lesson.webm', 'nonsense')).json();
  assert.deepEqual([video.mimeType, video.durationMs], ['video/webm', null]);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(40)]);
  assert.equal((await (await upload(mp4, 'audio/mp4', 'voice.m4a', 1000)).json()).mimeType, 'audio/mp4');
  assert.equal((await upload(Buffer.from('#!/bin/sh\necho hi'), 'audio/webm', 'trick.webm')).status, 415);

  const socket = await connect(dana.token);
  const heard = nextEvent(socket, 'new_message');
  await emitWithAck(socket, 'send_message', { conversationId: general, type: 'file', attachmentId: voiceResult.attachmentId });
  const message = await heard;
  assert.deepEqual([message.mimeType, message.durationMs], ['audio/webm', 4200]);
  const history = await (await fetch(`${baseUrl}/api/conversations/${general}/messages`, { headers: auth(dana.token) })).json();
  assert.equal(history.find(entry => entry.id === message.id).mimeType, 'audio/webm');
});

test('unread counts and mentions follow each person across devices, and newcomers start with nothing unread', async () => {
  const general = firstChannel('text');
  const writer = await join('Unread writer');
  const reader = await join('Unread reader');
  const writerSocket = await connect(writer.token);
  const readerState = s => s.channels.find(channel => channel.channelId === general);
  const phone = await connect(reader.token);
  const laptopFirst = new Promise(resolve => {
    const socket = io(baseUrl, { auth: { token: reader.token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.once('read_state', state => resolve({ socket, state }));
  });
  const { socket: laptop, state: initial } = await laptopFirst;
  assert.deepEqual([readerState(initial).unread, readerState(initial).mentions], [0, 0]);

  await emitWithAck(writerSocket, 'send_message', { conversationId: general, content: 'first', type: 'text' });
  await emitWithAck(writerSocket, 'send_message', { conversationId: general, content: `hi <@${reader.user.id}>`, type: 'text' });
  const last = await emitWithAck(writerSocket, 'send_message', { conversationId: general, content: '@everyone class now', type: 'text' });
  const fresh = new Promise(resolve => {
    const socket = io(baseUrl, { auth: { token: reader.token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.once('read_state', resolve);
  });
  const counted = readerState(await fresh);
  assert.deepEqual([counted.unread, counted.mentions], [3, 2]);

  // Reading on the phone clears the channel on the laptop too.
  const seq = db.prepare('SELECT rowid AS seq FROM messages WHERE id = ?').get(last.id).seq;
  const laptopHears = eventWhere(laptop, 'read_state', state => readerState(state)?.unread === 0);
  phone.emit('mark_read', { channelId: general, seq });
  const cleared = readerState(await laptopHears);
  assert.deepEqual([cleared.unread, cleared.mentions, cleared.lastReadSeq], [0, 0, seq]);
  // A read position can't go backwards or past the newest message.
  phone.emit('mark_read', { channelId: general, seq: 1 });
  phone.emit('mark_read', { channelId: general, seq: seq + 1000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(db.prepare('SELECT last_read_seq FROM channel_reads WHERE user_id = ? AND channel_id = ?').get(reader.user.id, general).last_read_seq, seq);

  // Someone who joins later doesn't see the history as unread.
  const newcomer = await join('Unread newcomer');
  const newcomerState = await new Promise(resolve => {
    const socket = io(baseUrl, { auth: { token: newcomer.token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.once('read_state', resolve);
  });
  assert.equal(readerState(newcomerState).unread, 0);
});

test('everyone can react with the few allowed emoji and pin messages, and search ignores vowel marks', async () => {
  const general = firstChannel('text');
  const erin = await join('Erin');
  const frank = await join('Frank');
  const [erinSocket, frankSocket] = await Promise.all([connect(erin.token), connect(frank.token)]);
  const sent = await emitWithAck(erinSocket, 'send_message', { conversationId: general, content: 'قَالَ رَسُولُ اللَّهِ ﷺ: إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ', type: 'text' });

  const reacted = eventWhere(erinSocket, 'reactions', data => data.messageId === sent.id && data.reactions.length > 0);
  frankSocket.emit('react', { messageId: sent.id, emoji: '🤲', on: true });
  assert.deepEqual((await reacted).reactions, [{ emoji: '🤲', userIds: [frank.user.id] }]);
  frankSocket.emit('react', { messageId: sent.id, emoji: '😂', on: true });
  const removed = eventWhere(erinSocket, 'reactions', data => data.messageId === sent.id && data.reactions.length === 0);
  frankSocket.emit('react', { messageId: sent.id, emoji: '🤲', on: false });
  await removed;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?').get(sent.id).n, 0);

  const pinned = eventWhere(erinSocket, 'message_pinned', data => data.messageId === sent.id);
  assert.deepEqual(await emitWithAck(frankSocket, 'pin_message', { messageId: sent.id, pinned: true }), { ok: true });
  assert.ok((await pinned).pinnedAt);
  const pins = await (await fetch(`${baseUrl}/api/conversations/${general}/pins`, { headers: auth(erin.token) })).json();
  assert.equal(pins[0].id, sent.id);
  assert.deepEqual(await emitWithAck(frankSocket, 'pin_message', { messageId: 'nope', pinned: true }), { error: 'Invalid message' });

  const search = async q => (await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(q)}`, { headers: auth(erin.token) })).json();
  assert.ok((await search('الاعمال بالنيات')).some(message => message.id === sent.id));
  assert.equal((await search('nothing-like-this-anywhere')).length, 0);
  assert.equal((await fetch(`${baseUrl}/api/search?q=a`, { headers: auth(erin.token) })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/search?q=hello`, { headers: auth('invalid') })).status, 401);

  // Deleting the message takes its pin with it.
  erinSocket.emit('delete_message', { messageId: sent.id });
  await nextEvent(frankSocket, 'message_deleted');
  const after = await (await fetch(`${baseUrl}/api/conversations/${general}/pins`, { headers: auth(erin.token) })).json();
  assert.ok(!after.some(message => message.id === sent.id));
});

test('history can be opened around an old message and read forwards from there', async () => {
  const general = firstChannel('text');
  const reader = await join('Around reader');
  const insert = db.prepare("INSERT INTO messages (id, conversation_id, sender_id, content, type, created_at) VALUES (?, ?, ?, ?, 'text', ?)");
  const ids = Array.from({ length: 30 }, (_, index) => `aaaaaaaa-0000-4000-9000-${String(index).padStart(12, '0')}`);
  // Dated in the past so they stay out of other tests' latest page.
  ids.forEach((id, index) => insert.run(id, general, reader.user.id, `old ${index}`, 915_148_800_000 + index));
  const get = async query => (await fetch(`${baseUrl}/api/conversations/${general}/messages?${query}`, { headers: auth(reader.token) })).json();
  const around = await get(`around=${ids[15]}&limit=10`);
  assert.deepEqual(around.map(message => message.content), ['old 10', 'old 11', 'old 12', 'old 13', 'old 14', 'old 15', 'old 16', 'old 17', 'old 18', 'old 19']);
  const later = await get(`after=${915_148_800_019}&afterId=${ids[19]}&limit=3`);
  assert.deepEqual(later.map(message => message.content), ['old 20', 'old 21', 'old 22']);
  assert.equal((await fetch(`${baseUrl}/api/conversations/${general}/messages?around=00000000-0000-4000-9000-999999999999`, { headers: auth(reader.token) })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/conversations/${general}/messages?after=soon`, { headers: auth(reader.token) })).status, 400);
});

test('a connecting client learns every member with when they were last seen', async () => {
  const gone = await join('Gone for now');
  const goneSocket = await connect(gone.token);
  goneSocket.disconnect();
  const viewer = await join('Member viewer');
  const heard = new Promise(resolve => {
    const socket = io(baseUrl, { auth: { token: viewer.token }, transports: ['websocket'] });
    sockets.push(socket);
    socket.once('members', resolve);
  });
  const { users } = await heard;
  const entry = users.find(user => user.id === gone.user.id);
  assert.equal(entry.displayName, 'Gone for now');
  assert.ok(entry.lastSeen > Date.now() - 60_000);
});

const recordingApi = (token, path, method = 'POST', body) => fetch(`${baseUrl}/api/recordings${path}`, {
  method, headers: jsonAuth(token), body: body === undefined ? undefined : JSON.stringify(body),
});
const sendPiece = (token, id, index, bytes) => fetch(`${baseUrl}/api/recordings/${id}/chunks/${index}`, {
  method: 'PUT', headers: { ...auth(token), 'Content-Type': 'application/octet-stream' }, body: bytes,
});
const webmStart = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('lesson start')]);
const recordingIn = (state, channelId) => state.calls.find(call => call.channelId === channelId)?.recording ?? null;
// Later tests expect the voice channel to start empty.
async function leaveCall(channelId, ...leaving) {
  for (const socket of leaving) socket.emit('voice_leave');
  const { getCall } = await import('../server/voice.ts');
  assert.ok(await eventually(() => !getCall(channelId)));
}

test('anyone in a call can record it, everyone sees it, and it is posted as a video in the chosen channel', async () => {
  const voice = firstChannel('voice');
  const general = firstChannel('text');
  const [teacher, student, outsider] = await Promise.all([join('Recording teacher'), join('Recording student'), join('Recording outsider')]);
  const [teacherSocket, studentSocket] = await Promise.all([connect(teacher.token), connect(student.token)]);

  // Only someone in the call can record it.
  assert.equal((await recordingApi(outsider.token, '', 'POST', { voiceChannelId: voice })).status, 409);
  assert.equal((await recordingApi(teacher.token, '', 'POST', { voiceChannelId: general })).status, 404);
  await emitWithAck(teacherSocket, 'voice_join', { channelId: voice });
  await emitWithAck(studentSocket, 'voice_join', { channelId: voice });

  const badgeSeen = eventWhere(studentSocket, 'voice_state', state => recordingIn(state, voice));
  const started = await recordingApi(teacher.token, '', 'POST', { voiceChannelId: voice });
  assert.equal(started.status, 200);
  const { id } = await started.json();
  const badge = recordingIn(await badgeSeen, voice);
  assert.equal(badge.displayName, 'Recording teacher');
  assert.equal(badge.userId, teacher.user.id);
  assert.equal(typeof badge.startedAt, 'number');
  // Someone joining later is told as well.
  const late = io(baseUrl, { auth: { token: (await join('Late student')).token }, transports: ['websocket'] });
  sockets.push(late);
  assert.equal(recordingIn(await nextEvent(late, 'voice_state'), voice).displayName, 'Recording teacher');

  // One recording per call at a time.
  const second = await recordingApi(student.token, '', 'POST', { voiceChannelId: voice });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'Already recording');

  // Pieces arrive in order and build one file; only the recorder may add to it.
  const first = webmStart();
  assert.equal((await sendPiece(teacher.token, id, 0, first)).status, 200);
  assert.equal((await sendPiece(student.token, id, 1, Buffer.from('intruder'))).status, 403);
  assert.equal((await sendPiece(teacher.token, id, 2, Buffer.from('skipped'))).status, 409);
  assert.equal((await sendPiece(teacher.token, id, 0, first)).status, 200, 'a piece sent twice is accepted once');
  assert.equal((await sendPiece(teacher.token, id, 1, Buffer.from(' and the rest'))).status, 200);
  const row = db.prepare('SELECT disk_name, size, mime_type FROM recordings WHERE id = ?').get(id);
  assert.equal(row.mime_type, 'video/webm');
  const expected = Buffer.concat([first, Buffer.from(' and the rest')]);
  assert.deepEqual(fs.readFileSync(path.join(tempDir, 'uploads', row.disk_name)), expected);

  // Finishing belongs to the recorder, and only into a text channel.
  assert.equal((await recordingApi(student.token, `/${id}/finish`, 'POST', { textChannelId: general, durationMs: 5000 })).status, 403);
  assert.equal((await recordingApi(teacher.token, `/${id}/finish`, 'POST', { textChannelId: voice, durationMs: 5000 })).status, 404);
  assert.equal((await recordingApi(teacher.token, `/${id}/finish`, 'POST', { textChannelId: 'nowhere', durationMs: 5000 })).status, 404);

  const badgeGone = eventWhere(studentSocket, 'voice_state', state => !recordingIn(state, voice));
  assert.equal((await recordingApi(teacher.token, `/${id}/stop`)).status, 200);
  await badgeGone;
  const posted = eventWhere(studentSocket, 'new_message', message => message.senderId === teacher.user.id && message.type === 'file');
  const finished = await recordingApi(teacher.token, `/${id}/finish`, 'POST', { textChannelId: general, durationMs: 5000, name: 'Recording of General – 26 Sep 2026.webm' });
  assert.equal(finished.status, 200);
  const { attachmentId } = await finished.json();
  const message = await posted;
  assert.equal(message.conversationId, general);
  assert.equal(message.attachmentId, attachmentId);
  assert.deepEqual([message.mimeType, message.durationMs, message.fileName], ['video/webm', 5000, 'Recording of General – 26 Sep 2026.webm']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recordings WHERE id = ?').get(id).n, 0);
  const download = await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth(student.token) });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), expected);
  await leaveCall(voice, teacherSocket, studentSocket);
});

// A tiny WebM laid out as a browser records it: no length, no index, clusters of unknown size.
const ebmlElement = (id, body) => {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length));
  size[0] = 0x01;
  return Buffer.concat([Buffer.from(id), size, body]);
};
function liveWebm() {
  const unknownSize = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const cluster = (timecode, key) => Buffer.concat([
    Buffer.from([0x1f, 0x43, 0xb6, 0x75]), unknownSize,
    Buffer.from([0xe7, 0x82, timecode >> 8, timecode & 0xff]),
    Buffer.from([0xa3, 0x88, 0x81, 0x00, 0x00, key ? 0x80 : 0x00, 1, 2, 3, 4]),
  ]);
  return Buffer.concat([
    ebmlElement([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x82, 0x84, ...Buffer.from('webm')])),
    Buffer.from([0x18, 0x53, 0x80, 0x67]), unknownSize,
    ebmlElement([0x15, 0x49, 0xa9, 0x66], Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])),
    ebmlElement([0x16, 0x54, 0xae, 0x6b], ebmlElement([0xae], Buffer.from([0xd7, 0x81, 0x01, 0x83, 0x81, 0x01]))),
    cluster(0, true), cluster(4000, false), cluster(8000, true),
  ]);
}

test('a posted recording is given its length and an index of its keyframes, so it can be skipped through', async () => {
  const voice = firstChannel('voice');
  const recorder = await join('Indexed recorder');
  const socket = await connect(recorder.token);
  await emitWithAck(socket, 'voice_join', { channelId: voice });
  const { id } = await (await recordingApi(recorder.token, '', 'POST', { voiceChannelId: voice })).json();
  const webm = liveWebm();
  assert.equal((await sendPiece(recorder.token, id, 0, webm.subarray(0, 60))).status, 200);
  assert.equal((await sendPiece(recorder.token, id, 1, webm.subarray(60))).status, 200);
  const { attachmentId } = await (await recordingApi(recorder.token, `/${id}/finish`, 'POST', { textChannelId: firstChannel('text'), durationMs: 9000 })).json();
  const file = Buffer.from(await (await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth(recorder.token) })).arrayBuffer());

  // The segment now has a size, the length is 9 seconds, and the index points at the two
  // clusters that start with a keyframe.
  const segment = file.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  const segmentData = segment + 12;
  assert.equal(Number(file.readBigUInt64BE(segment + 4) & 0x00ffffffffffffffn), file.length - segmentData);
  const duration = file.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  assert.equal(file.readDoubleBE(duration + 3), 9000);
  const cues = [];
  for (let at = file.indexOf(Buffer.from([0xbb, 0x99])); at !== -1; at = file.indexOf(Buffer.from([0xbb, 0x99]), at + 1)) {
    cues.push({ time: Number(file.readBigUInt64BE(at + 4)), position: Number(file.readBigUInt64BE(at + 19)) });
  }
  assert.deepEqual(cues.map(cue => cue.time), [0, 8000]);
  for (const cue of cues) assert.deepEqual([...file.subarray(segmentData + cue.position, segmentData + cue.position + 4)], [0x1f, 0x43, 0xb6, 0x75]);
  // Every picture is still there.
  assert.equal(file.subarray(segmentData).toString('latin1').split('\x01\x02\x03\x04').length - 1, 3);
  await leaveCall(voice, socket);
});

test('a recording ends when its recorder leaves, and can be discarded or posted for them once it goes quiet', async () => {
  const voice = firstChannel('voice');
  const general = firstChannel('text');
  const [recorder, watcher] = await Promise.all([join('Leaving recorder'), join('Recording watcher')]);
  const [recorderSocket, watcherSocket] = await Promise.all([connect(recorder.token), connect(watcher.token)]);
  await emitWithAck(recorderSocket, 'voice_join', { channelId: voice });
  await emitWithAck(watcherSocket, 'voice_join', { channelId: voice });

  const { id } = await (await recordingApi(recorder.token, '', 'POST', { voiceChannelId: voice })).json();
  assert.equal((await sendPiece(recorder.token, id, 0, Buffer.from('not a video at all'))).status, 415);
  assert.equal((await sendPiece(recorder.token, id, 0, webmStart())).status, 200);
  const diskName = db.prepare('SELECT disk_name FROM recordings WHERE id = ?').get(id).disk_name;
  const cleared = eventWhere(watcherSocket, 'voice_state', state => membersIn(state, voice).length === 1 && !recordingIn(state, voice));
  recorderSocket.emit('voice_leave');
  await cleared;
  // Someone else may start a new one now; back in the call, the first recorder cannot bring back a
  // badge that belongs to another recording.
  const { id: other } = await (await recordingApi(watcher.token, '', 'POST', { voiceChannelId: voice })).json();
  await emitWithAck(recorderSocket, 'voice_join', { channelId: voice });
  assert.equal((await recordingApi(recorder.token, `/${id}/resume`)).status, 409);

  // Discarding removes the file.
  assert.equal((await recordingApi(watcher.token, `/${id}`, 'DELETE')).status, 403);
  assert.equal((await recordingApi(recorder.token, `/${id}`, 'DELETE')).status, 200);
  assert.equal(fs.existsSync(path.join(tempDir, 'uploads', diskName)), false);
  assert.equal((await sendPiece(recorder.token, id, 1, Buffer.from('late'))).status, 404);

  // A recording that goes quiet, because the recorder's browser died, is posted in the first text channel.
  assert.equal((await sendPiece(watcher.token, other, 0, webmStart())).status, 200);
  const { sweepIdleRecordings, IDLE_RECORDING_MS } = await import('../server/recordings.ts');
  const posted = eventWhere(recorderSocket, 'new_message', message => message.senderId === watcher.user.id && message.type === 'file');
  sweepIdleRecordings(Date.now() + IDLE_RECORDING_MS + 1000);
  const message = await posted;
  assert.equal(message.conversationId, general);
  assert.equal(message.mimeType, 'video/webm');
  assert.match(message.fileName, /^Recording of .+\.webm$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recordings WHERE id = ?').get(other).n, 0);
  await leaveCall(voice, recorderSocket, watcherSocket);
});

test('a recording cannot grow past its size limit', async () => {
  const voice = firstChannel('voice');
  const recorder = await join('Big recorder');
  const socket = await connect(recorder.token);
  await emitWithAck(socket, 'voice_join', { channelId: voice });
  const { id } = await (await recordingApi(recorder.token, '', 'POST', { voiceChannelId: voice })).json();
  const previous = process.env.MAX_RECORDING_BYTES;
  process.env.MAX_RECORDING_BYTES = '40';
  try {
    assert.equal((await sendPiece(recorder.token, id, 0, webmStart())).status, 200);
    const refused = await sendPiece(recorder.token, id, 1, Buffer.alloc(30));
    assert.equal(refused.status, 413);
    assert.equal((await refused.json()).error, 'Recording too large');
    // What was already recorded is kept.
    assert.equal(db.prepare('SELECT size FROM recordings WHERE id = ?').get(id).size, webmStart().length);
  } finally {
    previous === undefined ? delete process.env.MAX_RECORDING_BYTES : process.env.MAX_RECORDING_BYTES = previous;
  }
  assert.equal((await sendPiece(recorder.token, id, 1, Buffer.alloc(17 * 1024 * 1024))).status, 413);
  await recordingApi(recorder.token, `/${id}`, 'DELETE');
  await leaveCall(voice, socket);
});

test('a video plays from a signed link that supports seeking, and a bad link is refused', async () => {
  const general = firstChannel('text');
  const viewer = await join('Video viewer');
  const video = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('0123456789abcdefghij')]);
  const form = new FormData();
  form.append('conversationId', general);
  form.append('file', new Blob([video], { type: 'video/webm' }), 'lesson.webm');
  const { attachmentId } = await (await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(viewer.token), body: form })).json();

  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}/stream-url`)).status, 401);
  const { url } = await (await fetch(`${baseUrl}/api/attachments/${attachmentId}/stream-url`, { headers: auth(viewer.token) })).json();
  const whole = await fetch(`${baseUrl}${url}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/webm');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
  const part = await fetch(`${baseUrl}${url}`, { headers: { Range: 'bytes=4-13' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 4-13/${video.length}`);
  assert.equal(await part.text(), '0123456789');

  const token = new URL(url, baseUrl).searchParams.get('token');
  // A link opens only its own file, and is never a session.
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}/stream?token=nonsense`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}/stream`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: auth(token) })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}/stream?token=${encodeURIComponent(viewer.token)}`)).status, 401);
  const forged = jwt.sign({ purpose: 'stream', attachmentId, sub: viewer.user.id }, 'some-other-secret-that-is-long-enough', { expiresIn: '1h' });
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}/stream?token=${forged}`)).status, 401);
});

test('anyone can create, rename and delete channels, and the last text channel stays', async () => {
  const carol = await join('Carol');
  const socket = await connect(carol.token);
  // The list sent on connecting may still be on its way, so wait for one that has the new channel.
  const updated = eventWhere(socket, 'channels', ({ channels }) => channels.some(listed => listed.name === 'Homework'));
  const { channel } = await emitWithAck(socket, 'create_channel', { name: '  Homework‮ ', kind: 'text' });
  assert.equal(channel.name, 'Homework');
  assert.equal(channel.kind, 'text');
  assert.ok((await updated).channels.some(listed => listed.id === channel.id));
  assert.deepEqual(await emitWithAck(socket, 'create_channel', { name: '', kind: 'text' }), { error: 'Invalid channel' });
  assert.deepEqual(await emitWithAck(socket, 'create_channel', { name: 'x', kind: 'video' }), { error: 'Invalid channel' });

  await emitWithAck(socket, 'send_message', { conversationId: channel.id, content: 'in homework', type: 'text' });
  assert.deepEqual(await emitWithAck(socket, 'rename_channel', { channelId: channel.id, name: 'Revision' }), { ok: true });
  assert.equal(db.prepare('SELECT name FROM channels WHERE id = ?').get(channel.id).name, 'Revision');
  assert.deepEqual(await emitWithAck(socket, 'delete_channel', { channelId: channel.id }), { ok: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(channel.id).n, 0);
  assert.equal((await fetch(`${baseUrl}/api/conversations/${channel.id}/messages`, { headers: auth(carol.token) })).status, 404);

  // Only one text channel is left now, and it cannot be deleted.
  assert.deepEqual(await emitWithAck(socket, 'delete_channel', { channelId: firstChannel('text') }), { error: 'Last text channel' });
});

test('joining a voice channel shows everyone who is in it, and anyone in it can share screen and camera', async () => {
  const voice = firstChannel('voice');
  const dan = await join('Dan');
  const erin = await join('Erin');
  const outsider = await join('Outsider');
  const [danSocket, erinSocket] = await Promise.all([connect(dan.token), connect(erin.token)]);

  // Nobody gets into a call without showing up in the channel first.
  assert.equal((await callToken(outsider.token, voice)).status, 409);
  assert.equal((await callToken(dan.token, 'nowhere')).status, 404);

  const erinSees = eventWhere(erinSocket, 'voice_state', state => membersIn(state, voice).includes('Dan'));
  const joined = await emitWithAck(danSocket, 'voice_join', { channelId: voice });
  assert.equal(typeof joined.startedAt, 'number');
  const state = await erinSees;
  const call = state.calls.find(listed => listed.channelId === voice);
  assert.deepEqual(call.members.map(member => member.displayName), ['Dan']);

  assert.equal((await withoutLiveKit(() => callToken(dan.token, voice))).status, 503);
  const media = await callToken(dan.token, voice);
  assert.equal(media.status, 200);
  const credentials = await media.json();
  assert.equal(credentials.url, process.env.LIVEKIT_URL);
  assert.equal(credentials.roomName, `voice-${voice}`);
  const grant = jwt.decode(credentials.token).video;
  assert.equal(grant.room, credentials.roomName);
  assert.deepEqual(grant.canPublishSources.sort(), ['camera', 'microphone', 'screen_share', 'screen_share_audio']);

  // A second person meets the first in the same room, with the same powers.
  await emitWithAck(erinSocket, 'voice_join', { channelId: voice });
  const erinCredentials = await (await callToken(erin.token, voice)).json();
  assert.equal(erinCredentials.roomName, credentials.roomName);
  assert.deepEqual(jwt.decode(erinCredentials.token).video.canPublishSources.sort(), ['camera', 'microphone', 'screen_share', 'screen_share_audio']);

  // Hands are shown to everyone, and only their owner lowers them.
  const handSeen = eventWhere(danSocket, 'voice_state', state => state.calls.some(call => call.hands.length));
  erinSocket.emit('raise_hand', { channelId: voice, raised: true });
  assert.deepEqual((await handSeen).calls.find(listed => listed.channelId === voice).hands.map(hand => hand.displayName), ['Erin']);

  // Leaving, or losing the connection, takes a person out of the channel.
  const afterLeave = eventWhere(erinSocket, 'voice_state', state => !membersIn(state, voice).includes('Dan'));
  danSocket.emit('voice_leave');
  assert.deepEqual(membersIn(await afterLeave, voice), ['Erin']);
  assert.equal((await callToken(dan.token, voice)).status, 409);
  const afterDrop = eventWhere(danSocket, 'voice_state', state => !membersIn(state, voice).includes('Erin'));
  erinSocket.disconnect();
  assert.equal((await afterDrop).calls.some(listed => listed.channelId === voice), false);
});

test('a phone shares its screen through a screen-only pass that ends when its owner leaves', async () => {
  const voice = firstChannel('voice');
  const gina = await join('Gina');
  const outsider = await join('Screen outsider');
  const socket = await connect(gina.token);

  assert.equal((await screenToken(outsider.token, voice)).status, 409);
  assert.equal((await screenToken(gina.token, 'nowhere')).status, 404);
  await emitWithAck(socket, 'voice_join', { channelId: voice });
  assert.equal((await withoutLiveKit(() => screenToken(gina.token, voice))).status, 503);

  const response = await screenToken(gina.token, voice);
  assert.equal(response.status, 200);
  const credentials = await response.json();
  assert.equal(credentials.url, process.env.LIVEKIT_URL);
  const claims = jwt.decode(credentials.token);
  // The screen joins as its owner's name with its own identity, and can only show the screen.
  assert.equal(claims.sub, `${gina.user.id}:screen`);
  assert.equal(claims.name, 'Gina');
  assert.equal(claims.video.room, `voice-${voice}`);
  assert.equal(claims.video.canSubscribe, false);
  assert.equal(claims.video.canPublishData, false);
  assert.deepEqual(claims.video.canPublishSources.sort(), ['screen_share', 'screen_share_audio']);

  const removed = () => liveKitCalls('RemoveParticipant').some(call => call.data.identity === `${gina.user.id}:screen`);
  assert.equal(removed(), false);
  socket.emit('voice_leave');
  assert.ok(await eventually(removed));
  assert.equal((await screenToken(gina.token, voice)).status, 409);
});

test('a person is in one voice channel at a time, and deleting a voice channel closes its call', async () => {
  const frank = await join('Frank');
  const socket = await connect(frank.token);
  const lounge = (await emitWithAck(socket, 'create_channel', { name: 'Lounge', kind: 'voice' })).channel;
  await emitWithAck(socket, 'voice_join', { channelId: firstChannel('voice') });
  const moved = eventWhere(socket, 'voice_state', state => membersIn(state, lounge.id).length > 0);
  await emitWithAck(socket, 'voice_join', { channelId: lounge.id });
  const calls = (await moved).calls;
  assert.deepEqual(calls.map(call => call.channelId), [lounge.id]);
  assert.deepEqual(await emitWithAck(socket, 'voice_join', { channelId: firstChannel('text') }), { error: 'Unknown channel' });

  const closed = eventWhere(socket, 'voice_state', state => state.calls.length === 0);
  assert.deepEqual(await emitWithAck(socket, 'delete_channel', { channelId: lounge.id }), { ok: true });
  assert.deepEqual((await closed).calls, []);
  assert.ok(await eventually(() => liveKitCalls('DeleteRoom').some(call => call.data.room === `voice-${lounge.id}`)));
});

test('a connecting client learns the channels, who is online and who is in calls', async () => {
  const gina = await join('Gina');
  const socket = io(baseUrl, { auth: { token: gina.token }, transports: ['websocket'] });
  sockets.push(socket);
  const [presence, channels, voice] = await Promise.all([nextEvent(socket, 'presence_state'), nextEvent(socket, 'channels'), nextEvent(socket, 'voice_state')]);
  assert.ok(presence.users.some(user => user.displayName === 'Gina'));
  assert.ok(channels.channels.some(channel => channel.kind === 'text'));
  assert.ok(channels.channels.some(channel => channel.kind === 'voice'));
  assert.ok(Array.isArray(voice.calls));
});

test('everyone can delete only their own messages, and deleted text stays hidden', async () => {
  const conversationId = firstChannel('text');
  const [henry, iris] = await Promise.all([join('Henry'), join('Iris')]);
  const [henrySocket, irisSocket] = await Promise.all([connect(henry.token), connect(iris.token)]);
  const { id } = await emitWithAck(henrySocket, 'send_message', { conversationId, content: 'mine', type: 'text' });
  const untouched = quietFor(henrySocket, 'message_deleted');
  irisSocket.emit('delete_message', { messageId: id });
  assert.equal(await untouched, true);
  const deleted = nextEvent(irisSocket, 'message_deleted');
  henrySocket.emit('delete_message', { messageId: id });
  assert.equal((await deleted).messageId, id);
  const history = await (await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, { headers: auth(iris.token) })).json();
  const gone = history.find(message => message.id === id);
  assert.equal(gone.deleted, true);
  assert.equal(gone.content, null);
});

test('the invite key lets anyone in by name, with cleaned names and no roles', async () => {
  const visitorId = nextVisitorId();
  const arabicDigits = await joinRequest({ inviteKey: ' ٠٠٠٠ ', visitorId, displayName: '  Jamal‮  Ali ' });
  assert.equal(arabicDigits.status, 200);
  const session = await arabicDigits.json();
  assert.equal(session.user.displayName, 'Jamal Ali');
  assert.equal(session.user.role, undefined);
  const me = await (await fetch(`${baseUrl}/api/me`, { headers: auth(session.token) })).json();
  assert.equal(me.displayName, 'Jamal Ali');
  // The same device comes back as the same person without typing its name again.
  const restored = await (await joinRequest({ inviteKey: '0000', visitorId })).json();
  assert.equal(restored.user.id, session.user.id);
  assert.equal(restored.user.displayName, 'Jamal Ali');
  assert.equal((await joinRequest({ inviteKey: '9999', visitorId: nextVisitorId(), displayName: 'Eve' })).status, 401);
  assert.equal((await joinRequest({ inviteKey: '0000', visitorId: nextVisitorId() })).status, 400);
});

test('changing the invite key signs out everyone who does not have the new link', async () => {
  const before = await join('Before the change');
  const me = token => fetch(`${baseUrl}/api/me`, { headers: auth(token) });
  const previous = process.env.INVITE_KEY;
  process.env.INVITE_KEY = 'new-secret-key';
  try {
    assert.equal((await me(before.token)).status, 401);
    await assert.rejects(connect(before.token));
    assert.equal((await joinRequest({ inviteKey: '0000', visitorId: nextVisitorId(), displayName: 'Old link' })).status, 401);
    const rejoined = await join('After the change', 'NEW-SECRET-KEY');
    assert.equal((await me(rejoined.token)).status, 200);
  } finally {
    previous === undefined ? delete process.env.INVITE_KEY : process.env.INVITE_KEY = previous;
  }
});

test("the class app's chat becomes #general with its messages when Hangout first starts on its server", () => {
  const classDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangout-class-'));
  try {
    // The parts of the class app's database that matter: its one class conversation, a student
    // with the role column Hangout no longer uses, and a message.
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const Database = requireFromRoot('better-sqlite3');
    const classDb = new Database(path.join(classDir, 'chat.db'));
    classDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL DEFAULT '#6366f1', status TEXT, last_seen INTEGER, created_at INTEGER, visitor_id TEXT,
        role TEXT NOT NULL DEFAULT 'student', removed_at INTEGER);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, created_by TEXT, created_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id), content TEXT, type TEXT NOT NULL DEFAULT 'text', file_url TEXT, file_name TEXT,
        attachment_id TEXT, reply_to TEXT, edited_at INTEGER, deleted INTEGER DEFAULT 0, created_at INTEGER);
      INSERT INTO conversations (id, type, name) VALUES ('classroom', 'group', 'Classroom');
      INSERT INTO users (id, username, display_name, password_hash, visitor_id) VALUES ('u1', 'amina', 'Amina', 'disabled', '00000000-0000-4000-8000-000000000999');
      INSERT INTO messages (id, conversation_id, sender_id, content, created_at) VALUES ('m1', 'classroom', 'u1', 'السلام عليكم', 1);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES users(id), disk_name TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf')),
        size INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO attachments VALUES ('a1', 'classroom', 'u1', 'sheet.pdf', 'Lesson 1.pdf', 'application/pdf', 10, 1);
    `);
    classDb.close();

    const script = `const loaded = (await import('./server/database.ts')).default; const db = loaded.default ?? loaded;
      console.log(JSON.stringify({
        channels: db.prepare('SELECT id, name, kind FROM channels ORDER BY position').all(),
        messages: db.prepare('SELECT id, conversation_id, content FROM messages').all(),
        attachments: db.prepare('SELECT id, original_name FROM attachments').all(),
        acceptsSound: !db.prepare("SELECT sql FROM sqlite_master WHERE name = 'attachments'").get().sql.includes('CHECK'),
      }));`;
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATA_DIR: classDir },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout.trim().split('\n').pop());
    assert.deepEqual(result.channels.map(channel => [channel.name, channel.kind]), [['general', 'text'], ['General', 'voice']]);
    assert.equal(result.channels[0].id, 'classroom');
    assert.deepEqual(result.messages, [{ id: 'm1', conversation_id: 'classroom', content: 'السلام عليكم' }]);
    // The class's files are kept when the attachments table is rebuilt to take sound and video.
    assert.deepEqual(result.attachments, [{ id: 'a1', original_name: 'Lesson 1.pdf' }]);
    assert.equal(result.acceptsSound, true);

    // Starting again changes nothing: the channels exist now.
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout.trim().split('\n').pop()).channels, result.channels);
  } finally {
    fs.rmSync(classDir, { recursive: true, force: true });
  }
});

test('production needs a long invite key', () => {
  const loadConfig = env => spawnSync(process.execPath, ['--import', 'tsx', '--eval', "require('./server/config.ts')"], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', DATA_DIR: tempDir, ...env },
  });
  assert.equal(loadConfig({ INVITE_KEY: 'k7QpX2mZr9Tb' }).status, 0);
  assert.match(loadConfig({ INVITE_KEY: '' }).stderr, /INVITE_KEY is required in production/);
  assert.match(loadConfig({ INVITE_KEY: 'short' }).stderr, /INVITE_KEY must be at least 12 characters/);
});

test('paging through history never skips messages sent in the same millisecond', async () => {
  const reader = await join('History reader');
  const general = firstChannel('text');
  const insert = db.prepare("INSERT INTO messages (id, conversation_id, sender_id, content, type, created_at) VALUES (?, ?, ?, ?, 'text', ?)");
  // Dated in the past so they stay out of other tests' latest page.
  const sameMoment = 946_684_800_000;
  const ids = [];
  for (let n = 0; n < 75; n++) {
    const id = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    ids.push(id);
    insert.run(id, general, reader.user.id, `Same moment ${n}`, sameMoment);
  }
  const page = async query => (await fetch(`${baseUrl}/api/conversations/${general}/messages${query}`, { headers: { Authorization: `Bearer ${reader.token}` } })).json();
  const seen = [];
  let batch = await page(`?before=${sameMoment + 1}`);
  while (batch.length) {
    seen.unshift(...batch.map(message => message.id));
    batch = await page(`?before=${batch[0].createdAt}&beforeId=${batch[0].id}`);
  }
  // All of them, once each, in the order they were written.
  assert.deepEqual(seen.filter(id => ids.includes(id)), ids);
  assert.equal((await fetch(`${baseUrl}/api/conversations/${general}/messages?before=1&beforeId=nope`, { headers: { Authorization: `Bearer ${reader.token}` } })).status, 400);
});

test('a burst of events is refused with an error instead of disconnecting', async () => {
  const conversationId = firstChannel('text');
  const student = await join('Fast typist');
  const socket = await connect(student.token);
  for (let key = 0; key < 130; key++) socket.emit('typing', { conversationId });
  const refused = await emitWithAck(socket, 'send_message', { conversationId, content: 'still here?', type: 'text' });
  assert.deepEqual(refused, { error: 'Too many requests' });
  assert.equal(socket.connected, true);
});

test('large PDFs up to the 100 MB default upload limit are accepted', async () => {
  const user = await join('Large PDF');
  const auth = { Authorization: `Bearer ${user.token}` };
  const pdf = Buffer.alloc(Math.floor(12.8 * 1024 * 1024));
  pdf.write('%PDF-1.7');
  const form = new FormData();
  form.append('conversationId', firstChannel('text'));
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'large.pdf');
  const uploaded = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth, body: form });
  assert.equal(uploaded.status, 200);
  const { attachmentId } = await uploaded.json();
  const fetched = await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth });
  assert.equal(fetched.status, 200);
  assert.equal(Number(fetched.headers.get('content-length')), pdf.length);
});

test('uploads larger than 100 MB are rejected with a clear size error', async () => {
  const user = await join('Oversized PDF');
  const pdf = Buffer.alloc(100 * 1024 * 1024 + 1);
  pdf.write('%PDF-1.7');
  const form = new FormData();
  form.append('conversationId', firstChannel('text'));
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'too-large.pdf');
  const rejected = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form,
  });
  assert.equal(rejected.status, 413);
  assert.match((await rejected.json()).error, /100 MB/i);
});

test('upload configuration requires authentication and reports the configured default limit', async () => {
  assert.equal((await fetch(`${baseUrl}/api/upload-config`)).status, 401);
  const user = await join('Upload Config');
  const response = await fetch(`${baseUrl}/api/upload-config`, { headers: { Authorization: `Bearer ${user.token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).maxUploadBytes, 100 * 1024 * 1024);
});

test('friends who are away are notified of messages, mentions and calls, as each of them chose', async () => {
  const general = firstChannel('text');
  const [salma, amal, hind, qasim, omar] = await Promise.all(['Salma', 'Away Amal', 'Here Hind', 'Quiet Qasim', 'Off Omar'].map(name => join(name)));
  const subs = Object.fromEntries(['salma', 'amal', 'hind', 'qasim', 'omar'].map(name => [name, browserSubscription(`levels-${name}`)]));
  for (const [person, name] of [[salma, 'salma'], [amal, 'amal'], [hind, 'hind'], [omar, 'omar']]) assert.equal((await subscribe(person.token, subs[name])).status, 200);
  assert.equal((await subscribe(qasim.token, subs.qasim, { lang: 'ar' })).status, 200);

  // Everyone starts with every notification; the choice is kept per person.
  const me = token => fetch(`${baseUrl}/api/me`, { headers: auth(token) }).then(response => response.json());
  assert.equal((await me(qasim.token)).notifyLevel, 'all');
  assert.equal((await setLevel(qasim.token, 'mentions')).status, 200);
  assert.equal((await setLevel(omar.token, 'off')).status, 200);
  assert.equal((await setLevel(omar.token, 'loud')).status, 400);
  assert.equal((await me(qasim.token)).notifyLevel, 'mentions');

  // Hind has the app in front of her, so she sees messages there instead.
  const hindSocket = await connect(hind.token);
  assert.deepEqual(await emitWithAck(hindSocket, 'app_active', { active: true }), { ok: true });
  const salmaSocket = await connect(salma.token);

  await emitWithAck(salmaSocket, 'send_message', { conversationId: general, content: 'Hello   friends', type: 'text' });
  assert.ok(await eventually(() => pushesTo(subs.amal).length === 1));
  assert.deepEqual(pushesTo(subs.amal)[0], {
    title: 'Salma in #general', body: 'Hello friends', tag: `channel-${general}`, channelId: general, url: `/?channel=${general}`,
  });
  // Notifications of one channel share a topic, so a phone that was offline gets only the latest.
  const amalRequest = pushService.received.find(entry => entry.name === 'levels-amal');
  assert.equal(amalRequest.headers.topic.length, 32);
  assert.equal(amalRequest.headers.urgency, 'high');
  const [, vapidPass] = /^vapid t=([^,]+), k=.+/.exec(amalRequest.headers.authorization);
  assert.equal(jwt.decode(vapidPass).sub, 'https://majlis.test');

  // A mention reaches Qasim, who only wants mentions, in the language his device uses.
  await emitWithAck(salmaSocket, 'send_message', { conversationId: general, content: `Lesson at five, <@${qasim.user.id}>`, type: 'text' });
  assert.ok(await eventually(() => pushesTo(subs.qasim).length === 1 && pushesTo(subs.amal).length === 2));
  assert.deepEqual([pushesTo(subs.qasim)[0].title, pushesTo(subs.qasim)[0].body], ['Salma ذكرك في #general', 'Lesson at five, @Quiet Qasim']);
  assert.equal(pushesTo(subs.amal)[1].title, 'Salma in #general');

  // Hind looks away from the app, and @everyone now reaches her too.
  await emitWithAck(hindSocket, 'app_active', { active: false });
  await emitWithAck(salmaSocket, 'send_message', { conversationId: general, content: '@everyone class is starting', type: 'text' });
  assert.ok(await eventually(() => pushesTo(subs.hind).length === 1 && pushesTo(subs.qasim).length === 2));
  assert.equal(pushesTo(subs.hind)[0].title, 'Salma mentioned you in #general');

  // Starting a call tells those who want calls, once, however often people hop in and out.
  const lesson = (await emitWithAck(salmaSocket, 'create_channel', { name: 'Lesson', kind: 'voice' })).channel;
  await emitWithAck(salmaSocket, 'voice_join', { channelId: lesson.id });
  assert.ok(await eventually(() => pushesTo(subs.qasim).length === 3 && pushesTo(subs.amal).length === 4));
  assert.deepEqual(pushesTo(subs.amal)[3], {
    title: 'Salma started a call in 🔊 Lesson', body: '', tag: `channel-${lesson.id}`, channelId: lesson.id, url: `/?channel=${lesson.id}`,
  });
  salmaSocket.emit('voice_leave');
  await emitWithAck(salmaSocket, 'voice_join', { channelId: lesson.id });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(pushesTo(subs.amal).length, 4);

  // The sender and the person who turned notifications off were never notified.
  assert.equal(pushesTo(subs.salma).length, 0);
  assert.equal(pushesTo(subs.omar).length, 0);
  salmaSocket.emit('voice_leave');
});

test('photos, voice messages, videos and files are described in notifications', async () => {
  const general = firstChannel('text');
  const [yusuf, zaid] = await Promise.all([join('Yusuf'), join('Zaid')]);
  const zaidSub = browserSubscription('attachments-zaid');
  await subscribe(zaid.token, zaidSub);
  const socket = await connect(yusuf.token);
  const send = async (bytes, type, name) => {
    const form = new FormData();
    form.append('conversationId', general);
    form.append('file', new Blob([bytes], { type }), name);
    const uploaded = await (await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(yusuf.token), body: form })).json();
    return emitWithAck(socket, 'send_message', { conversationId: general, type: uploaded.type, attachmentId: uploaded.attachmentId });
  };
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)]);
  await send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F+4AAAAASUVORK5CYII=', 'base64'), 'image/png', 'tiny.png');
  await send(webm, 'audio/webm', 'voice.webm');
  await send(webm, 'video/webm', 'lesson.webm');
  await send(Buffer.from('%PDF-1.7 homework'), 'application/pdf', 'Homework 3.pdf');
  assert.ok(await eventually(() => pushesTo(zaidSub).length === 4));
  assert.deepEqual(pushesTo(zaidSub).map(push => push.body), ['📷 Photo', '🎤 Voice message', '🎥 Video', 'Homework 3.pdf']);
});

test('a device the push service no longer knows is forgotten, and bad subscriptions are refused', async () => {
  const general = firstChannel('text');
  const [layla, musa] = await Promise.all([join('Layla'), join('Musa')]);
  const gone = browserSubscription('gone-layla');
  pushService.gone.add('gone-layla');
  assert.equal((await subscribe(layla.token, gone)).status, 200);
  const stored = endpoint => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(endpoint).n;
  assert.equal(stored(gone.endpoint), 1);
  const socket = await connect(musa.token);
  await emitWithAck(socket, 'send_message', { conversationId: general, content: 'anyone there?', type: 'text' });
  assert.ok(await eventually(() => stored(gone.endpoint) === 0));

  const valid = browserSubscription('valid-layla');
  const refused = async body => (await fetch(`${baseUrl}/api/push/subscribe`, { method: 'POST', headers: jsonAuth(layla.token), body: JSON.stringify(body) })).status;
  assert.equal(await refused({ kind: 'sms', endpoint: valid.endpoint }), 400);
  assert.equal(await refused({ kind: 'web', endpoint: 'https://example.com/steal', keys: valid.keys }), 400);
  assert.equal(await refused({ kind: 'web', endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: valid.keys }), 400);
  assert.equal(await refused({ kind: 'web', endpoint: valid.endpoint, keys: { p256dh: valid.keys.p256dh.slice(4), auth: valid.keys.auth } }), 400);
  assert.equal(await refused({ kind: 'web', endpoint: valid.endpoint, keys: { p256dh: valid.keys.p256dh } }), 400);
  assert.equal(await refused({ kind: 'web', endpoint: valid.endpoint.padEnd(3000, 'x'), keys: valid.keys }), 400);
  assert.equal(await refused({ kind: 'fcm', endpoint: 'short' }), 400);
  assert.equal(await refused({ kind: 'apns', endpoint: 'not-a-device-token-at-all' }), 400);
  assert.equal((await fetch(`${baseUrl}/api/push/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  // Signing out removes the device, but nobody can remove someone else's.
  assert.equal((await subscribe(layla.token, valid)).status, 200);
  const unsubscribe = token => fetch(`${baseUrl}/api/push/subscribe`, { method: 'DELETE', headers: jsonAuth(token), body: JSON.stringify({ endpoint: valid.endpoint }) });
  await unsubscribe(musa.token);
  assert.equal(stored(valid.endpoint), 1);
  await unsubscribe(layla.token);
  assert.equal(stored(valid.endpoint), 0);
});

test('the Android and iPhone apps are notified through Firebase and Apple once their keys are set', async () => {
  const general = firstChannel('text');
  const [nour, rami] = await Promise.all([join('Nour'), join('Rami')]);
  const config = () => fetch(`${baseUrl}/api/push/config`, { headers: auth(nour.token) }).then(response => response.json());
  const initial = await config();
  assert.deepEqual([typeof initial.webPublicKey, initial.fcm, initial.apns], ['string', false, false]);

  // Stand-ins for Google (its sign-in and Firebase) and for Apple's push service.
  const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apple = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const firebase = { messages: [], passes: 0 };
  const googleServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/token') {
        const claims = jwt.verify(new URLSearchParams(body).get('assertion'), google.publicKey, { algorithms: ['RS256'] });
        if (claims.iss === 'push@majlis-test.iam.gserviceaccount.com') firebase.passes++;
        return res.end(JSON.stringify({ access_token: 'firebase-access', expires_in: 3600 }));
      }
      const { message } = JSON.parse(body);
      firebase.messages.push({ ...message, url: req.url, authorization: req.headers.authorization });
      if (message.token.startsWith('uninstalled')) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
      }
      res.end('{"name":"sent"}');
    });
  });
  const appleServer = http2.createServer();
  const appleRequests = [];
  appleServer.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', chunk => { body += chunk; });
    stream.on('end', () => {
      appleRequests.push({ headers, body: JSON.parse(body) });
      const gone = headers[':path'].endsWith('dead');
      stream.respond({ ':status': gone ? 410 : 200, 'content-type': 'application/json' });
      stream.end(gone ? '{"reason":"Unregistered"}' : '');
    });
  });
  await Promise.all([googleServer, appleServer].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const saved = Object.fromEntries(['FCM_SERVICE_ACCOUNT', 'FCM_API_BASE', 'APNS_KEY', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_HOST'].map(key => [key, process.env[key]]));
  const googleBase = `http://127.0.0.1:${googleServer.address().port}`;
  const account = {
    project_id: 'majlis-test', client_email: 'push@majlis-test.iam.gserviceaccount.com', token_uri: `${googleBase}/token`,
    private_key: google.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  Object.assign(process.env, {
    // Base64 keeps the whole JSON file on one line, as a deployment variable wants.
    FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(account)).toString('base64'), FCM_API_BASE: googleBase,
    APNS_KEY: apple.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'), APNS_KEY_ID: 'KEY1234567', APNS_TEAM_ID: 'TEAM123456',
    APNS_HOST: `http://127.0.0.1:${appleServer.address().port}`,
  });
  try {
    const configured = await config();
    assert.deepEqual([configured.fcm, configured.apns], [true, true]);
    const android = `phone-token:${'a'.repeat(140)}`;
    const iphone = 'ab'.repeat(32);
    const add = (kind, endpoint) => fetch(`${baseUrl}/api/push/subscribe`, { method: 'POST', headers: jsonAuth(rami.token), body: JSON.stringify({ kind, endpoint, lang: 'en' }) });
    for (const [kind, endpoint] of [['fcm', android], ['fcm', `uninstalled:${'b'.repeat(140)}`], ['apns', iphone], ['apns', `${'cd'.repeat(30)}dead`]]) {
      assert.equal((await add(kind, endpoint)).status, 200);
    }
    const socket = await connect(nour.token);
    await emitWithAck(socket, 'send_message', { conversationId: general, content: 'On my way', type: 'text' });
    const devices = () => db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(rami.user.id).map(row => row.endpoint).sort();
    assert.ok(await eventually(() => firebase.messages.length === 2 && appleRequests.length === 2 && devices().length === 2));
    // Uninstalled apps are forgotten.
    assert.deepEqual(devices(), [iphone, android].sort());
    assert.equal(firebase.passes, 1);

    const toAndroid = firebase.messages.find(message => message.token === android);
    assert.equal(toAndroid.url, '/v1/projects/majlis-test/messages:send');
    assert.equal(toAndroid.authorization, 'Bearer firebase-access');
    assert.deepEqual(toAndroid.notification, { title: 'Nour in #general', body: 'On my way' });
    assert.deepEqual(toAndroid.data, { channelId: general });
    assert.deepEqual(toAndroid.android.notification, { tag: `channel-${general}`, channel_id: 'messages' });

    const toIphone = appleRequests.find(request => request.headers[':path'] === `/3/device/${iphone}`);
    assert.equal(toIphone.headers['apns-topic'], 'com.samycc777.majlis');
    assert.equal(toIphone.headers['apns-collapse-id'], `channel-${general}`);
    const pass = jwt.verify(toIphone.headers.authorization.replace('bearer ', ''), apple.publicKey, { algorithms: ['ES256'], complete: true });
    assert.deepEqual([pass.header.kid, pass.payload.iss], ['KEY1234567', 'TEAM123456']);
    assert.deepEqual(toIphone.body, {
      aps: { alert: { title: 'Nour in #general', body: 'On my way' }, sound: 'default', 'thread-id': general }, channelId: general,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await Promise.all([googleServer, appleServer].map(server => new Promise(resolve => server.close(resolve))));
  }
});

// Runs last because it deliberately locks this test client's address out of joining.
test('repeated wrong invite keys lock the address out briefly, even for the right code', async () => {
  // Earlier tests already spent some of this minute's wrong attempts.
  const statuses = [];
  for (let attempt = 0; attempt < 10 && statuses.at(-1) !== 429; attempt++) {
    statuses.push((await joinRequest({ inviteKey: `wrong-${attempt}`, visitorId: nextVisitorId(), displayName: 'Guesser' })).status);
  }
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.slice(0, -1).every(status => status === 401));
  const lockedOut = await joinRequest({ inviteKey: '0000', visitorId: nextVisitorId(), displayName: 'Guesser' });
  assert.equal(lockedOut.status, 429);
  assert.ok(Number(lockedOut.headers.get('retry-after')) > 0);
});
