import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
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

let visitorSequence = 1;
async function join(displayName) {
  const n = String(visitorSequence++).padStart(12, '0');
  const visitorId = `00000000-0000-4000-8000-${n}`;
  const response = await fetch(`${baseUrl}/api/auth/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classCode: '0000', visitorId, displayName }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-app-security-'));
  process.env.NODE_ENV = 'test';
  process.env.DATA_DIR = tempDir;
  process.env.JWT_SECRET = 'test-only-signing-secret-that-is-long-enough';
  const serverModule = await import('../server/index.ts');
  appServer = serverModule.server;
  await new Promise(resolve => appServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
  ({ default: db } = await import('../server/database.ts'));
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  if (appServer?.listening) await new Promise(resolve => appServer.close(resolve));
  db?.close();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('classroom members can fetch attachments and unadmitted users cannot', async () => {
  const alice = await join('Alice');
  const bob = await join('Bob');
  const conversationId = 'classroom';
  const auth = token => ({ Authorization: `Bearer ${token}` });
  const form = new FormData();
  form.append('conversationId', conversationId);
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F+4AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'tiny.png');
  const uploaded = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(alice.token), body: form });
  assert.equal(uploaded.status, 200);
  const { attachmentId } = await uploaded.json();
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth(bob.token) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth('invalid') })).status, 401);
  assert.equal((await fetch(`${baseUrl}/uploads/${attachmentId}`, { headers: auth('invalid') })).status, 404);

  const [aliceSocket, bobSocket] = await Promise.all([connect(alice.token), connect(bob.token)]);
  const outsiderMessage = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 150);
    bobSocket.once('new_message', () => { clearTimeout(timer); resolve(true); });
  });
  const ack = await new Promise(resolve => aliceSocket.emit('send_message', {
    conversationId, content: 'member message', type: 'text',
  }, resolve));
  assert.ok(ack.id);
  assert.equal(await outsiderMessage, true);
  const rooms = await fetch(`${baseUrl}/api/conversations`, { headers: auth(alice.token) });
  assert.equal(rooms.status, 200);
  assert.deepEqual((await rooms.json()).map(room => room.id), [conversationId]);
  assert.equal((await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: { ...auth(alice.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'direct', memberIds: [bob.user.id] }),
  })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/conversations/not-the-classroom/messages`, { headers: auth(alice.token) })).status, 403);

  const aliceStarted = new Promise(resolve => aliceSocket.once('wb_started', resolve));
  const bobStarted = new Promise(resolve => bobSocket.once('wb_started', resolve));
  aliceSocket.emit('wb_start', { conversationId });
  const [aliceSession, bobSession] = await Promise.all([aliceStarted, bobStarted]);
  assert.equal(aliceSession.presenterId, alice.user.id);
  assert.equal(bobSession.presenterId, alice.user.id);
  bobSocket.emit('wb_start', { conversationId });
  const state = new Promise(resolve => bobSocket.once('wb_state', resolve));
  bobSocket.emit('wb_get_state', { conversationId });
  assert.equal((await state).presenterId, alice.user.id);

  const previousLiveKit = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  assert.equal((await fetch(`${baseUrl}/api/livekit/token`)).status, 401);
  const unavailableMedia = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { ...auth(alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  });
  assert.equal(unavailableMedia.status, 503);
  process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
  process.env.LIVEKIT_API_KEY = 'test-key';
  process.env.LIVEKIT_API_SECRET = 'test-secret';
  const presenterMedia = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { ...auth(alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  });
  assert.equal(presenterMedia.status, 200);
  const presenterCredentials = await presenterMedia.json();
  assert.equal(presenterCredentials.url, process.env.LIVEKIT_URL);
  assert.ok(presenterCredentials.encryptionKey.length >= 32);
  const presenterGrant = jwt.decode(presenterCredentials.token).video;
  assert.equal(presenterGrant.room, presenterCredentials.roomName);
  assert.equal(presenterGrant.canPublishData, true);
  assert.equal(typeof presenterCredentials.startedAt, 'number');
  assert.deepEqual(presenterGrant.canPublishSources.sort(), ['microphone', 'screen_share']);
  const studentMedia = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { ...auth(bob.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  });
  assert.equal(studentMedia.status, 200);
  const studentGrant = jwt.decode((await studentMedia.json()).token).video;
  assert.notDeepEqual(studentGrant.canPublishSources.sort(), presenterGrant.canPublishSources.sort());
  for (const [key, value] of Object.entries(previousLiveKit)) value === undefined ? delete process.env[key] : process.env[key] = value;

  let unauthorizedEnd = false;
  aliceSocket.once('wb_ended', () => { unauthorizedEnd = true; });
  bobSocket.emit('wb_end', { conversationId });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(unauthorizedEnd, false);
  aliceSocket.emit('wb_end', { conversationId });
  await new Promise(resolve => setTimeout(resolve, 30));
  const endedMedia = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { ...auth(alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  });
  assert.equal(endedMedia.status, 409);
});

