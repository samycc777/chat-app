import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { v4 as uuid } from 'uuid';
import db from './database';
import { verifyToken } from './auth';
import { removeAttachmentIfUnused } from './attachments';
import { ChannelKind, cleanChannelName, createChannel, deleteChannel, getChannel, isTextChannel, listChannels, renameChannel } from './channels';
import { addToCall, allCalls, callOf, endCall, removeFromCall, screenIdentity, VoiceCall } from './voice';
import { roomService } from './livekit';
import { messageById } from './messages';
import { registerChatEvents } from './chat';
import { connectRecordings } from './recordings';

const onlineUsers = new Map<string, Set<string>>();
// Everyone is in every channel, so every connection joins this one Socket.IO room.
const EVERYONE = 'everyone';

// Typing is throttled by the client, so normal use stays far below the soft limit. Events over it
// are dropped with an error reply instead of silently cutting someone off; only a client far
// beyond it is disconnected.
const EVENT_WINDOW_MS = 60_000;
const SOFT_EVENT_LIMIT = 120;
const HARD_EVENT_LIMIT = 600;
const MAX_CHANNELS = 50;

const profileQuery = db.prepare('SELECT id, display_name AS displayName, avatar_color AS avatarColor FROM users WHERE id = ?');
function profile(userId: string) {
  return profileQuery.get(userId) as { id: string; displayName: string; avatarColor: string } | undefined;
}

