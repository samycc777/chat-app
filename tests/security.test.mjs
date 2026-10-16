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
const firstChannel = kind => db.prepare('SELECT id FROM channels WHERE kind = ? AND room_id IS NULL ORDER BY position LIMIT 1').get(kind).id;
const callToken = (token, channelId) => fetch(`${baseUrl}/api/livekit/token`, {
  method: 'POST', headers: jsonAuth(token), body: JSON.stringify({ channelId }),
});
const screenToken = (token, channelId) => fetch(`${baseUrl}/api/livekit/screen-token`, {
  method: 'POST', headers: jsonAuth(token), body: JSON.stringify({ channelId }),
});
const emitWithAck = (socket, event, data) => new Promise(resolve => socket.emit(event, data, resolve));
// A second call in the home room, so no earlier test has already chatted in it or announced it.
function newCall(name) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, ?, ?, 99, ?)').run(id, name, 'voice', Date.now());
  return id;
}
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


test('the home screen app starts with the invite, identity and name only when the invite is right', async () => {
  const visitor = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const manifest = async query => (await fetch(`${baseUrl}/manifest.webmanifest${query}`)).json();
  assert.equal((await manifest('')).start_url, '/');
  assert.equal((await manifest(`?invite=wrong&visitor=${visitor}&name=Salma`)).start_url, '/');
  const start = new URL((await manifest(`?invite=0000&visitor=${visitor}&name=${encodeURIComponent('Sal\u202Ema')}`)).start_url, baseUrl);
  assert.equal(start.pathname, '/');
  assert.equal(start.searchParams.get('invite'), '0000');
  assert.equal(start.searchParams.get('visitor'), visitor);
  assert.equal(start.searchParams.get('name'), 'Salma');
  const badVisitor = new URL((await manifest('?invite=0000&visitor=nope')).start_url, baseUrl);
  assert.equal(badVisitor.searchParams.get('visitor'), null);
});

// Later tests expect the voice channel to start empty.
async function leaveCall(channelId, ...leaving) {
  for (const socket of leaving) socket.emit('voice_leave');
  const { getCall } = await import('../server/voice.ts');
  assert.ok(await eventually(() => !getCall(channelId)));
}

