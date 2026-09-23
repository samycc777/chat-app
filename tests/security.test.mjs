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
function nextVisitorId() {
  return `00000000-0000-4000-8000-${String(visitorSequence++).padStart(12, '0')}`;
}
function joinRequest(body) {
  return fetch(`${baseUrl}/api/auth/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
async function join(displayName, classCode = '0000') {
  const response = await joinRequest({ classCode, visitorId: nextVisitorId(), displayName });
  assert.equal(response.status, 200);
  return response.json();
}
const joinTeacher = displayName => join(displayName, 'teacher');
const emitWithAck = (socket, event, data) => new Promise(resolve => socket.emit(event, data, resolve));
const nextEvent = (socket, event) => new Promise(resolve => socket.once(event, resolve));
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
  const alice = await joinTeacher('Alice');
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

  const aliceStarted = nextEvent(aliceSocket, 'wb_started');
  const bobStarted = nextEvent(bobSocket, 'wb_started');
  aliceSocket.emit('wb_start', { conversationId });
  const [aliceSession, bobSession] = await Promise.all([aliceStarted, bobStarted]);
  assert.equal(aliceSession.presenterId, alice.user.id);
  assert.equal(bobSession.presenterId, alice.user.id);
  assert.deepEqual(await emitWithAck(bobSocket, 'wb_start', { conversationId }), { error: 'Only the teacher can start a lesson' });

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
  const presenterClaims = jwt.decode(presenterCredentials.token);
  assert.equal(presenterClaims.attributes.role, 'teacher');
  const presenterGrant = presenterClaims.video;
  assert.equal(presenterGrant.room, presenterCredentials.roomName);
  assert.equal(presenterGrant.canPublishData, true);
  assert.equal(typeof presenterCredentials.startedAt, 'number');
  assert.deepEqual(presenterGrant.canPublishSources.sort(), ['microphone', 'screen_share']);
  const studentMedia = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { ...auth(bob.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  });
  assert.equal(studentMedia.status, 200);
  const studentClaims = jwt.decode((await studentMedia.json()).token);
  assert.equal(studentClaims.attributes.role, 'student');
  assert.deepEqual(studentClaims.video.canPublishSources, ['microphone']);
  for (const [key, value] of Object.entries(previousLiveKit)) value === undefined ? delete process.env[key] : process.env[key] = value;

  const unauthorizedEnd = quietFor(aliceSocket, 'wb_ended');
  bobSocket.emit('wb_end', { conversationId });
  assert.equal(await unauthorizedEnd, true);
  const presenterSawEnd = nextEvent(aliceSocket, 'wb_ended');
  aliceSocket.emit('wb_end', { conversationId });
  await presenterSawEnd;
  const endedMedia = await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { ...auth(alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  });
  assert.equal(endedMedia.status, 409);
});

test('only the teacher starts lessons, and a second teacher device takes the lesson over', async () => {
  const conversationId = 'classroom';
  const teacherPhone = await joinTeacher('Teacher phone');
  const teacherLaptop = await joinTeacher('Teacher laptop');
  const student = await join('Student');
  const [phoneSocket, laptopSocket, studentSocket] = await Promise.all([teacherPhone, teacherLaptop, student].map(member => connect(member.token)));
  const credentials = async token => (await fetch(`${baseUrl}/api/livekit/token`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }),
  })).json();
  const previousLiveKit = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { LIVEKIT_URL: 'wss://test.livekit.cloud', LIVEKIT_API_KEY: 'test-key', LIVEKIT_API_SECRET: 'test-secret' });
  try {
    assert.deepEqual(await emitWithAck(studentSocket, 'wb_start', { conversationId }), { error: 'Only the teacher can start a lesson' });
    const studentSawLesson = nextEvent(studentSocket, 'wb_started');
    assert.deepEqual(await emitWithAck(phoneSocket, 'wb_start', { conversationId }), { presenterId: teacherPhone.user.id });
    assert.equal((await studentSawLesson).presenterId, teacherPhone.user.id);
    assert.deepEqual(await emitWithAck(phoneSocket, 'wb_start', { conversationId }), { presenterId: teacherPhone.user.id });
    const firstRoom = (await credentials(teacherPhone.token)).roomName;

    const ended = nextEvent(studentSocket, 'wb_ended');
    const restarted = nextEvent(studentSocket, 'wb_started');
    assert.deepEqual(await emitWithAck(laptopSocket, 'wb_start', { conversationId }), { presenterId: teacherLaptop.user.id });
    await ended;
    assert.equal((await restarted).presenterId, teacherLaptop.user.id);
    const laptopCredentials = await credentials(teacherLaptop.token);
    assert.notEqual(laptopCredentials.roomName, firstRoom);
    assert.ok(jwt.decode(laptopCredentials.token).video.canPublishSources.includes('screen_share'));
    assert.deepEqual(jwt.decode((await credentials(teacherPhone.token)).token).video.canPublishSources, ['microphone']);

    const studentCannotEnd = quietFor(laptopSocket, 'wb_ended');
    studentSocket.emit('wb_end', { conversationId });
    assert.equal(await studentCannotEnd, true);
    const endedByOtherTeacher = nextEvent(studentSocket, 'wb_ended');
    phoneSocket.emit('wb_end', { conversationId });
    await endedByOtherTeacher;
  } finally {
    for (const [key, value] of Object.entries(previousLiveKit)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('the teacher can delete any message, students only their own, and deleted text stays hidden', async () => {
  const conversationId = 'classroom';
  const teacher = await joinTeacher('Moderator');
  const student = await join('Talkative');
  const classmate = await join('Classmate');
  const [teacherSocket, studentSocket, classmateSocket] = await Promise.all([teacher, student, classmate].map(member => connect(member.token)));
  const auth = { Authorization: `Bearer ${classmate.token}` };

  const { id: rude } = await emitWithAck(studentSocket, 'send_message', { conversationId, content: 'something rude', type: 'text' });
  const { id: reply } = await emitWithAck(classmateSocket, 'send_message', { conversationId, content: 'what?', type: 'text', replyTo: rude });
  const { id: teacherNote } = await emitWithAck(teacherSocket, 'send_message', { conversationId, content: 'Homework: page 12', type: 'text' });

  const notDeleted = quietFor(teacherSocket, 'message_deleted');
  classmateSocket.emit('delete_message', { messageId: teacherNote });
  assert.equal(await notDeleted, true);
  const deleted = nextEvent(classmateSocket, 'message_deleted');
  teacherSocket.emit('delete_message', { messageId: rude });
  assert.equal((await deleted).messageId, rude);

  const history = await (await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, { headers: auth })).json();
  const byId = Object.fromEntries(history.map(message => [message.id, message]));
  assert.equal(byId[rude].deleted, true);
  assert.equal(byId[rude].content, null);
  assert.equal(byId[reply].replyTo.content, null);
  assert.equal(byId[reply].replyTo.deleted, true);
  assert.equal(byId[teacherNote].content, 'Homework: page 12');
  assert.equal(byId[teacherNote].sender.role, 'teacher');
  assert.equal(byId[reply].sender.role, 'student');
  assert.ok(!JSON.stringify(history).includes('something rude'));

  const unchanged = quietFor(studentSocket, 'message_edited');
  studentSocket.emit('edit_message', { messageId: rude, content: 'revived' });
  classmateSocket.emit('edit_message', { messageId: reply, content: '   ' });
  assert.equal(await unchanged, true);
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

test('the class code admits students, the teacher code admits the teacher, and names are cleaned', async () => {
  const student = await joinRequest({ classCode: ' ٠٠٠٠ ', visitorId: nextVisitorId(), displayName: 'Arabic digits' });
  assert.equal(student.status, 200);
  assert.equal((await student.json()).user.role, 'student');
  const visitorId = nextVisitorId();
  const teacher = await joinRequest({ classCode: 'TEACHER', visitorId, displayName: '  Ustadh\u202e  Ahmad ' });
  assert.equal(teacher.status, 200);
  const teacherSession = await teacher.json();
  assert.equal(teacherSession.user.role, 'teacher');
  assert.equal(teacherSession.user.displayName, 'Ustadh Ahmad');
  const me = await (await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${teacherSession.token}` } })).json();
  assert.equal(me.role, 'teacher');

  // Joining again with the class code turns the same browser back into a student and retires the teacher session.
  const demoted = await (await joinRequest({ classCode: '0000', visitorId })).json();
  assert.equal(demoted.user.role, 'student');
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${teacherSession.token}` } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${demoted.token}` } })).status, 200);
});