// Who is in each voice channel is kept by the server rather than read from LiveKit, so the sidebar
// can show it to people who are not in any call, and so raised hands arrive with their names.
function callPayload(call: VoiceCall) {
  return {
    channelId: call.channelId,
    startedAt: call.startedAt,
    members: [...call.members.keys()].map(profile).filter(Boolean),
    hands: [...call.hands.entries()].sort((a, b) => a[1] - b[1])
      .map(([userId]) => ({ userId, displayName: profile(userId)?.displayName ?? '' })),
    recording: call.recording
      ? { userId: call.recording.userId, displayName: profile(call.recording.userId)?.displayName ?? '', startedAt: call.recording.startedAt }
      : null,
  };
}
const voiceState = () => ({ calls: allCalls().map(callPayload) });

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
    if (!session) return next(new Error('Invalid session'));
    socket.data.userId = session.userId;
    next();
  });

  const broadcastVoice = () => io.to(EVERYONE).emit('voice_state', voiceState());
  const broadcastChannels = () => io.to(EVERYONE).emit('channels', { channels: listChannels() });
  connectRecordings({ voiceChanged: broadcastVoice, messagePosted: message => io.to(EVERYONE).emit('new_message', message) });

  // A phone's screen connection is separate from its owner's, so it is closed on the server's side
  // too: otherwise a phone whose app was killed would keep showing its screen to the call.
  function takeOutOfCall(userId: string) {
    const call = removeFromCall(userId);
    if (call?.phoneScreens.delete(userId)) {
      roomService()?.removeParticipant(call.roomName, screenIdentity(userId)).catch(() => { /* It had already stopped sharing. */ });
    }
    return call;
  }
  function leaveCall(userId: string) {
    if (takeOutOfCall(userId)) broadcastVoice();
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
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

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
    socket.join(EVERYONE);
    socket.join(`user:${userId}`);

    // Everything a client needs to draw the server is sent on every (re)connection, so state missed
    // while offline, or lost when the server restarted, is replaced rather than left stale.
    socket.emit('presence_state', { users: [...onlineUsers.keys()].map(profile).filter(Boolean) });
    socket.emit('channels', { channels: listChannels() });
    socket.emit('voice_state', voiceState());
    socket.to(EVERYONE).emit('presence', { userId, online: true, user: me });
    registerChatEvents(io, socket, userId);

    socket.on('send_message', (data, callback) => {
      if (!data || !isTextChannel(data.conversationId)) return callback?.({ error: 'Unknown channel' });
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

      const message = messageById(id)!;
      io.to(EVERYONE).emit('new_message', message);
      callback?.({ id });
    });

    socket.on('edit_message', (data) => {
      if (!data || typeof data.messageId !== 'string' || typeof data.content !== 'string' || !data.content.trim() || data.content.length > 8000) return;
      const { messageId, content } = data;
      const msg = db.prepare("SELECT sender_id, conversation_id FROM messages WHERE id = ? AND type = 'text' AND deleted = 0").get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      const editedAt = Date.now();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, messageId);
      io.to(EVERYONE).emit('message_edited', { messageId, content, editedAt });
    });

    // Nobody moderates the server, so everyone can delete only their own messages.
    socket.on('delete_message', (data) => {
      if (!data || typeof data.messageId !== 'string') return;
      const { messageId } = data;
      const msg = db.prepare('SELECT sender_id, attachment_id FROM messages WHERE id = ? AND deleted = 0').get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      db.prepare('UPDATE messages SET deleted = 1, content = NULL, file_name = NULL, attachment_id = NULL WHERE id = ?').run(messageId);
      if (msg.attachment_id) removeAttachmentIfUnused(msg.attachment_id);
      io.to(EVERYONE).emit('message_deleted', { messageId });
    });

    socket.on('typing', (data) => {
      if (!data || !isTextChannel(data.conversationId)) return;
      socket.to(EVERYONE).emit('user_typing', { conversationId: data.conversationId, userId, displayName: me?.displayName });
    });

    socket.on('stop_typing', (data) => {
      if (!data || !isTextChannel(data.conversationId)) return;
      socket.to(EVERYONE).emit('user_stop_typing', { conversationId: data.conversationId, userId });
    });

    // Anyone can make, rename and delete channels, as friends would on a server they share.
    socket.on('create_channel', (data: { name: unknown; kind: unknown }, callback?: unknown) => {
      const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
      const name = cleanChannelName(data?.name);
      const kind = data?.kind as ChannelKind;
      if (!name || (kind !== 'text' && kind !== 'voice')) return reply({ error: 'Invalid channel' });
      if (listChannels().length >= MAX_CHANNELS) return reply({ error: 'Too many channels' });
      const channel = createChannel(name, kind);
      broadcastChannels();
      reply({ channel });
    });

    socket.on('rename_channel', (data: { channelId: unknown; name: unknown }, callback?: unknown) => {
      const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
      const channel = getChannel(data?.channelId);
      const name = cleanChannelName(data?.name);
      if (!channel || !name) return reply({ error: 'Invalid channel' });
      renameChannel(channel.id, name);
      broadcastChannels();
      reply({ ok: true });
    });

    socket.on('delete_channel', (data: { channelId: unknown }, callback?: unknown) => {
      const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
      const channel = getChannel(data?.channelId);
      if (!channel) return reply({ error: 'Invalid channel' });
      // There is always somewhere to write.
      if (channel.kind === 'text' && listChannels().filter(other => other.kind === 'text').length <= 1) return reply({ error: 'Last text channel' });
      deleteChannel(channel);
      if (channel.kind === 'voice') {
        const call = endCall(channel.id);
        // Closing the room disconnects anyone still in the call of a channel that no longer exists.
        if (call) roomService()?.deleteRoom(call.roomName).catch(() => { /* The room may never have been opened. */ });
        broadcastVoice();
      }
      broadcastChannels();
      reply({ ok: true });
    });

    // Like Discord, a person is in at most one voice channel; joining another moves them.
    socket.on('voice_join', (data: { channelId: unknown }, callback?: unknown) => {
      const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
      const channel = getChannel(data?.channelId);
      if (channel?.kind !== 'voice') return reply({ error: 'Unknown channel' });
      const previous = callOf(userId);
      if (previous && previous.channelId !== channel.id) takeOutOfCall(userId);
      const call = addToCall(channel.id, userId, socket.id);
      broadcastVoice();
      reply({ startedAt: call.startedAt });
    });

    socket.on('voice_leave', () => leaveCall(userId));

    socket.on('raise_hand', (data: { channelId: string; raised: boolean }) => {
      if (!data || typeof data.raised !== 'boolean') return;
      const call = callOf(userId);
      if (!call || call.channelId !== data.channelId || data.raised === call.hands.has(userId)) return;
      if (data.raised) call.hands.set(userId, Date.now());
      else call.hands.delete(userId);
      broadcastVoice();
    });

    socket.on('disconnect', () => {
      // The connection that joined a call carries it; if it drops, the app joins again when it
      // reconnects, so nobody is shown sitting in a call they have left.
      const call = callOf(userId);
      if (call?.members.get(userId) === socket.id) leaveCall(userId);
      const sockets = onlineUsers.get(userId);
      if (!sockets) return;
      sockets.delete(socket.id);
      if (sockets.size) return;
      onlineUsers.delete(userId);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
      io.to(EVERYONE).emit('presence', { userId, online: false, lastSeen: Date.now() });
    });
  });

  return io;
}
