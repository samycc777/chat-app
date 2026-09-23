import { randomBytes, randomUUID } from 'crypto';

export interface LessonSession {
  conversationId: string;
  presenterId: string;
  roomName: string;
  encryptionKey: string;
  startedAt: number;
}

// Lesson credentials are deliberately process-local. They are never persisted to
// SQLite or written to logs, and disappear if this process restarts.
const sessions = new Map<string, LessonSession>();

export function startLessonSession(conversationId: string, presenterId: string): LessonSession {
  const session: LessonSession = {
    conversationId,
    presenterId,
    roomName: `lesson-${randomUUID()}`,
    encryptionKey: randomBytes(32).toString('base64url'),
    startedAt: Date.now(),
  };
  sessions.set(conversationId, session);
  return session;
}

export function getLessonSession(conversationId: string): LessonSession | undefined {
  return sessions.get(conversationId);
}

export function endLessonSession(conversationId: string): LessonSession | undefined {
  const session = sessions.get(conversationId);
  sessions.delete(conversationId);
  return session;
}
