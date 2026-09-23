import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { v4 as uuid } from 'uuid';
import db, { CLASSROOM_ID } from './database';
import { verifyToken } from './auth';
import { removeAttachmentIfUnused } from './attachments';
import { endLessonSession, getLessonSession, LessonSession, startLessonSession } from './lesson';
import { roomService } from './livekit';

const onlineUsers = new Map<string, Set<string>>();
const abandonTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Typing is throttled by the client, so normal use stays far below the soft limit. Events over it
// are dropped with an error reply instead of silently cutting a student off; only a client far
// beyond it is disconnected.
const EVENT_WINDOW_MS = 60_000;
const SOFT_EVENT_LIMIT = 120;
const HARD_EVENT_LIMIT = 600;

// How long a presenter may be away before a lesson counts as abandoned.
const abandonGraceMs = () => Number(process.env.LESSON_ABANDON_GRACE_MS) || 90_000;

function lessonPayload(session: LessonSession) {
  return { conversationId: session.conversationId, presenterId: session.presenterId, startedAt: session.startedAt };
}

const profileQuery = db.prepare('SELECT id, display_name AS displayName, avatar_color AS avatarColor, role FROM users WHERE id = ?');
function profile(userId: string) {
  return profileQuery.get(userId) as { id: string; displayName: string; avatarColor: string; role: string } | undefined;
}

