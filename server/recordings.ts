import express, { Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import db from './database';
import { AuthRequest } from './auth';
import { detectMime } from './attachments';
import { getChannel, isTextChannel, listChannels } from './channels';
import { maxRecordingBytes, UPLOADS_DIR } from './config';
import { messageById } from './messages';
import { allCalls, getCall } from './voice';

// A call is recorded in the browser of whoever pressed Record (LiveKit's own recording stays off),
// and uploaded in pieces while it is made, so a browser that crashes loses at most the last piece.
// Posting turns the file into an ordinary attachment with a message in the chosen text channel.

/** Each piece is a few seconds of video; this is far more than a piece ever needs. */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** A recording that hears nothing for this long is posted for its recorder, so a lesson is never lost. */
export const IDLE_RECORDING_MS = 15 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const MAX_DURATION_MS = 12 * 3600_000;

interface RecordingRow {
  id: string; user_id: string; voice_channel_id: string; channel_name: string; disk_name: string;
  mime_type: string | null; size: number; next_chunk: number; stopped: number; started_at: number; updated_at: number;
}

// The socket layer tells everyone about changes; it registers itself here when the server starts.
type Hooks = { voiceChanged: () => void; messagePosted: (message: unknown) => void };
let hooks: Hooks = { voiceChanged: () => {}, messagePosted: () => {} };
let sweepTimer: ReturnType<typeof setInterval> | undefined;

export function connectRecordings(next: Hooks) {
  hooks = next;
  // Recordings left unfinished by a server restart are picked up here: those already quiet for long
  // enough are posted now, and the rest once they have been quiet for as long, unless their
  // recorder carries on uploading.
  sweepIdleRecordings();
  clearInterval(sweepTimer);
  sweepTimer = setInterval(() => sweepIdleRecordings(), SWEEP_EVERY_MS);
  sweepTimer.unref();
}

const recordingQuery = db.prepare('SELECT * FROM recordings WHERE id = ?');
const findRecording = (id: unknown) => (typeof id === 'string' ? recordingQuery.get(id) as RecordingRow | undefined : undefined);
const diskPath = (recording: RecordingRow) => path.join(UPLOADS_DIR, recording.disk_name);

/** Takes the red Recording badge off the call that shows this recording. */
function clearBadge(recordingId: string) {
  const call = allCalls().find(listed => listed.recording?.id === recordingId);
  if (!call) return;
  call.recording = undefined;
  hooks.voiceChanged();
}

// The name says what the file is when it is saved to a phone, such as "Recording of Lesson –
// 26 Sept 2026.webm"; the recorder's app sends it in their own language.
function fileNameFor(recording: RecordingRow, requested: unknown) {
  const extension = recording.mime_type === 'video/mp4' ? '.mp4' : '.webm';
  const cleaned = typeof requested === 'string'
    ? path.basename(requested.replace(/[\\/]/g, '_')).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').replace(/\.(webm|mp4)$/i, '').trim().slice(0, 170)
    : '';
  const date = new Date(recording.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${cleaned || `Recording of ${recording.channel_name} – ${date}`}${extension}`;
}

function finish(recording: RecordingRow, textChannelId: string, durationMs: unknown, requestedName?: unknown) {
  const measured = Number(durationMs);
  const duration = Number.isSafeInteger(measured) && measured > 0 && measured <= MAX_DURATION_MS
    ? measured
    : Math.min(MAX_DURATION_MS, Math.max(1, recording.updated_at - recording.started_at));
  const name = fileNameFor(recording, requestedName);
  const attachmentId = uuid();
  const messageId = uuid();
  const now = Date.now();
  // Posted like any file shared in the chat, from the person who recorded it.
  db.transaction(() => {
    db.prepare('INSERT INTO attachments (id, conversation_id, uploader_id, disk_name, original_name, mime_type, size, created_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(attachmentId, textChannelId, recording.user_id, recording.disk_name, name, recording.mime_type, recording.size, now, duration);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, content, type, file_url, file_name, reply_to, created_at, attachment_id)
      VALUES (?, ?, ?, ?, 'file', NULL, ?, NULL, ?, ?)
    `).run(messageId, textChannelId, recording.user_id, name, name, now, attachmentId);
    db.prepare('DELETE FROM recordings WHERE id = ?').run(recording.id);
  })();
  clearBadge(recording.id);
  const message = messageById(messageId);
  if (message) hooks.messagePosted(message);
  return { messageId, attachmentId };
}

function discard(recording: RecordingRow) {
  db.prepare('DELETE FROM recordings WHERE id = ?').run(recording.id);
  fs.rmSync(diskPath(recording), { force: true });
  clearBadge(recording.id);
}

/** Posts every recording that has been quiet too long into the first text channel. */
export function sweepIdleRecordings(now = Date.now()) {
  const idle = db.prepare('SELECT * FROM recordings WHERE updated_at <= ?').all(now - IDLE_RECORDING_MS) as RecordingRow[];
  for (const recording of idle) {
    const firstText = listChannels().find(channel => channel.kind === 'text');
    try {
      if (recording.size > 0 && recording.mime_type && firstText) finish(recording, firstText.id, null);
      else discard(recording);
    } catch (cause) {
      console.error('Could not post a quiet recording:', (cause as Error)?.message || 'unknown error');
    }
  }
}

