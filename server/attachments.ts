import fs from 'fs';
import path from 'path';
import db from './database';
import { UPLOADS_DIR } from './config';

// A file's type is read from its first bytes, never trusted from its name. Sound and video share
// containers (WebM, MP4), so for those the type the device declared picks between audio and video.
export function detectMime(buffer: Buffer, declared = ''): string | null {
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  const audio = declared.toLowerCase().startsWith('audio/');
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return audio ? 'audio/webm' : 'video/webm';
  if (buffer.subarray(4, 8).toString() === 'ftyp') {
    return audio || buffer.subarray(8, 12).toString() === 'M4A ' ? 'audio/mp4' : 'video/mp4';
  }
  if (buffer.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  return null;
}

// A deleted message takes its file with it, unless another message still shows the same file.
export function removeAttachmentIfUnused(attachmentId: string) {
  if (db.prepare('SELECT 1 FROM messages WHERE attachment_id = ? AND deleted = 0').get(attachmentId)) return;
  const attachment = db.prepare('SELECT disk_name FROM attachments WHERE id = ?').get(attachmentId) as { disk_name: string } | undefined;
  if (!attachment) return;
  db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
  fs.rm(path.join(UPLOADS_DIR, attachment.disk_name), { force: true }, () => {});
}