test('anyone can set, replace and remove their photo, and everyone online sees it at once', async () => {
  const piaVisitor = nextVisitorId();
  const pia = await (await joinRequest({ inviteKey: '0000', visitorId: piaVisitor, displayName: 'Pia' })).json();
  const quinn = await join('Quinn');
  assert.equal(pia.user.avatarUrl, null);
  const quinnSocket = await connect(quinn.token);
  await connect(pia.token);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
  const setPhoto = (token, body, type = 'image/jpeg') => fetch(`${baseUrl}/api/me/avatar`, {
    method: 'PUT', headers: { ...auth(token), 'Content-Type': type }, body,
  });

  // Only a signed-in person can set a photo, only a JPEG, and only a small one.
  assert.equal((await setPhoto('', jpeg)).status, 401);
  assert.equal((await setPhoto(pia.token, Buffer.from('<svg onload="alert(1)"/>'))).status, 400);
  assert.equal((await setPhoto(pia.token, Buffer.from('<svg/>'), 'image/svg+xml')).status, 400);
  assert.equal((await setPhoto(pia.token, Buffer.concat([jpeg, Buffer.alloc(400 * 1024)]))).status, 413);

  const quinnSees = eventWhere(quinnSocket, 'presence', data => data.userId === pia.user.id && data.user?.avatarUrl);
  const first = await setPhoto(pia.token, jpeg);
  assert.equal(first.status, 200);
  const { avatarUrl } = await first.json();
  assert.match(avatarUrl, /^\/api\/avatars\/[0-9a-f-]{36}$/);
  assert.equal((await quinnSees).user.avatarUrl, avatarUrl);
  const picture = await fetch(`${baseUrl}${avatarUrl}`);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), jpeg);

  // The photo comes back on the next opening and with who you are.
  const again = await (await joinRequest({ inviteKey: '0000', visitorId: piaVisitor, displayName: 'Pia' })).json();
  assert.equal(again.user.avatarUrl, avatarUrl);
  assert.equal((await (await fetch(`${baseUrl}/api/me`, { headers: auth(pia.token) })).json()).avatarUrl, avatarUrl);

  // A new photo has a new address, and the old one stops working.
  const second = await (await setPhoto(pia.token, Buffer.concat([jpeg, Buffer.from([1])]))).json();
  assert.notEqual(second.avatarUrl, avatarUrl);
  assert.equal((await fetch(`${baseUrl}${avatarUrl}`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM avatars WHERE user_id = ?').get(pia.user.id).count, 1);

  const quinnSeesRemoved = eventWhere(quinnSocket, 'presence', data => data.userId === pia.user.id && data.user?.avatarUrl === null);
  const removed = await fetch(`${baseUrl}/api/me/avatar`, { method: 'DELETE', headers: auth(pia.token) });
  assert.deepEqual(await removed.json(), { avatarUrl: null });
  await quinnSeesRemoved;
  assert.equal((await fetch(`${baseUrl}${second.avatarUrl}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/avatars/not-an-id`)).status, 404);
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

test("a phone's screen keeps going while its owner's connection drops for a moment, and stops if they do not come back to the call at all", async () => {
  const { sweepDroppedScreens, DROPPED_SCREEN_MS } = await import('../server/socket.ts');
  const voice = firstChannel('voice');
  const teacher = await join('Tablet teacher');
  const removed = () => liveKitCalls('RemoveParticipant').some(call => call.data.identity === `${teacher.user.id}:screen`);
  const later = () => Date.now() + DROPPED_SCREEN_MS + 1000;

  // The connection drops and comes back: the screen is still his, and still going.
  const first = await connect(teacher.token);
  await emitWithAck(first, 'voice_join', { channelId: voice });
  assert.equal((await screenToken(teacher.token, voice)).status, 200);
  first.disconnect();
  await new Promise(resolve => setTimeout(resolve, 100));
  await sweepDroppedScreens();
  assert.equal(removed(), false);
  const second = await connect(teacher.token);
  await emitWithAck(second, 'voice_join', { channelId: voice, rejoin: true });
  await sweepDroppedScreens(later());
  assert.equal(removed(), false);

  // Leaving on purpose still stops it straight away.
  second.emit('voice_leave');
  assert.ok(await eventually(removed));

  // A connection that never comes back stops the screen once the wait is over.
  const third = await connect(teacher.token);
  await emitWithAck(third, 'voice_join', { channelId: voice });
  assert.equal((await screenToken(teacher.token, voice)).status, 200);
  const removals = () => liveKitCalls('RemoveParticipant').filter(call => call.data.identity === `${teacher.user.id}:screen`).length;
  const before = removals();
  third.disconnect();
  await new Promise(resolve => setTimeout(resolve, 100));
  await sweepDroppedScreens();
  assert.equal(removals(), before);
  // While the tablet is still in the call's sound and video, only its slowed-down app is missing,
  // so the lesson's screen goes on however long that takes.
  liveKit.participants.set(`voice-${voice}`, [{ identity: teacher.user.id }, { identity: `${teacher.user.id}:screen` }]);
  await sweepDroppedScreens(later());
  await sweepDroppedScreens(later() + DROPPED_SCREEN_MS);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(removals(), before);
  liveKit.participants.delete(`voice-${voice}`);
  await sweepDroppedScreens(later() + 3 * DROPPED_SCREEN_MS);
  assert.ok(await eventually(() => removals() > before));
});

test("a call's chat reaches everyone in it, private messages reach only their two people, and it is gone when the call empties", async () => {
  const [hana, ivan, jade, outsider] = await Promise.all(['Hana', 'Ivan', 'Jade', 'Outsider'].map(name => join(name)));
  const [hanaSocket, ivanSocket, jadeSocket, outsiderSocket] = await Promise.all([hana, ivan, jade, outsider].map(person => connect(person.token)));
  // A call of its own, so the chat starts empty whatever earlier tests said.
  const room = newCall('Chat room');
  const hanaHistory = nextEvent(hanaSocket, 'call_chat_history');
  await emitWithAck(hanaSocket, 'voice_join', { channelId: room });
  assert.deepEqual((await hanaHistory).messages, []);
  await emitWithAck(ivanSocket, 'voice_join', { channelId: room });

  // Only people in the call write in its chat, and only to people in it.
  assert.deepEqual(await emitWithAck(outsiderSocket, 'call_chat_send', { text: 'hi' }), { error: 'Not in a call' });
  assert.deepEqual(await emitWithAck(hanaSocket, 'call_chat_send', { text: 'psst', to: outsider.user.id }), { error: 'Not in the call' });
  assert.deepEqual(await emitWithAck(hanaSocket, 'call_chat_send', { text: '   ' }), { error: 'Invalid message' });

  const ivanHears = nextEvent(ivanSocket, 'call_chat_message');
  const outsiderHearsNothing = quietFor(outsiderSocket, 'call_chat_message');
  assert.deepEqual(await emitWithAck(hanaSocket, 'call_chat_send', { text: ' Salam everyone ' }), { ok: true });
  const group = await ivanHears;
  assert.equal(group.text, 'Salam everyone');
  assert.equal(group.from.displayName, 'Hana');
  assert.equal(group.to, null);
  assert.ok(await outsiderHearsNothing);

  // A private message reaches its two people; someone who joins later sees only the group's messages.
  await emitWithAck(jadeSocket, 'voice_join', { channelId: room });
  const jadeHearsNothing = quietFor(jadeSocket, 'call_chat_message');
  const hanaGetsIt = nextEvent(hanaSocket, 'call_chat_message');
  const ivanGetsOwn = nextEvent(ivanSocket, 'call_chat_message');
  assert.deepEqual(await emitWithAck(ivanSocket, 'call_chat_send', { text: 'Just for you', to: hana.user.id }), { ok: true });
  assert.equal((await hanaGetsIt).to.displayName, 'Hana');
  assert.equal((await ivanGetsOwn).text, 'Just for you');
  assert.ok(await jadeHearsNothing);
  const jadeHistory = nextEvent(jadeSocket, 'call_chat_history');
  await emitWithAck(jadeSocket, 'voice_join', { channelId: room, rejoin: true });
  assert.deepEqual((await jadeHistory).messages.map(message => message.text), ['Salam everyone']);
  const hanaBack = nextEvent(hanaSocket, 'call_chat_history');
  await emitWithAck(hanaSocket, 'voice_join', { channelId: room, rejoin: true });
  assert.deepEqual((await hanaBack).messages.map(message => message.text), ['Salam everyone', 'Just for you']);

  // Once everyone has left, the chat is gone, even for the same people coming back.
  await leaveCall(room, hanaSocket, ivanSocket, jadeSocket);
  const fresh = nextEvent(hanaSocket, 'call_chat_history');
  await emitWithAck(hanaSocket, 'voice_join', { channelId: room });
  assert.deepEqual((await fresh).messages, []);
  await leaveCall(room, hanaSocket);
});

test('a person is in one call at a time, and nobody can make, rename or delete channels', async () => {
  const frank = await join('Frank');
  const socket = await connect(frank.token);
  // The friends' server may still have a second call from when channels could be made.
  const lounge = 'f0f0f0f0-0000-4000-8000-00000000a001';
  db.prepare("INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, 'Lounge', 'voice', 99, ?)").run(lounge, Date.now());
  try {
    await emitWithAck(socket, 'voice_join', { channelId: firstChannel('voice') });
    const moved = eventWhere(socket, 'voice_state', state => membersIn(state, lounge).length > 0);
    await emitWithAck(socket, 'voice_join', { channelId: lounge });
    assert.deepEqual((await moved).calls.map(call => call.channelId), [lounge]);
    assert.deepEqual(await emitWithAck(socket, 'voice_join', { channelId: 'not-a-channel' }), { error: 'Unknown channel' });
    for (const event of ['create_channel', 'rename_channel', 'delete_channel']) {
      await assert.rejects(socket.timeout(200).emitWithAck(event, { channelId: lounge, name: 'Mine', kind: 'voice' }));
    }
    await leaveCall(lounge, socket);
  } finally {
    db.prepare('DELETE FROM channels WHERE id = ?').run(lounge);
  }
});

test('a connecting client learns its call, who is online and who is in calls', async () => {
  const gina = await join('Gina');
  const socket = io(baseUrl, { auth: { token: gina.token }, transports: ['websocket'] });
  sockets.push(socket);
  const [presence, channels, voice] = await Promise.all([nextEvent(socket, 'presence_state'), nextEvent(socket, 'channels'), nextEvent(socket, 'voice_state')]);
  assert.ok(presence.users.some(user => user.displayName === 'Gina'));
  assert.ok(channels.channels.length > 0 && channels.channels.every(channel => channel.kind === 'voice'));
  assert.ok(Array.isArray(voice.calls));
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

test('the plain address joins like the invite link only when joining is open', async () => {
  const info = async () => (await fetch(`${baseUrl}/api/server`)).json();
  assert.equal((await info()).invite, undefined);
  const previous = process.env.OPEN_JOIN;
  process.env.OPEN_JOIN = '1';
  try {
    const { invite } = await info();
    assert.equal(invite, '0000');
    assert.equal((await joinRequest({ inviteKey: invite, visitorId: nextVisitorId(), displayName: 'From the address' })).status, 200);
  } finally {
    previous === undefined ? delete process.env.OPEN_JOIN : process.env.OPEN_JOIN = previous;
  }
  assert.equal((await info()).invite, undefined);
});

const createRoom = body => fetch(`${baseUrl}/api/rooms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('a room is made only with the creation key once one is set, and gets its own long invite key', async () => {
  const previous = process.env.ROOM_CREATION_KEY;
  process.env.ROOM_CREATION_KEY = 'owner-only-key';
  try {
    assert.equal((await createRoom({ name: 'Acme' })).status, 403);
    assert.equal((await createRoom({ name: 'Acme', creationKey: 'guess' })).status, 403);
    assert.equal((await createRoom({ name: '   ', creationKey: 'owner-only-key' })).status, 400);
    const made = await createRoom({ name: '  Acme\u202e Ltd ', creationKey: 'OWNER-ONLY-KEY' });
    assert.equal(made.status, 200);
    const room = await made.json();
    assert.equal(room.name, 'Acme Ltd');
    assert.match(room.invite, /^[0-9a-f]{30}$/);
  } finally {
    previous === undefined ? delete process.env.ROOM_CREATION_KEY : process.env.ROOM_CREATION_KEY = previous;
  }
});

test("a room's people see and hear only each other, and never the home room's call", async () => {
  const room = await (await createRoom({ name: 'Bakery' })).json();
  const homeVoice = firstChannel('voice');

  // The welcome screen and the home-screen app are named after the room of the invite.
  assert.equal((await (await fetch(`${baseUrl}/api/server?invite=${room.invite}`)).json()).name, 'Bakery');
  const manifest = await (await fetch(`${baseUrl}/manifest.webmanifest?invite=${room.invite}`)).json();
  assert.equal(manifest.name, 'Bakery');
  assert.equal(manifest.start_url, `/?invite=${room.invite}`);

  const baker = await join('Baker', room.invite.toUpperCase());
  assert.deepEqual(baker.room, { id: room.id, name: 'Bakery' });
  const customer = await join('Customer', room.invite);
  const friend = await join('Home friend');
  const [bakerSocket, customerSocket, friendSocket] = await Promise.all([baker, customer, friend].map(person => connect(person.token)));

  // The room has its own call and nothing else, and its people see only who is online there.
  const channels = await new Promise(resolve => {
    const late = io(baseUrl, { auth: { token: customer.token }, transports: ['websocket'] });
    sockets.push(late);
    late.once('channels', ({ channels: list }) => resolve(list));
  });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].kind, 'voice');
  const roomVoice = channels[0].id;
  const presence = await new Promise(resolve => {
    const late = io(baseUrl, { auth: { token: baker.token }, transports: ['websocket'] });
    sockets.push(late);
    late.once('presence_state', ({ users }) => resolve(users.map(user => user.displayName)));
  });
  assert.ok(presence.includes('Customer'));
  assert.ok(!presence.includes('Home friend'));

  // Nobody reaches the other room's call, even with its channel's ID.
  assert.deepEqual(await emitWithAck(bakerSocket, 'voice_join', { channelId: homeVoice }), { error: 'Unknown channel' });
  assert.deepEqual(await emitWithAck(friendSocket, 'voice_join', { channelId: roomVoice }), { error: 'Unknown channel' });
  assert.equal((await callToken(baker.token, homeVoice)).status, 404);

  const friendHearsNothing = quietFor(friendSocket, 'voice_state');
  const customerSees = eventWhere(customerSocket, 'voice_state', state => membersIn(state, roomVoice).includes('Baker'));
  await emitWithAck(bakerSocket, 'voice_join', { channelId: roomVoice });
  await customerSees;
  assert.ok(await friendHearsNothing);
  const credentials = await (await callToken(baker.token, roomVoice)).json();
  assert.equal(credentials.roomName, `voice-${roomVoice}`);
  assert.equal(jwt.decode(credentials.token).video.room, `voice-${roomVoice}`);

  // The chat and channel features that were removed are gone in every room.
  assert.equal((await fetch(`${baseUrl}/api/search?q=hello`, { headers: auth(baker.token) })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/search?q=hello`, { headers: auth(friend.token) })).status, 404);
  await assert.rejects(friendSocket.timeout(200).emitWithAck('send_message', { conversationId: homeVoice, content: 'Hi', type: 'text' }));
  bakerSocket.emit('voice_leave');
});

test("one person in two rooms' calls at once cannot leave, chat in or raise a hand in one room's call from the other", async () => {
  const room = await (await createRoom({ name: 'Workshop' })).json();
  const visitorId = nextVisitorId();
  const atHome = await (await joinRequest({ inviteKey: '0000', visitorId, displayName: 'Two rooms' })).json();
  const inRoom = await (await joinRequest({ inviteKey: room.invite, visitorId })).json();
  assert.equal(inRoom.user.id, atHome.user.id);
  const friend = await join('Stays home');
  const [homeSocket, roomSocket, friendSocket] = await Promise.all([atHome, inRoom, friend].map(person => connect(person.token)));
  const homeCall = newCall('Kitchen');
  const roomCall = db.prepare('SELECT id FROM channels WHERE room_id = ?').get(room.id).id;
  const { getCall } = await import('../server/voice.ts');

  await emitWithAck(homeSocket, 'voice_join', { channelId: homeCall });
  await emitWithAck(friendSocket, 'voice_join', { channelId: homeCall });
  // Joining the other room's call does not take them out of the home room's call.
  await emitWithAck(roomSocket, 'voice_join', { channelId: roomCall });
  assert.ok(getCall(homeCall).members.has(atHome.user.id));
  assert.ok(getCall(roomCall).members.has(atHome.user.id));

  // The room's session chats only in the room's call, so the home call's friend hears nothing.
  const friendHearsNothing = quietFor(friendSocket, 'call_chat_message');
  assert.deepEqual(await emitWithAck(roomSocket, 'call_chat_send', { text: 'hello', to: friend.user.id }), { error: 'Not in the call' });
  assert.deepEqual(await emitWithAck(roomSocket, 'call_chat_send', { text: 'hello' }), { ok: true });
  assert.ok(await friendHearsNothing);
  assert.equal(getCall(homeCall).chat.length, 0);

  // A hand raised for the home call from the room's session is ignored.
  roomSocket.emit('raise_hand', { channelId: homeCall, raised: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(getCall(homeCall).hands.size, 0);

  // Leaving from the room's session, or losing its connection, leaves only the room's call.
  roomSocket.emit('voice_leave');
  assert.ok(await eventually(() => !getCall(roomCall)));
  await emitWithAck(roomSocket, 'voice_join', { channelId: roomCall });
  roomSocket.disconnect();
  assert.ok(await eventually(() => !getCall(roomCall)));
  assert.ok(getCall(homeCall).members.has(atHome.user.id));
  await leaveCall(homeCall, homeSocket, friendSocket);
});

test("a room's call is announced only to people who joined that room", async () => {
  const room = await (await createRoom({ name: 'Studio' })).json();
  const [host, guest] = [await join('Host', room.invite), await join('Guest', room.invite)];
  const homeFriend = await join('Friend at home');
  const guestSub = browserSubscription('rooms-guest');
  const friendSub = browserSubscription('rooms-friend');
  assert.equal((await subscribe(guest.token, guestSub)).status, 200);
  assert.equal((await subscribe(homeFriend.token, friendSub)).status, 200);

  const hostSocket = await connect(host.token);
  const studio = db.prepare('SELECT id FROM channels WHERE room_id = ?').get(room.id).id;
  await emitWithAck(hostSocket, 'voice_join', { channelId: studio });
  assert.ok(await eventually(() => pushesTo(guestSub).length === 1));
  assert.equal(pushesTo(guestSub)[0].title, 'Host started a call in 🔊 Studio');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(pushesTo(friendSub).length, 0);
  hostSocket.emit('voice_leave');
});

test('sessions from before rooms existed stay in the home room', async () => {
  const friend = await join('Signed in last month');
  // Old sessions carried only the person and the home invite's fingerprint.
  const code = crypto.createHmac('sha256', process.env.JWT_SECRET).update('invite:0000').digest('base64url').slice(0, 22);
  const oldToken = jwt.sign({ userId: friend.user.id, code }, process.env.JWT_SECRET, { expiresIn: '30d' });
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: auth(oldToken) })).status, 200);
  const socket = await connect(oldToken);
  const joined = await emitWithAck(socket, 'voice_join', { channelId: firstChannel('voice') });
  assert.equal(typeof joined.startedAt, 'number');
  socket.emit('voice_leave');
  // A session naming a room that does not exist is refused.
  const madeUp = jwt.sign({ userId: friend.user.id, roomId: 'nowhere', code }, process.env.JWT_SECRET, { expiresIn: '30d' });
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: auth(madeUp) })).status, 401);
});