const router = Router();

// Anyone in the call can record it, one recording at a time, and everyone in it is shown that.
router.post('/', (req: AuthRequest, res: Response) => {
  const channel = getChannel(req.body?.voiceChannelId);
  if (channel?.kind !== 'voice') { res.status(404).json({ error: 'Unknown channel' }); return; }
  const call = getCall(channel.id);
  if (!call?.members.has(req.userId!)) { res.status(409).json({ error: 'Not in this voice channel' }); return; }
  if (call.recording) { res.status(409).json({ error: 'Already recording' }); return; }
  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO recordings (id, user_id, voice_channel_id, channel_name, disk_name, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.userId!, channel.id, channel.name, uuid(), now, now);
  call.recording = { id, userId: req.userId!, startedAt: now };
  hooks.voiceChanged();
  res.json({ id, startedAt: now });
});

// Pieces arrive in order. One that arrives twice, because the answer to the first try was lost, is
// accepted without being added again; one that skips ahead is refused, so the file stays playable.
router.put('/:id/chunks/:index', express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }), (req: AuthRequest, res: Response) => {
  const recording = findRecording(req.params.id);
  if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }
  if (recording.user_id !== req.userId) { res.status(403).json({ error: 'Not your recording' }); return; }
  const index = Number(req.params.index);
  if (!Number.isSafeInteger(index) || index < 0) { res.status(400).json({ error: 'Invalid piece' }); return; }
  if (index < recording.next_chunk) { res.json({ ok: true, size: recording.size }); return; }
  if (index > recording.next_chunk) { res.status(409).json({ error: 'Piece out of order', expected: recording.next_chunk }); return; }
  const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!chunk.length) { res.status(400).json({ error: 'Empty piece' }); return; }
  if (recording.size + chunk.length > maxRecordingBytes()) { res.status(413).json({ error: 'Recording too large' }); return; }
  let mimeType = recording.mime_type;
  if (index === 0) {
    // The first piece starts the file, so it shows what kind of file it really is.
    mimeType = detectMime(chunk.subarray(0, 16), 'video/');
    if (mimeType !== 'video/webm' && mimeType !== 'video/mp4') { res.status(415).json({ error: 'Only video recordings are allowed' }); return; }
  }
  fs.appendFileSync(diskPath(recording), chunk);
  const size = recording.size + chunk.length;
  db.prepare('UPDATE recordings SET size = ?, next_chunk = ?, mime_type = ?, updated_at = ? WHERE id = ?')
    .run(size, index + 1, mimeType, Date.now(), recording.id);
  res.json({ ok: true, size });
});

// After a dropped connection the server has forgotten who is recording; the recorder's app says so
// again once it is back in the call, so the badge returns.
router.post('/:id/resume', (req: AuthRequest, res: Response) => {
  const recording = findRecording(req.params.id);
  if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }
  if (recording.user_id !== req.userId) { res.status(403).json({ error: 'Not your recording' }); return; }
  const call = getCall(recording.voice_channel_id);
  if (recording.stopped || !call?.members.has(req.userId!)) { res.status(409).json({ error: 'Not in this voice channel' }); return; }
  if (call.recording && call.recording.id !== recording.id) { res.status(409).json({ error: 'Already recording' }); return; }
  if (!call.recording) {
    call.recording = { id: recording.id, userId: recording.user_id, startedAt: recording.started_at };
    hooks.voiceChanged();
  }
  res.json({ ok: true });
});

// Stopping takes the badge away at once; the last pieces and the choice of channel follow.
router.post('/:id/stop', (req: AuthRequest, res: Response) => {
  const recording = findRecording(req.params.id);
  if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }
  if (recording.user_id !== req.userId) { res.status(403).json({ error: 'Not your recording' }); return; }
  db.prepare('UPDATE recordings SET stopped = 1, updated_at = ? WHERE id = ?').run(Date.now(), recording.id);
  clearBadge(recording.id);
  res.json({ ok: true });
});

router.post('/:id/finish', (req: AuthRequest, res: Response) => {
  const recording = findRecording(req.params.id);
  if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }
  if (recording.user_id !== req.userId) { res.status(403).json({ error: 'Not your recording' }); return; }
  const textChannelId = req.body?.textChannelId;
  if (!isTextChannel(textChannelId)) { res.status(404).json({ error: 'Unknown channel' }); return; }
  if (!recording.size || !recording.mime_type) { res.status(400).json({ error: 'Empty recording' }); return; }
  res.json(finish(recording, textChannelId, req.body?.durationMs, req.body?.name));
});

router.delete('/:id', (req: AuthRequest, res: Response) => {
  const recording = findRecording(req.params.id);
  if (!recording) { res.status(404).json({ error: 'Recording not found' }); return; }
  if (recording.user_id !== req.userId) { res.status(403).json({ error: 'Not your recording' }); return; }
  discard(recording);
  res.json({ ok: true });
});

// A piece over the limit is refused by the body reader before any route sees it.
router.use((error: { type?: string }, _req: AuthRequest, res: Response, next: (error: unknown) => void) => {
  if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'Piece too large' }); return; }
  next(error);
});

export default router;
