import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { v4 as uuid } from 'uuid';
import db from './database';
import { verifyToken } from './auth';
import { removeAttachmentIfUnused } from './attachments';
import { ChannelKind, cleanChannelName, createChannel, deleteChannel, getChannel, HOME_ROOM, isTextChannel, listChannels, renameChannel } from './channels';
import { roomChannel } from './rooms';
import { addToCall, allCalls, CallChatMessage, callOf, endCall, getCall, removeFromCall, screenIdentity, VoiceCall } from './voice';
import { roomService } from './livekit';
import { messageById } from './messages';
import { forgetSocket, notifyCallStarted, notifyNewMessage, setAppActive } from './push';
import { registerChatEvents } from './chat';
import { connectRecordings } from './recordings';

// Who is online in each room, by room ID, then by user ID with their connections. Everyone in a
// room is in every one of its channels, so each connection joins its room's Socket.IO room.
const onlineByRoom = new Map<string, Map<string, Set<string>>>();
const HOME = roomChannel(HOME_ROOM);

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
const voiceState = (roomId: string) => ({ calls: allCalls(roomId).map(callPayload) });

// A long call's chat stays bounded; the oldest messages go first.
const MAX_CALL_CHAT = 500;
const MAX_CALL_CHAT_TEXT = 2000;
const person = (userId: string) => ({ id: userId, displayName: profile(userId)?.displayName ?? '' });
function callChatPayload(message: CallChatMessage) {
  return {
    id: message.id, from: person(message.fromId), to: message.toId ? person(message.toId) : null,
    text: message.text, sentAt: message.sentAt,
  };
}
// A private message is seen only by the two people in it.
const canSee = (message: CallChatMessage, userId: string) => !message.toId || message.fromId === userId || message.toId === userId;