test("an old database loses its text chat and the chat's files, but keeps people, photos, rooms and calls", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangout-old-'));
  try {
    // The parts of a database from before text chat was removed that matter: people (one with the
    // class app's role column), a room, a picture, a text and a voice channel, messages, files, a
    // recording, reactions and read markers.
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const Database = requireFromRoot('better-sqlite3');
    const old = new Database(path.join(dataDir, 'chat.db'));
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL DEFAULT '#6366f1', status TEXT, last_seen INTEGER, created_at INTEGER, visitor_id TEXT,
        role TEXT NOT NULL DEFAULT 'student', notify_level TEXT NOT NULL DEFAULT 'all');
      CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, created_by TEXT, created_at INTEGER);
      CREATE TABLE conversation_members (conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id), content TEXT, type TEXT NOT NULL DEFAULT 'text', file_url TEXT, file_name TEXT,
        attachment_id TEXT, reply_to TEXT REFERENCES messages(id), edited_at INTEGER, deleted INTEGER DEFAULT 0, created_at INTEGER,
        pinned_at INTEGER, pinned_by TEXT REFERENCES users(id));
      CREATE TABLE message_reads (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        uploader_id TEXT NOT NULL REFERENCES users(id), disk_name TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, duration_ms INTEGER);
      CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, invite_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text', 'voice')),
        position INTEGER NOT NULL, created_at INTEGER NOT NULL, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE);
      CREATE TABLE channel_reads (user_id TEXT NOT NULL REFERENCES users(id), channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        last_read_seq INTEGER NOT NULL);
      CREATE TABLE message_reactions (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
        emoji TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE recordings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), voice_channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL, disk_name TEXT NOT NULL UNIQUE, mime_type TEXT, size INTEGER NOT NULL DEFAULT 0,
        next_chunk INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE room_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), joined_at INTEGER NOT NULL);
      CREATE TABLE avatars (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, data BLOB NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users (id, username, display_name, password_hash, visitor_id) VALUES ('u1', 'amina', 'Amina', 'disabled', '00000000-0000-4000-8000-000000000999');
      INSERT INTO rooms VALUES ('r1', 'Bakery', 'bakerykey123456789', 1);
      INSERT INTO conversations (id, type, name) VALUES ('classroom', 'group', 'general');
      INSERT INTO channels VALUES ('classroom', 'general', 'text', 0, 1, NULL), ('v1', 'General', 'voice', 1, 1, NULL), ('v2', 'Bakery', 'voice', 0, 1, 'r1');
      INSERT INTO messages (id, conversation_id, sender_id, content, created_at) VALUES ('m1', 'classroom', 'u1', 'السلام عليكم', 1);
      INSERT INTO messages (id, conversation_id, sender_id, type, file_url, created_at) VALUES ('m2', 'classroom', 'u1', 'image', '/uploads/0a1b.png', 2);
      INSERT INTO message_reads VALUES ('m1', 'u1');
      INSERT INTO message_reactions VALUES ('m1', 'u1', '👍', 1);
      INSERT INTO channel_reads VALUES ('u1', 'classroom', 1);
      INSERT INTO attachments VALUES ('a1', 'classroom', 'u1', 'sheet-file', 'Lesson 1.pdf', 'application/pdf', 10, 1, NULL);
      INSERT INTO recordings VALUES ('rec1', 'u1', 'v1', 'General', 'lesson-recording', 'video/webm', 5, 1, 1, 1, 1);
      INSERT INTO app_settings VALUES ('reads_started', '1'), ('room_members_started', '1'), ('vapid', 'kept');
      INSERT INTO room_members VALUES ('home', 'u1', 1), ('r1', 'u1', 1);
      INSERT INTO avatars VALUES ('p1', 'u1', x'ffd8ff', 1);
    `);
    old.close();
    const uploads = path.join(dataDir, 'uploads');
    fs.mkdirSync(uploads);
    for (const name of ['sheet-file', 'lesson-recording', '0a1b.png', 'not-from-the-chat.txt']) fs.writeFileSync(path.join(uploads, name), 'x');

    const script = `const loaded = (await import('./server/database.ts')).default; const db = loaded.default ?? loaded;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
      console.log(JSON.stringify({
        tables,
        channels: db.prepare('SELECT id, kind, room_id FROM channels ORDER BY id').all(),
        users: db.prepare('SELECT id, visitor_id FROM users').all(),
        rooms: db.prepare('SELECT id FROM rooms').all(),
        members: db.prepare('SELECT room_id FROM room_members ORDER BY room_id').all().map(row => row.room_id),
        avatars: db.prepare('SELECT id FROM avatars').all().map(row => row.id),
        settings: db.prepare('SELECT key FROM app_settings ORDER BY key').all().map(row => row.key),
        foreignKeyProblems: db.pragma('foreign_key_check').length,
      }));`;
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout.trim().split('\n').pop());
    for (const gone of ['messages', 'message_reads', 'message_reactions', 'channel_reads', 'attachments', 'recordings', 'conversations', 'conversation_members']) {
      assert.ok(!result.tables.includes(gone), gone);
    }
    assert.deepEqual(result.channels, [{ id: 'v1', kind: 'voice', room_id: null }, { id: 'v2', kind: 'voice', room_id: 'r1' }]);
    assert.deepEqual(result.users, [{ id: 'u1', visitor_id: '00000000-0000-4000-8000-000000000999' }]);
    assert.deepEqual(result.rooms, [{ id: 'r1' }]);
    assert.deepEqual(result.members, ['home', 'r1']);
    assert.deepEqual(result.avatars, ['p1']);
    assert.deepEqual(result.settings, ['room_members_started', 'vapid']);
    assert.equal(result.foreignKeyProblems, 0);
    // The chat's files are deleted; anything else in the folder is left alone.
    assert.deepEqual(fs.readdirSync(uploads), ['not-from-the-chat.txt']);
    assert.match(first.stdout, /Deleted 3 old chat files/);
    // The copy made before the change still has everything.
    const [before] = fs.readdirSync(path.join(dataDir, 'backups')).filter(name => name.includes('-before-v'));
    const copy = new Database(path.join(dataDir, 'backups', before), { readonly: true });
    assert.equal(copy.prepare('SELECT content FROM messages WHERE id = ?').get('m1').content, 'السلام عليكم');
    copy.close();

    // Starting again changes nothing.
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout.trim().split('\n').pop()), result);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the class app's database gets the home room's call when Hangout first starts on its server", () => {
  const classDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangout-class-'));
  try {
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const Database = requireFromRoot('better-sqlite3');
    const classDb = new Database(path.join(classDir, 'chat.db'));
    classDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL DEFAULT '#6366f1', status TEXT, last_seen INTEGER, created_at INTEGER, visitor_id TEXT,
        role TEXT NOT NULL DEFAULT 'student', removed_at INTEGER);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, created_by TEXT, created_at INTEGER);
      INSERT INTO conversations (id, type, name) VALUES ('classroom', 'group', 'Classroom');
      INSERT INTO users (id, username, display_name, password_hash, visitor_id) VALUES ('u1', 'amina', 'Amina', 'disabled', '00000000-0000-4000-8000-000000000999');
    `);
    classDb.close();
    const script = `const loaded = (await import('./server/database.ts')).default; const db = loaded.default ?? loaded;
      console.log(JSON.stringify({
        channels: db.prepare('SELECT name, kind, room_id FROM channels').all(),
        members: db.prepare('SELECT room_id, user_id FROM room_members').all(),
        notifyLevel: db.prepare('SELECT notify_level FROM users').get().notify_level,
      }));`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATA_DIR: classDir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), {
      channels: [{ name: 'General', kind: 'voice', room_id: null }],
      members: [{ room_id: 'home', user_id: 'u1' }],
      notifyLevel: 'all',
    });
  } finally {
    fs.rmSync(classDir, { recursive: true, force: true });
  }
});

