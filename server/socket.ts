import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { v4 as uuid } from 'uuid';
import db, { CLASSROOM_ID } from './database';
import { verifyToken } from './auth';

const onlineUsers = new Map<string, Set<string>>();

interface WbStroke {
  id: string;
  page: number;
  points: { x: number; y: number }[];
  color: string;
  width: number;
  tool: string;
}

interface WhiteboardSession {
  pdfUrl: string | null;
  presenterId: string;
  currentPage: number;
  strokes: { [page: number]: WbStroke[] };
  voiceParticipants: Map<string, { muted: boolean }>;
  screenShareActive: boolean;
}

const whiteboardSessions = new Map<string, WhiteboardSession>();
function memberInConversation(conversationId: string, userId: string) {
  return Boolean(db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId));
}

function getVoiceParticipantsInfo(session: WhiteboardSession) {
  const result: { userId: string; displayName: string; avatarColor: string; muted: boolean }[] = [];
  for (const [uid, state] of session.voiceParticipants) {
    const u = db.prepare('SELECT id, display_name, avatar_color FROM users WHERE id = ?').get(uid) as any;
    if (u) result.push({ userId: u.id, displayName: u.display_name, avatarColor: u.avatar_color, muted: state.muted });
  }
  return result;
}

export function setupSocket(httpServer: HttpServer, allowedOrigins: string[] = []) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 256 * 1024,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    const userId = verifyToken(token);
    if (!userId || !db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(CLASSROOM_ID, userId)) return next(new Error('Invalid classroom session'));
    socket.data.userId = userId;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    const socketEventTimes: number[] = [];
    const drawEventTimes: number[] = [];
    socket.onAny((eventName) => {
      const now = Date.now();
      const isDraw = eventName === 'wb_draw';
      const times = isDraw ? drawEventTimes : socketEventTimes;
      while (times.length && times[0] < now - 60_000) times.shift();
      times.push(now);
      if (times.length > (isDraw ? 1800 : 300)) socket.disconnect(true);
    });
    const isMember = (conversationId: unknown) => typeof conversationId === 'string' && Boolean(db.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).get(conversationId, userId)) && conversationId === CLASSROOM_ID;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);

    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);

    const conversations = db.prepare(
      'SELECT conversation_id FROM conversation_members WHERE user_id = ? AND conversation_id = ?'
    ).all(userId, CLASSROOM_ID) as any[];
    for (const c of conversations) {
      socket.join(`conv:${c.conversation_id}`);
    }

    broadcastPresence(io, userId, true);

    for (const c of conversations) {
      const session = whiteboardSessions.get(c.conversation_id);
      if (session) {
        socket.emit('wb_started', {
          conversationId: c.conversation_id,
          presenterId: session.presenterId,
          pdfUrl: session.pdfUrl,
          currentPage: session.currentPage,
        });
      }
    }

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
        'SELECT username, display_name, avatar_color FROM users WHERE id = ?'
      ).get(userId) as any;

      let replyToData = null;
      if (replyTo) {
        const replied = db.prepare(
          `SELECT m.id, m.content, m.type, m.sender_id, u.display_name as sender_display_name
           FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
        ).get(replyTo) as any;
        if (replied) {
          replyToData = {
            id: replied.id, content: replied.content, type: replied.type,
            senderId: replied.sender_id, senderDisplayName: replied.sender_display_name,
          };
        }
      }

      const message = {
        id, conversationId, senderId: userId,
        content: safeType === 'text' ? content : (safeType === 'file' ? attachment.original_name : null), type: safeType,
        fileUrl: null, attachmentId: attachment?.id || null, fileName: attachment?.original_name || null,
        replyTo: replyToData, editedAt: null, deleted: false, createdAt,
        sender: { username: sender.username, displayName: sender.display_name, avatarColor: sender.avatar_color },
      };

      io.to(`conv:${conversationId}`).emit('new_message', message);
      callback?.({ id });
    });

    socket.on('edit_message', (data) => {
      if (!data || typeof data.messageId !== 'string' || typeof data.content !== 'string' || data.content.length > 8000) return;
      const { messageId, content } = data;
      const msg = db.prepare("SELECT sender_id, conversation_id FROM messages WHERE id = ? AND type = 'text'").get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      const editedAt = Date.now();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, messageId);
      io.to(`conv:${msg.conversation_id}`).emit('message_edited', { messageId, content, editedAt });
    });

    socket.on('delete_message', (data) => {
      if (!data || typeof data.messageId !== 'string') return;
      const { messageId } = data;
      const msg = db.prepare('SELECT sender_id, conversation_id FROM messages WHERE id = ?').get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
      io.to(`conv:${msg.conversation_id}`).emit('message_deleted', { messageId });
    });

    socket.on('typing', (data) => {
      if (!data || !isMember(data.conversationId)) return;
      const { conversationId } = data;
      socket.to(`conv:${conversationId}`).emit('user_typing', { conversationId, userId });
    });

    socket.on('stop_typing', (data) => {
      if (!data || !isMember(data.conversationId)) return;
      const { conversationId } = data;
      socket.to(`conv:${conversationId}`).emit('user_stop_typing', { conversationId, userId });
    });

    socket.on('mark_read', (data) => {
      if (!data || !isMember(data.conversationId)) return;
      const { conversationId } = data;
      const messages = db.prepare(
        `SELECT id FROM messages WHERE conversation_id = ? AND sender_id != ?
         AND NOT EXISTS (SELECT 1 FROM message_reads WHERE message_id = messages.id AND user_id = ?)`
      ).all(conversationId, userId, userId) as any[];

      const insert = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
      const markAll = db.transaction(() => {
        for (const m of messages) insert.run(m.id, userId);
      });
      markAll();

      io.to(`conv:${conversationId}`).emit('messages_read', { conversationId, userId });
    });

    socket.on('join_conversation', (data) => {
      if (data && isMember(data.conversationId)) socket.join(`conv:${data.conversationId}`);
    });

    // Whiteboard events
    socket.on('wb_start', (data: { conversationId: string; attachmentId?: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      if (whiteboardSessions.has(data.conversationId)) return;
      let initialPdfId: string | null = null;
      if (data.attachmentId) {
        const attachment = db.prepare("SELECT id FROM attachments WHERE id = ? AND conversation_id = ? AND mime_type = 'application/pdf'").get(data.attachmentId, data.conversationId) as { id: string } | undefined;
        if (!attachment) return;
        initialPdfId = attachment.id;
      }

      const session: WhiteboardSession = {
        pdfUrl: initialPdfId,
        presenterId: userId,
        currentPage: 1,
        strokes: {},
        voiceParticipants: new Map(),
        screenShareActive: false,
      };
      whiteboardSessions.set(data.conversationId, session);
      io.to(`conv:${data.conversationId}`).emit('wb_started', {
        conversationId: data.conversationId,
        presenterId: userId,
        pdfUrl: session.pdfUrl,
        currentPage: 1,
      });
    });

    socket.on('wb_end', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;
      whiteboardSessions.delete(data.conversationId);
      socket.to(`conv:${data.conversationId}`).emit('wb_ended', {
        conversationId: data.conversationId,
      });
    });

    socket.on('wb_pdf', (data: { conversationId: string; attachmentId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;
      const attachment = db.prepare("SELECT id FROM attachments WHERE id = ? AND conversation_id = ? AND mime_type = 'application/pdf'").get(data.attachmentId, data.conversationId) as { id: string } | undefined;
      if (!attachment) return;
      session.pdfUrl = attachment.id;
      session.currentPage = 1;
      session.strokes = {};
      socket.to(`conv:${data.conversationId}`).emit('wb_pdf_loaded', {
        conversationId: data.conversationId,
        pdfUrl: attachment.id,
      });
    });

    socket.on('wb_page', (data: { conversationId: string; page: number }) => {
      if (!data || !isMember(data.conversationId) || !Number.isInteger(data.page) || data.page < 1) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;
      session.currentPage = data.page;
      socket.to(`conv:${data.conversationId}`).emit('wb_page_changed', {
        conversationId: data.conversationId,
        page: data.page,
      });
    });

    socket.on('wb_draw', (data: {
      conversationId: string; strokeId: string; page: number;
      points: { x: number; y: number }[]; color: string; width: number; tool: string; done: boolean;
    }) => {
      if (!data || !isMember(data.conversationId) || typeof data.strokeId !== 'string' || data.strokeId.length > 80 ||
          !Number.isInteger(data.page) || data.page < 1 || typeof data.done !== 'boolean' ||
          !Array.isArray(data.points) || data.points.length > 256 ||
          data.points.some((point: any) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) ||
          !/^#[0-9a-f]{6}$/i.test(data.color) || ![2, 4, 8].includes(data.width) || !['pen', 'eraser'].includes(data.tool)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;

      if (!session.strokes[data.page]) session.strokes[data.page] = [];
      const existing = session.strokes[data.page].find(s => s.id === data.strokeId);
      if (existing) {
        if (existing.points.length + data.points.length > 10_000) return;
        existing.points.push(...data.points);
      } else {
        if (session.strokes[data.page].length >= 1000) return;
        session.strokes[data.page].push({
          id: data.strokeId, page: data.page,
          points: [...data.points], color: data.color, width: data.width, tool: data.tool,
        });
      }

      socket.to(`conv:${data.conversationId}`).emit('wb_draw', {
        conversationId: data.conversationId,
        strokeId: data.strokeId, page: data.page,
        points: data.points, color: data.color, width: data.width, tool: data.tool, done: data.done,
      });
    });

    socket.on('wb_clear', (data: { conversationId: string; page: number }) => {
      if (!data || !isMember(data.conversationId) || !Number.isInteger(data.page) || data.page < 1) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;
      session.strokes[data.page] = [];
      socket.to(`conv:${data.conversationId}`).emit('wb_cleared', {
        conversationId: data.conversationId,
        page: data.page,
      });
    });

    socket.on('wb_get_state', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session) return;
      socket.emit('wb_state', {
        conversationId: data.conversationId,
        presenterId: session.presenterId,
        pdfUrl: session.pdfUrl,
        currentPage: session.currentPage,
        strokes: session.strokes,
        voiceParticipants: getVoiceParticipantsInfo(session),
        screenShareActive: session.screenShareActive,
      });
    });

    socket.on('wb_voice_join', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session) return;
      const existingPeers = Array.from(session.voiceParticipants.keys());
      session.voiceParticipants.set(userId, { muted: false });
      socket.emit('wb_voice_peers', {
        conversationId: data.conversationId,
        peers: existingPeers,
        participants: getVoiceParticipantsInfo(session),
      });
      const user = db.prepare('SELECT id, display_name, avatar_color FROM users WHERE id = ?').get(userId) as any;
      if (user) {
        socket.to(`conv:${data.conversationId}`).emit('wb_voice_joined', {
          conversationId: data.conversationId,
          userId,
          displayName: user.display_name,
          avatarColor: user.avatar_color,
          muted: false,
        });
      }
    });

    socket.on('wb_voice_leave', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session) return;
      session.voiceParticipants.delete(userId);
      socket.to(`conv:${data.conversationId}`).emit('wb_voice_left', {
        conversationId: data.conversationId,
        userId,
      });
    });

    socket.on('wb_voice_mute', (data: { conversationId: string; muted: boolean }) => {
      if (!data || !isMember(data.conversationId) || typeof data.muted !== 'boolean') return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session) return;
      const state = session.voiceParticipants.get(userId);
      if (!state) return;
      state.muted = data.muted;
      socket.to(`conv:${data.conversationId}`).emit('wb_voice_muted', {
        conversationId: data.conversationId,
        userId,
        muted: data.muted,
      });
    });

    socket.on('wb_voice_offer', (data: { conversationId: string; targetUserId: string; offer: any }) => {
      if (!data || !isMember(data.conversationId) || !memberInConversation(data.conversationId, data.targetUserId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session?.voiceParticipants.has(userId) || !session.voiceParticipants.has(data.targetUserId)) return;
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (!targetSockets) return;
      for (const sid of targetSockets) {
        io.to(sid).emit('wb_voice_offer', {
          conversationId: data.conversationId,
          from: userId,
          offer: data.offer,
        });
      }
    });

    socket.on('wb_voice_answer', (data: { conversationId: string; targetUserId: string; answer: any }) => {
      if (!data || !isMember(data.conversationId) || !memberInConversation(data.conversationId, data.targetUserId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session?.voiceParticipants.has(userId) || !session.voiceParticipants.has(data.targetUserId)) return;
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (!targetSockets) return;
      for (const sid of targetSockets) {
        io.to(sid).emit('wb_voice_answer', {
          conversationId: data.conversationId,
          from: userId,
          answer: data.answer,
        });
      }
    });

    socket.on('wb_voice_ice', (data: { conversationId: string; targetUserId: string; candidate: any }) => {
      if (!data || !isMember(data.conversationId) || !memberInConversation(data.conversationId, data.targetUserId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session?.voiceParticipants.has(userId) || !session.voiceParticipants.has(data.targetUserId)) return;
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (!targetSockets) return;
      for (const sid of targetSockets) {
        io.to(sid).emit('wb_voice_ice', {
          conversationId: data.conversationId,
          from: userId,
          candidate: data.candidate,
        });
      }
    });

    socket.on('wb_screen_start', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;
      session.screenShareActive = true;
      socket.to(`conv:${data.conversationId}`).emit('wb_screen_started', {
        conversationId: data.conversationId,
        presenterId: userId,
      });
    });

    socket.on('wb_screen_stop', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || session.presenterId !== userId) return;
      session.screenShareActive = false;
      socket.to(`conv:${data.conversationId}`).emit('wb_screen_stopped', {
        conversationId: data.conversationId,
      });
    });

    socket.on('wb_screen_watch', (data: { conversationId: string }) => {
      if (!data || !isMember(data.conversationId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session || !session.screenShareActive) return;
      const presenterSockets = onlineUsers.get(session.presenterId);
      if (!presenterSockets) return;
      for (const sid of presenterSockets) {
        io.to(sid).emit('wb_screen_watcher', {
          conversationId: data.conversationId,
          viewerId: userId,
        });
      }
    });

    socket.on('wb_screen_offer', (data: { conversationId: string; targetUserId: string; offer: any }) => {
      if (!data || !isMember(data.conversationId) || !memberInConversation(data.conversationId, data.targetUserId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session?.screenShareActive || session.presenterId !== userId) return;
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (!targetSockets) return;
      for (const sid of targetSockets) {
        io.to(sid).emit('wb_screen_offer', {
          conversationId: data.conversationId,
          from: userId,
          offer: data.offer,
        });
      }
    });

    socket.on('wb_screen_answer', (data: { conversationId: string; targetUserId: string; answer: any }) => {
      if (!data || !isMember(data.conversationId) || !memberInConversation(data.conversationId, data.targetUserId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session?.screenShareActive || session.presenterId !== data.targetUserId) return;
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (!targetSockets) return;
      for (const sid of targetSockets) {
        io.to(sid).emit('wb_screen_answer', {
          conversationId: data.conversationId,
          from: userId,
          answer: data.answer,
        });
      }
    });

    socket.on('wb_screen_ice', (data: { conversationId: string; targetUserId: string; candidate: any }) => {
      if (!data || !isMember(data.conversationId) || !memberInConversation(data.conversationId, data.targetUserId)) return;
      const session = whiteboardSessions.get(data.conversationId);
      if (!session?.screenShareActive || (session.presenterId !== userId && session.presenterId !== data.targetUserId)) return;
      const targetSockets = onlineUsers.get(data.targetUserId);
      if (!targetSockets) return;
      for (const sid of targetSockets) {
        io.to(sid).emit('wb_screen_ice', {
          conversationId: data.conversationId,
          from: userId,
          candidate: data.candidate,
        });
      }
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
          broadcastPresence(io, userId, false);
          for (const [convId, session] of whiteboardSessions) {
            if (session.voiceParticipants.delete(userId)) {
              io.to(`conv:${convId}`).emit('wb_voice_left', { conversationId: convId, userId });
            }
            if (session.screenShareActive && session.presenterId === userId) {
              session.screenShareActive = false;
              io.to(`conv:${convId}`).emit('wb_screen_stopped', { conversationId: convId });
            }
          }
        }
      }
    });
  });

  function broadcastPresence(io: Server, userId: string, online: boolean) {
    const conversations = db.prepare(
      'SELECT conversation_id FROM conversation_members WHERE user_id = ?'
    ).all(userId) as any[];
    for (const c of conversations) {
      io.to(`conv:${c.conversation_id}`).emit('presence', { userId, online, lastSeen: Date.now() });
    }
  }

  return io;
}