test('a lesson abandoned by a disconnected presenter can be restarted by another member', async () => {
  const conversationId = 'classroom';
  const teacher = await join('Teacher');
  const substitute = await join('Substitute');
  const student = await join('Student');
  const [teacherSocket, substituteSocket, studentSocket] = await Promise.all([teacher, substitute, student].map(member => connect(member.token)));
  const start = socket => new Promise(resolve => socket.emit('wb_start', { conversationId }, resolve));
  const credentials = async token => (await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  })).json();
  const previousLiveKit = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { LIVEKIT_URL: 'wss://test.livekit.cloud', LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret' });
  try {
    const studentSawLesson = new Promise(resolve => studentSocket.once('wb_started', resolve));
    assert.equal((await start(teacherSocket)).presenterId, teacher.user.id);
    await studentSawLesson;
    const abandonedRoom = (await credentials(teacher.token)).roomName;
    assert.equal((await start(substituteSocket)).presenterId, teacher.user.id);

    const teacherOffline = new Promise(resolve => studentSocket.on('presence', event => {
      if (event.userId === teacher.user.id && !event.online) resolve();
    }));
    teacherSocket.disconnect();
    await teacherOffline;
    const ended = new Promise(resolve => studentSocket.once('wb_ended', resolve));
    const restarted = new Promise(resolve => studentSocket.once('wb_started', resolve));
    assert.equal((await start(substituteSocket)).presenterId, substitute.user.id);
    await ended;
    assert.equal((await restarted).presenterId, substitute.user.id);
    const substituteCredentials = await credentials(substitute.token);
    assert.notEqual(substituteCredentials.roomName, abandonedRoom);
    assert.ok(jwt.decode(substituteCredentials.token).video.canPublishSources.includes('screen_share'));
    substituteSocket.emit('wb_end', { conversationId });
  } finally {
    for (const [key, value] of Object.entries(previousLiveKit)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('large PDFs up to the 100 MB default upload limit are accepted', async () => {
  const user = await join('Large PDF');
  const auth = { Authorization: `Bearer ${user.token}` };
  const pdf = Buffer.alloc(Math.floor(12.8 * 1024 * 1024));
  pdf.write('%PDF-1.7');
  const form = new FormData();
  form.append('conversationId', 'classroom');
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'large-class.pdf');
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
  form.append('conversationId', 'classroom');
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

test('class code is required and the display name is restored from browser identity', async () => {
  const rejected = await fetch(`${baseUrl}/api/auth/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classCode: '9999', visitorId: '00000000-0000-4000-8000-000000000001', displayName: 'Eve' }),
  });
  assert.equal(rejected.status, 401);
  const visitorId = '00000000-0000-4000-8000-000000000002';
  const initial = await fetch(`${baseUrl}/api/auth/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classCode: '0000', visitorId, displayName: 'Charlie' }),
  });
  assert.equal((await initial.json()).user.displayName, 'Charlie');
  const restored = await fetch(`${baseUrl}/api/auth/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classCode: '0000', visitorId }),
  });
  assert.equal((await restored.json()).user.displayName, 'Charlie');
});