test('the database is copied before its schema changes and at every start, keeping a week of routine copies', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangout-backups-'));
  try {
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const Database = requireFromRoot('better-sqlite3');
    // A database from before the schema steps were numbered.
    const old = new Database(path.join(dataDir, 'chat.db'));
    old.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_settings VALUES ('kept', 'yes');");
    old.close();
    const script = `const loaded = (await import('./server/database.ts')).default; const db = loaded.default ?? loaded;
      console.log(JSON.stringify({ version: db.pragma('user_version', { simple: true }) }));`;
    const run = () => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir },
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim().split('\n').pop());
    };
    const backups = () => fs.readdirSync(path.join(dataDir, 'backups')).sort();
    const { version } = run();
    assert.ok(version >= 1);
    const [beforeChange] = backups();
    assert.match(beforeChange, new RegExp(`-before-v${version}\\.db$`));
    // The copy is a working database holding what was there before.
    const copy = new Database(path.join(dataDir, 'backups', beforeChange), { readonly: true });
    assert.equal(copy.prepare("SELECT value FROM app_settings WHERE key = 'kept'").get().value, 'yes');
    assert.equal(copy.pragma('user_version', { simple: true }), 0);
    copy.close();
    for (let start = 0; start < 9; start++) assert.equal(run().version, version);
    const after = backups();
    assert.equal(after.filter(name => name.endsWith('-startup.db')).length, 7);
    assert.ok(after.includes(beforeChange));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
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