// A phone's screen connection is separate from its owner's. When the owner's connection drops, as
// it does for a moment on weak internet, the app joins the call again by itself, so the screen is
// kept going for a while instead of stopping in the middle of a lesson. It stops only if they do
// not come back, for example because the app was killed.
export const DROPPED_SCREEN_MS = 2 * 60_000;
const droppedScreens = new Map<string, { call: VoiceCall; since: number }>();
function endPhoneScreen(userId: string, call: VoiceCall) {
  roomService()?.removeParticipant(call.roomName, screenIdentity(userId)).catch(() => { /* It had already stopped sharing. */ });
}
export function sweepDroppedScreens(now = Date.now()) {
  for (const [userId, dropped] of droppedScreens) {
    if (now - dropped.since < DROPPED_SCREEN_MS) continue;
    droppedScreens.delete(userId);
    endPhoneScreen(userId, dropped.call);
  }
}
setInterval(sweepDroppedScreens, 15_000).unref();

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
    socket.data.roomId = session.roomId;
    next();
  });

  const broadcastVoice = (roomId: string) => io.to(roomChannel(roomId)).emit('voice_state', voiceState(roomId));
  const broadcastChannels = () => io.to(HOME).emit('channels', { channels: listChannels() });
  // Recordings and text channels exist only in the home room.
  connectRecordings({ voiceChanged: () => broadcastVoice(HOME_ROOM), messagePosted: message => io.to(HOME).emit('new_message', message) });

  // A phone's screen connection is closed on the server's side too when its owner leaves:
  // otherwise a phone whose app was killed would keep showing its screen to the call.
  function takeOutOfCall(userId: string, dropped = false) {
    const call = removeFromCall(userId);
    if (call?.phoneScreens.delete(userId)) {
      if (dropped) droppedScreens.set(userId, { call, since: Date.now() });
      else endPhoneScreen(userId, call);
    }
    return call;
  }
  function leaveCall(userId: string, dropped = false) {
    const call = takeOutOfCall(userId, dropped);
    if (call) broadcastVoice(call.roomId);
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    const roomId = socket.data.roomId as string;
    const room = roomChannel(roomId);
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

    if (!onlineByRoom.has(roomId)) onlineByRoom.set(roomId, new Map());
    const onlineUsers = onlineByRoom.get(roomId)!;
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
    socket.join(room);
    socket.join(`user:${userId}`);

    // Everything a client needs to draw the room is sent on every (re)connection, so state missed
    // while offline, or lost when the server restarted, is replaced rather than left stale.
    socket.emit('presence_state', { users: [...onlineUsers.keys()].map(profile).filter(Boolean) });
    socket.emit('channels', { channels: listChannels(roomId) });
    socket.emit('voice_state', voiceState(roomId));
    socket.to(room).emit('presence', { userId, online: true, user: me });

    // Calls, their chat and raised hands work in every room; what follows is for the rest.
    registerCallEvents();
    socket.on('disconnect', () => {
      forgetSocket(userId, socket.id);
      // The connection that joined a call carries it; if it drops, the app joins again when it
      // reconnects, so nobody is shown sitting in a call they have left.
      const call = callOf(userId);
      if (call?.members.get(userId) === socket.id) leaveCall(userId, true);
      const sockets = onlineUsers.get(userId);
      if (!sockets) return;
      sockets.delete(socket.id);
      if (sockets.size) return;
      onlineUsers.delete(userId);
      if (!onlineUsers.size) onlineByRoom.delete(roomId);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
      io.to(room).emit('presence', { userId, online: false, lastSeen: Date.now() });
    });

    // Text channels, which the app no longer shows, and managing channels belong to the home room
    // only, so nobody in a customer's room can read or change the friends' messages.
    if (roomId !== HOME_ROOM) return;
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
      io.to(HOME).emit('new_message', message);
      callback?.({ id });
      notifyNewMessage(message, getChannel(conversationId)!);
    });

    socket.on('edit_message', (data) => {
      if (!data || typeof data.messageId !== 'string' || typeof data.content !== 'string' || !data.content.trim() || data.content.length > 8000) return;
      const { messageId, content } = data;
      const msg = db.prepare("SELECT sender_id, conversation_id FROM messages WHERE id = ? AND type = 'text' AND deleted = 0").get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      const editedAt = Date.now();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, messageId);
      io.to(HOME).emit('message_edited', { messageId, content, editedAt });
    });

    // Nobody moderates the server, so everyone can delete only their own messages.
    socket.on('delete_message', (data) => {
      if (!data || typeof data.messageId !== 'string') return;
      const { messageId } = data;
      const msg = db.prepare('SELECT sender_id, attachment_id FROM messages WHERE id = ? AND deleted = 0').get(messageId) as any;
      if (!msg || msg.sender_id !== userId) return;

      db.prepare('UPDATE messages SET deleted = 1, content = NULL, file_name = NULL, attachment_id = NULL WHERE id = ?').run(messageId);
      if (msg.attachment_id) removeAttachmentIfUnused(msg.attachment_id);
      io.to(HOME).emit('message_deleted', { messageId });
    });

    socket.on('typing', (data) => {
      if (!data || !isTextChannel(data.conversationId)) return;
      socket.to(HOME).emit('user_typing', { conversationId: data.conversationId, userId, displayName: me?.displayName });
    });

    socket.on('stop_typing', (data) => {
      if (!data || !isTextChannel(data.conversationId)) return;
      socket.to(HOME).emit('user_stop_typing', { conversationId: data.conversationId, userId });
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
        broadcastVoice(HOME_ROOM);
      }
      broadcastChannels();
      reply({ ok: true });
    });

    function registerCallEvents() {
      // Like Discord, a person is in at most one voice channel; joining another moves them.
      socket.on('voice_join', (data: { channelId: unknown }, callback?: unknown) => {
        const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
        const channel = getChannel(data?.channelId, roomId);
        if (channel?.kind !== 'voice') return reply({ error: 'Unknown channel' });
        const previous = callOf(userId);
        if (previous && previous.channelId !== channel.id) {
          takeOutOfCall(userId);
          if (previous.roomId !== roomId) broadcastVoice(previous.roomId);
        }
        const startsCall = !getCall(channel.id);
        const call = addToCall(channel.id, roomId, userId, socket.id);
        // Back after a dropped connection: their phone's screen, still going, is theirs again.
        const dropped = droppedScreens.get(userId);
        if (dropped) {
          droppedScreens.delete(userId);
          if (dropped.call.channelId === channel.id) call.phoneScreens.add(userId);
          else endPhoneScreen(userId, dropped.call);
        }
        broadcastVoice(roomId);
        reply({ startedAt: call.startedAt });
        // Someone joining (or coming back) sees the chat so far, as far as it is theirs to see.
        socket.emit('call_chat_history', { messages: call.chat.filter(message => canSee(message, userId)).map(callChatPayload) });
        // An app coming back after a dropped connection (or a server restart) rejoins its call, which
        // is not news to anyone.
        if (startsCall && (data as { rejoin?: unknown })?.rejoin !== true) notifyCallStarted(channel, roomId, userId);
      });

      socket.on('voice_leave', () => leaveCall(userId));

      // The call's chat, to everyone in the call or privately to one of them. Only people in the call
      // can write in it, and only to people who are in it too.
      socket.on('call_chat_send', (data: { text?: unknown; to?: unknown }, callback?: unknown) => {
        const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
        const call = callOf(userId);
        if (!call) return reply({ error: 'Not in a call' });
        const text = typeof data?.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > MAX_CALL_CHAT_TEXT) return reply({ error: 'Invalid message' });
        const toId = data?.to == null ? null : data.to;
        if (toId !== null && (typeof toId !== 'string' || toId === userId || !call.members.has(toId))) return reply({ error: 'Not in the call' });
        const message: CallChatMessage = { id: uuid(), fromId: userId, toId, text, sentAt: Date.now() };
        call.chat.push(message);
        if (call.chat.length > MAX_CALL_CHAT) call.chat.shift();
        const payload = callChatPayload(message);
        const readers = toId ? [userId, toId] : [...call.members.keys()];
        for (const reader of readers) {
          const socketId = call.members.get(reader);
          if (socketId) io.to(socketId).emit('call_chat_message', payload);
        }
        reply({ ok: true });
      });

      // Whether this page is in front of its owner; people are only notified while none of theirs is.
      socket.on('app_active', (data: { active?: unknown }, callback?: unknown) => {
        setAppActive(userId, socket.id, data?.active === true);
        if (typeof callback === 'function') callback({ ok: true });
      });

      socket.on('raise_hand', (data: { channelId: string; raised: boolean }) => {
        if (!data || typeof data.raised !== 'boolean') return;
        const call = callOf(userId);
        if (!call || call.channelId !== data.channelId || data.raised === call.hands.has(userId)) return;
        if (data.raised) call.hands.set(userId, Date.now());
        else call.hands.delete(userId);
        broadcastVoice(call.roomId);
      });
    }
  });

  return io;
}
