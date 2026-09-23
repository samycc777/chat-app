import fs from 'fs';
import path from 'path';
import db from './database';
import { UPLOADS_DIR } from './config';

export function detectMime(buffer: Buffer): string | null {
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
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