function replySummary(replyTo: string) {
  const replied = db.prepare(
    `SELECT m.id, m.content, m.type, m.deleted, m.sender_id, u.display_name as sender_display_name
     FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
  ).get(replyTo) as any;
  return replied ? {
    id: replied.id, content: replied.deleted ? null : replied.content, type: replied.type, deleted: !!replied.deleted,
    senderId: replied.sender_id, senderDisplayName: replied.sender_display_name,
  } : null;
}

export function setupSocket(httpServer: HttpServer, allowedOrigins: string[] = []) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed'));
      },
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 256 * 1024,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    const session = typeof token === 'string' ? verifyToken(token) : null;
    if (!session) return next(new Error('Invalid classroom session'));
    socket.data.userId = session.userId;
    socket.data.role = session.role;
    next();
  });

  function endLesson(conversationId: string) {
    const session = endLessonSession(conversationId);
    if (!session) return;
    clearTimeout(abandonTimers.get(conversationId));
    abandonTimers.delete(conversationId);
    io.to(`conv:${conversationId}`).emit('wb_ended', { conversationId });
    // Closing the room disconnects anyone still in it, so nobody stays on the call of an ended lesson.
    roomService()?.deleteRoom(session.roomName).catch(() => { /* The room may never have been opened. */ });
  }

  // A presenter who closed the app or lost their connection must not leave a lesson that students
  // keep waiting in. A teacher's phone can drop the chat connection while its stream carries on,
  // so LiveKit is asked whether the presenter is still in the room before the lesson is ended.
  function watchPresenter(session: LessonSession, failedChecks = 0) {
    clearTimeout(abandonTimers.get(session.conversationId));
    abandonTimers.set(session.conversationId, setTimeout(async () => {
      abandonTimers.delete(session.conversationId);
      const stillCurrent = () => getLessonSession(session.conversationId) === session && !onlineUsers.has(session.presenterId);
      if (!stillCurrent()) return;
      let presenting = false;
      try {
        const participants = await roomService()?.listParticipants(session.roomName) ?? [];
        presenting = participants.some(participant => participant.identity === session.presenterId);
      } catch {
        if (failedChecks < 5) { watchPresenter(session, failedChecks + 1); return; }
      }
      if (!stillCurrent()) return;
      if (presenting) watchPresenter(session);
      else endLesson(session.conversationId);
    }, abandonGraceMs()).unref());
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    const isTeacher = socket.data.role === 'teacher';
    const me = profile(userId);
    const eventTimes: number[] = [];
    socket.use((packet, next) => {
      const now = Date.now();
      while (eventTimes.length && eventTimes[0] <= now - EVENT_WINDOW_MS) eventTimes.shift();
      eventTimes.push(now);
      if (eventTimes.length > HARD_EVENT_LIMIT) { socket.disconnect(true); return; }
      if (eventTimes.length > SOFT_EVENT_LIMIT) {
        const ack = packet[packet.length - 1];
        if (typeof ack === 'function') ack({ error: 'Too many requests' });
        return;
      }
      next();
    });
    const isMember = (conversationId: unknown) => conversationId === CLASSROOM_ID && Boolean(db.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).get(conversationId, userId));

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
    socket.join(`conv:${CLASSROOM_ID}`);

    // Everything a client needs to draw the room is sent on every (re)connection, so state missed
    // while offline, or lost when the server restarted, is replaced rather than left stale.
    socket.emit('presence_state', { users: [...onlineUsers.keys()].map(profile).filter(Boolean) });
    const lesson = getLessonSession(CLASSROOM_ID);
    socket.emit('lesson_state', { lesson: lesson ? lessonPayload(lesson) : null });
    socket.to(`conv:${CLASSROOM_ID}`).emit('presence', { userId, online: true, user: me });

    socket.on('send_message', (data, callback) => {
      if (!data || !isMember(data.conversationId)) return callback?.({ error: 'Not a member' });
      const { conversationId, content, type, replyTo } = data;
      const safeType = type || 'text';
      if (!['text', 'image', 'file'].includes(safeType) || (safeType === 'text' && (typeof content !== 'string' || !content.trim() || content.length > 8000))) return callback?.({ error: 'Invalid message' });
      if (safeType !== 'text' && (!data.attachmentId || typeof data.attachmentId !== 'string')) return callback?.({ error: 'Attachment required' });
      if (replyTo) {
        const replied = db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?').get(replyTo, conversationId);
        if (!replied) return callback?.({ error: 'Invalid reply target' });
      }
      let attachment: any = null;
      if (safeType !== 'text') {
        attachment = db.prepare('SELECT id, original_name, mime_type FROM attachments WHERE id = ? AND conversation_id = ?').get(data.attachmentId, conversationId);
        if (!attachment || (safeType === 'image') !== String(attachment.mime_type).startsWith('image/')) return callback?.({ error: 'Invalid attachment' });
      }

      const id = uuid();
      const createdAt = Date.now();

      db.prepare(`
        INSERT INTO messages (id, conversation_id, sender_id, content, type, file_url, file_name, reply_to, created_at, attachment_id)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(id, conversationId, userId, safeType === 'text' ? content : (safeType === 'file' ? attachment.original_name : null), safeType, attachment?.original_name || null, replyTo || null, createdAt, attachment?.id || null);

      const sender = db.prepare(
        'SELECT username, display_name, avatar_color, role FROM users WHERE id = ?'
      ).get(userId) as any;

      const message = {
        id, conversationId, senderId: userId,
        content: safeType === 'text' ? content : (safeType === 'file' ? attachment.original_name : null), type: safeType,
        fileUrl: null, attachmentId: attachment?.id || null, fileName: attachment?.original_name || null,
        replyTo: replyTo ? replySummary(replyTo) : null, editedAt: null, deleted: false, createdAt,
        sender: { username: sender.username, displayName: sender.display_name, avatarColor: sender.avatar_color, role: sender.role },
      };

      io.to(`conv:${conversationId}`).emit('new_message', message);
      callback?.({ id });
    });

    socket.on('edit_message', (data) => {
      if (!data || typeof data.messageId !== 'string' || typeof data.content !== 'string' || !data.content.trim() || data.content.length > 8000) return;
      const { messageId, content } = data;
      const msg = db.prepare("SELECT sender_id, conversation_id FROM messages WHERE id = ? AND type = 'text' AND deleted = 0").get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      const editedAt = Date.now();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, messageId);
      io.to(`conv:${msg.conversation_id}`).emit('message_edited', { messageId, content, editedAt });
    });

    // Students can delete their own messages; the teacher can remove any message from the class.
    socket.on('delete_message', (data) => {
      if (!data || typeof data.messageId !== 'string') return;
      const { messageId } = data;
      const msg = db.prepare('SELECT sender_id, conversation_id, attachment_id FROM messages WHERE id = ? AND deleted = 0').get(messageId) as any;
      if (!msg || (msg.sender_id !== userId && !isTeacher) || !isMember(msg.conversation_id)) return;

      db.prepare('UPDATE messages SET deleted = 1, content = NULL, file_name = NULL, attachment_id = NULL WHERE id = ?').run(messageId);
      if (msg.attachment_id) removeAttachmentIfUnused(msg.attachment_id);
      io.to(`conv:${msg.conversation_id}`).emit('message_deleted', { messageId });
    });

    socket.on('typing', (data) => {
      if (!data || !isMember(data.conversationId)) return;
      const { conversationId } = data;
      socket.to(`conv:${conversationId}`).emit('user_typing', { conversationId, userId, displayName: me?.displayName });
    });

    socket.on('stop_typing', (data) => {
      if (!data || !isMember(data.conversationId)) return;
      const { conversationId } = data;
      socket.to(`conv:${conversationId}`).emit('user_stop_typing', { conversationId, userId });
    });

    // Lessons keep their original event names so installed teacher apps stay compatible.
    socket.on('wb_start', (data: { conversationId: string }, callback?: unknown) => {
      const reply = (payload: { presenterId: string } | { error: string }) => { if (typeof callback === 'function') callback(payload); };
      if (!data || !isMember(data.conversationId)) return reply({ error: 'Not a member' });
      if (!isTeacher) return reply({ error: 'Only the teacher can start a lesson' });
      const existing = getLessonSession(data.conversationId);
      if (existing?.presenterId === userId) return reply({ presenterId: userId });
      // Only the teacher presents, so starting from another device takes the lesson over.
      if (existing) endLesson(data.conversationId);
      const session = startLessonSession(data.conversationId, userId);
      io.to(`conv:${data.conversationId}`).emit('wb_started', lessonPayload(session));
      reply({ presenterId: userId });
    });

    socket.on('wb_end', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = getLessonSession(data.conversationId);
      if (!session || (session.presenterId !== userId && !isTeacher)) return;
      endLesson(data.conversationId);
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (!sockets) return;
      sockets.delete(socket.id);
      if (sockets.size) return;
      onlineUsers.delete(userId);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
      io.to(`conv:${CLASSROOM_ID}`).emit('presence', { userId, online: false, lastSeen: Date.now() });
      const session = getLessonSession(CLASSROOM_ID);
      if (session?.presenterId === userId) watchPresenter(session);
    });
  });

  return io;
}
