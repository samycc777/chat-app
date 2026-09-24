import path from 'path';
import { createHash, timingSafeEqual } from 'crypto';

export const production = process.env.NODE_ENV === 'production';
if (production && !process.env.DATA_DIR) throw new Error('DATA_DIR must point to persistent storage in production');
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const configuredMaxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES);
export const MAX_UPLOAD_BYTES = Number.isSafeInteger(configuredMaxUploadBytes) && configuredMaxUploadBytes > 0
  ? configuredMaxUploadBytes
  : DEFAULT_MAX_UPLOAD_BYTES;

// Phones often capitalize the first letter or type Arabic-Indic digits, so a key pasted or typed by
// hand is compared without case, spaces, or digit-script differences.
export function normalizeCode(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

// The invite key travels inside the invite link, so nobody has to type it. It is read on every use
// so that a changed key takes effect straight away.
export function inviteKey(): string {
  const key = normalizeCode(process.env.INVITE_KEY || '');
  if (key) return key;
  if (production) throw new Error('INVITE_KEY is required in production');
  return '0000';
}

export function inviteKeyMatches(entered: string): boolean {
  const code = normalizeCode(entered);
  if (!code) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(code), digest(inviteKey()));
}

export function serverName(): string {
  return (process.env.SERVER_NAME || '').trim().slice(0, 80);
}

// Nobody types the key, so it can be long enough that guessing it is hopeless.
if (production && inviteKey().length < 12) throw new Error('INVITE_KEY must be at least 12 characters in production');
