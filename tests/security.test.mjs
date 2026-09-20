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

async function register(username) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, displayName: username, password: 'correct-horse-battery-staple' }),
  });
  assert.equal(response.status, 201);
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

test('conversation members can fetch attachments and outsiders cannot', async () => {
  const alice = await register('alice_test');
  const bob = await register('bob_test');
  const eve = await register('eve_test');
  const auth = token => ({ Authorization: `Bearer ${token}` });
  const created = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers: { ...auth(alice.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'direct', memberIds: [bob.user.id] }),
  });
  assert.equal(created.status, 201);
  const { id: conversationId } = await created.json();

  const form = new FormData();
  form.append('conversationId', conversationId);
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F+4AAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'tiny.png');
  const uploaded = await fetch(`${baseUrl}/api/upload`, { method: 'POST', headers: auth(alice.token), body: form });
  assert.equal(uploaded.status, 200);
  const { attachmentId } = await uploaded.json();
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth(bob.token) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/attachments/${attachmentId}`, { headers: auth(eve.token) })).status, 404);
  assert.equal((await fetch(`${baseUrl}/uploads/${attachmentId}`, { headers: auth(eve.token) })).status, 404);

  const [aliceSocket, , eveSocket] = await Promise.all([
    connect(alice.token), connect(bob.token), connect(eve.token),
  ]);
  eveSocket.emit('join_conversation', { conversationId });
  const outsiderMessage = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 150);
    eveSocket.once('new_message', () => { clearTimeout(timer); resolve(true); });
  });
  const ack = await new Promise(resolve => aliceSocket.emit('send_message', {
    conversationId, content: 'member message', type: 'text',
  }, resolve));
  assert.ok(ack.id);
  assert.equal(await outsiderMessage, false);

  let unauthorizedCallReceived = false;
  aliceSocket.once('incoming_call', () => { unauthorizedCallReceived = true; });
  eveSocket.emit('call_user', {
    targetUserId: alice.user.id, conversationId, offer: { type: 'offer', sdp: 'invalid' }, callType: 'audio',
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(unauthorizedCallReceived, false);
});

test('conversation creation rejects unknown and repeated members', async () => {
  const user = await register('charlie_test');
  const headers = { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' };
  const unknown = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers, body: JSON.stringify({ type: 'group', memberIds: ['missing'], name: 'group' }),
  });
  assert.equal(unknown.status, 400);
  const repeated = await fetch(`${baseUrl}/api/conversations`, {
    method: 'POST', headers, body: JSON.stringify({ type: 'group', memberIds: [user.user.id, user.user.id], name: 'group' }),
  });
  assert.equal(repeated.status, 400);
});
