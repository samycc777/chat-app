import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
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
  await startFakeLiveKit();
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