test('a burst of events is refused with an error instead of disconnecting', async () => {
  const student = await join('Fast clicker');
  const socket = await connect(student.token);
  for (let event = 0; event < 130; event++) socket.emit('app_active', { active: false });
  assert.deepEqual(await emitWithAck(socket, 'app_active', { active: false }), { error: 'Too many requests' });
  assert.equal(socket.connected, true);
});

test('friends who are away are notified of calls, as each of them chose', async () => {
  // A room of their own, so no earlier test has already announced its call.
  const room = await (await createRoom({ name: 'Lesson' })).json();
  const [salma, amal, hind, qasim, omar] = await Promise.all(['Salma', 'Away Amal', 'Here Hind', 'Quiet Qasim', 'Off Omar'].map(name => join(name, room.invite)));
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

  // Hind has the app in front of her, so she sees the call there instead.
  const hindSocket = await connect(hind.token);
  assert.deepEqual(await emitWithAck(hindSocket, 'app_active', { active: true }), { ok: true });
  const salmaSocket = await connect(salma.token);

  // Starting a call tells those who want calls, once, however often people hop in and out.
  const lesson = db.prepare('SELECT id FROM channels WHERE room_id = ?').get(room.id).id;
  await emitWithAck(salmaSocket, 'voice_join', { channelId: lesson });
  assert.ok(await eventually(() => pushesTo(subs.qasim).length === 1 && pushesTo(subs.amal).length === 1));
  assert.deepEqual(pushesTo(subs.amal)[0], {
    title: 'Salma started a call in 🔊 Lesson', body: '', tag: `channel-${lesson}`, channelId: lesson, url: `/?channel=${lesson}`,
  });
  // Someone who chose "mentions" still hears about calls, in the language their device uses.
  assert.equal(pushesTo(subs.qasim)[0].title, 'Salma بدأ مكالمة في 🔊 Lesson');
  // Notices of one call share a topic, so a phone that was offline gets only the latest.
  const amalRequest = pushService.received.find(entry => entry.name === 'levels-amal');
  assert.equal(amalRequest.headers.topic.length, 32);
  assert.equal(amalRequest.headers.urgency, 'high');
  const [, vapidPass] = /^vapid t=([^,]+), k=.+/.exec(amalRequest.headers.authorization);
  assert.equal(jwt.decode(vapidPass).sub, 'https://majlis.test');
  salmaSocket.emit('voice_leave');
  await emitWithAck(salmaSocket, 'voice_join', { channelId: lesson });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(pushesTo(subs.amal).length, 1);

  // The starter, the person looking at the app and the person who turned notifications off were
  // never notified.
  assert.equal(pushesTo(subs.salma).length, 0);
  assert.equal(pushesTo(subs.hind).length, 0);
  assert.equal(pushesTo(subs.omar).length, 0);
  salmaSocket.emit('voice_leave');
});

