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

export type Role = 'student' | 'teacher';

// Phones set to Arabic type Arabic-Indic digits and often capitalize the first letter,
// so codes are compared without case, spaces, or digit-script differences.
export function normalizeCode(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u0660-\u0669]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

// Codes are read on every use so that a changed code takes effect without stale copies.
export function classCode(role: Role): string {
  const name = role === 'teacher' ? 'TEACHER_CODE' : 'CLASS_CODE';
  const code = normalizeCode(process.env[name] || '');
  if (code) return code;
  if (production) throw new Error(`${name} is required in production`);
  return role === 'teacher' ? 'teacher' : '0000';
}

function sameCode(a: string, b: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function roleForCode(entered: string): Role | null {
  const code = normalizeCode(entered);
  if (!code) return null;
  if (sameCode(code, classCode('teacher'))) return 'teacher';
  if (sameCode(code, classCode('student'))) return 'student';
  return null;
}

export function className(): string {
  return (process.env.CLASS_NAME || '').trim().slice(0, 80);
}

// Four digits are enough for a class that types codes on phones; repeated wrong codes are locked out.
if (production) {
  const student = classCode('student');
  const teacher = classCode('teacher');
  if (student.length < 4) throw new Error('CLASS_CODE must be at least 4 characters in production');
  if (teacher.length < 4) throw new Error('TEACHER_CODE must be at least 4 characters in production');
  if (student === teacher) throw new Error('CLASS_CODE and TEACHER_CODE must be different');
}