test('changing the class code signs out students who have not entered the new code', async () => {
  const student = await join('Before the change');
  const teacher = await joinTeacher('Unaffected teacher');
  const me = token => fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  const previous = process.env.CLASS_CODE;
  process.env.CLASS_CODE = '246810';
  try {
    assert.equal((await me(student.token)).status, 401);
    assert.equal((await me(teacher.token)).status, 200);
    await assert.rejects(connect(student.token));
    assert.equal((await joinRequest({ classCode: '0000', visitorId: nextVisitorId(), displayName: 'Old code' })).status, 401);
    const rejoined = await join('After the change', '246810');
    assert.equal((await me(rejoined.token)).status, 200);
  } finally {
    previous === undefined ? delete process.env.CLASS_CODE : process.env.CLASS_CODE = previous;
  }
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

// Runs last because it deliberately locks this test client's address out of joining.
test('repeated wrong codes lock the address out briefly, even for the right code', async () => {
  // Earlier tests already spent some of this minute's wrong attempts.
  const statuses = [];
  for (let attempt = 0; attempt < 10 && statuses.at(-1) !== 429; attempt++) {
    statuses.push((await joinRequest({ classCode: `wrong-${attempt}`, visitorId: nextVisitorId(), displayName: 'Guesser' })).status);
  }
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.slice(0, -1).every(status => status === 401));
  const lockedOut = await joinRequest({ classCode: '0000', visitorId: nextVisitorId(), displayName: 'Guesser' });
  assert.equal(lockedOut.status, 429);
  assert.ok(Number(lockedOut.headers.get('retry-after')) > 0);
});
