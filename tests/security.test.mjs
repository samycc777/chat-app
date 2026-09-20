import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  let unauthorizedEnd = false;
  aliceSocket.once('wb_ended', () => { unauthorizedEnd = true; });
  bobSocket.emit('wb_end', { conversationId });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(unauthorizedEnd, false);
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

test('ICE configuration requires authentication and rejects incomplete TURN settings', async () => {
  const user = await join('ICE Config');
  assert.equal((await fetch(`${baseUrl}/api/ice-config`)).status, 401);
  const original = {
    urls: process.env.TURN_URLS,
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  };
  try {
    process.env.TURN_URLS = 'turn:relay.example:3478';
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
    const invalid = await fetch(`${baseUrl}/api/ice-config`, { headers: { Authorization: `Bearer ${user.token}` } });
    assert.equal(invalid.status, 503);
    process.env.TURN_USERNAME = 'test-user';
    process.env.TURN_CREDENTIAL = 'test-secret';
    const configured = await fetch(`${baseUrl}/api/ice-config`, { headers: { Authorization: `Bearer ${user.token}` } });
    assert.equal(configured.status, 200);
    const body = await configured.json();
    assert.equal(body.iceServers.at(-1).urls[0], 'turn:relay.example:3478');
    assert.equal(body.iceServers.at(-1).username, 'test-user');
    assert.equal(body.iceServers.at(-1).credential, 'test-secret');
  } finally {
    for (const [key, value] of Object.entries({ TURN_URLS: original.urls, TURN_USERNAME: original.username, TURN_CREDENTIAL: original.credential })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
