import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import db from './database';
import { AuthRequest, signStreamToken, verifyStreamToken } from './auth';
import { UPLOADS_DIR } from './config';

// Sound and video are played straight from the server rather than downloaded first, so an hour-long
// lesson starts at once and can be skipped through.
const streamable = (mime: string) => /^(audio|video)\//.test(mime);

type StoredAttachment = { id: string; disk_name: string; original_name: string; mime_type: string };
const attachmentQuery = db.prepare('SELECT id, disk_name, original_name, mime_type FROM attachments WHERE id = ?');

/** GET /api/attachments/:id/stream-url, behind the session check: a link the player can open. */
export function streamLink(req: AuthRequest, res: Response) {
  const attachment = attachmentQuery.get(req.params.id) as StoredAttachment | undefined;
  if (!attachment || !streamable(attachment.mime_type)) { res.status(404).json({ error: 'Attachment not found' }); return; }
  const token = signStreamToken(attachment.id, req.userId!);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ url: `/api/attachments/${encodeURIComponent(attachment.id)}/stream?token=${encodeURIComponent(token)}` });
}

/** GET /api/attachments/:id/stream?token=..., opened by the video element itself. */
export function streamAttachment(req: Request, res: Response) {
  const id = String(req.params.id);
  if (!verifyStreamToken(req.query.token, id)) { res.status(401).json({ error: 'Invalid or expired link' }); return; }
  const attachment = attachmentQuery.get(id) as StoredAttachment | undefined;
  if (!attachment || !streamable(attachment.mime_type)) { res.status(404).json({ error: 'Attachment not found' }); return; }
  const diskPath = path.join(UPLOADS_DIR, attachment.disk_name);
  if (!fs.existsSync(diskPath)) { res.status(404).json({ error: 'Attachment file not found' }); return; }
  res.setHeader('Content-Type', attachment.mime_type);
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  // sendFile answers Range requests with just the part asked for, which is what lets a player seek.
  res.sendFile(diskPath, { acceptRanges: true });
}