test('a device the push service no longer knows is forgotten, and bad subscriptions are refused', async () => {
  const call = newCall('Forgotten');
  const [layla, musa] = await Promise.all([join('Layla'), join('Musa')]);
  const gone = browserSubscription('gone-layla');
  pushService.gone.add('gone-layla');
  assert.equal((await subscribe(layla.token, gone)).status, 200);
  const stored = endpoint => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(endpoint).n;
  assert.equal(stored(gone.endpoint), 1);
  const socket = await connect(musa.token);
  await emitWithAck(socket, 'voice_join', { channelId: call });
  assert.ok(await eventually(() => stored(gone.endpoint) === 0));
  await leaveCall(call, socket);

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
  const general = newCall('Corner');
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
    await emitWithAck(socket, 'voice_join', { channelId: general });
    const devices = () => db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(rami.user.id).map(row => row.endpoint).sort();
    assert.ok(await eventually(() => firebase.messages.length === 2 && appleRequests.length === 2 && devices().length === 2));
    // Uninstalled apps are forgotten.
    assert.deepEqual(devices(), [iphone, android].sort());
    assert.equal(firebase.passes, 1);

    const toAndroid = firebase.messages.find(message => message.token === android);
    assert.equal(toAndroid.url, '/v1/projects/majlis-test/messages:send');
    assert.equal(toAndroid.authorization, 'Bearer firebase-access');
    assert.deepEqual(toAndroid.notification, { title: 'Nour started a call in 🔊 Corner', body: '' });
    assert.deepEqual(toAndroid.data, { channelId: general });
    assert.deepEqual(toAndroid.android.notification, { tag: `channel-${general}`, channel_id: 'messages' });

    const toIphone = appleRequests.find(request => request.headers[':path'] === `/3/device/${iphone}`);
    assert.equal(toIphone.headers['apns-topic'], 'com.samycc777.majlis');
    assert.equal(toIphone.headers['apns-collapse-id'], `channel-${general}`);
    const pass = jwt.verify(toIphone.headers.authorization.replace('bearer ', ''), apple.publicKey, { algorithms: ['ES256'], complete: true });
    assert.deepEqual([pass.header.kid, pass.payload.iss], ['KEY1234567', 'TEAM123456']);
    assert.deepEqual(toIphone.body, {
      aps: { alert: { title: 'Nour started a call in 🔊 Corner', body: '' }, sound: 'default', 'thread-id': general }, channelId: general,
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
