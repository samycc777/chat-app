import { Server } from 'socket.io';
import { Server as HttpServer } from 'http';
import { v4 as uuid } from 'uuid';
import db from './database';
import { verifyToken } from './auth';
import { getChannel, listChannels } from './channels';
import { roomChannel } from './rooms';
import { addToCall, allCalls, CallChatMessage, callOf, getCall, removeFromCall, screenIdentity, VoiceCall } from './voice';
import { removeFromLiveKit, roomService } from './livekit';
import { forgetSocket, notifyCallStarted, setAppActive } from './push';
import { avatarUrl, onProfileChanged } from './avatars';

// Who is online in each room, by room ID, then by user ID with their connections. Everyone in a
// room can see its call, so each connection joins its room's Socket.IO room.
const onlineByRoom = new Map<string, Map<string, Set<string>>>();

// Normal use (joining, chatting in the call, raising a hand) stays far below the soft limit. Events over it
// are dropped with an error reply instead of silently cutting someone off; only a client far
// beyond it is disconnected.
const EVENT_WINDOW_MS = 60_000;
const SOFT_EVENT_LIMIT = 120;
const HARD_EVENT_LIMIT = 600;

const profileQuery = db.prepare(`SELECT u.id, u.display_name AS displayName, u.avatar_color AS avatarColor, a.id AS avatarId
  FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = ?`);
function profile(userId: string) {
  const row = profileQuery.get(userId) as { id: string; displayName: string; avatarColor: string; avatarId: string | null } | undefined;
  return row && { id: row.id, displayName: row.displayName, avatarColor: row.avatarColor, avatarUrl: avatarUrl(row.avatarId) };
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
// kept going for a while instead of stopping in the middle of a lesson. A tablet sharing its screen
// runs the app in the background, where Android slows it down, so coming back can take minutes:
// the screen stops only once the wait is over and the owner is not in the call's sound and video
// either, for example because the app was killed.
export const DROPPED_SCREEN_MS = 5 * 60_000;
// Keyed by room and person, since the same person may share a screen in two rooms' calls.
const droppedScreens = new Map<string, { userId: string; call: VoiceCall; since: number }>();
const droppedKey = (roomId: string, userId: string) => `${roomId}\n${userId}`;
function endPhoneScreen(userId: string, call: VoiceCall, why: string) {
  console.log(`Stopping the shared screen of ${userId} in ${call.roomName}: ${why}`);
  void removeFromLiveKit(call.roomName, screenIdentity(userId), why);
}
async function stillInCall(userId: string, call: VoiceCall) {
  const service = roomService();
  if (!service) return false;
  try {
    return (await service.listParticipants(call.roomName)).some(participant => participant.identity === userId);
  } catch (error) {
    // LiveKit could not be asked; stopping a lesson's screen on a guess is worse than waiting.
    console.error(`Could not ask LiveKit whether ${userId} is still in ${call.roomName}:`, error);
    return true;
  }
}
export async function sweepDroppedScreens(now = Date.now()) {
  for (const [key, dropped] of droppedScreens) {
    if (now - dropped.since < DROPPED_SCREEN_MS) continue;
    const { userId } = dropped;
    if (await stillInCall(userId, dropped.call)) {
      // They may have come back in the meantime, which ends this wait on its own.
      if (droppedScreens.get(key) === dropped) dropped.since = now;
      continue;
    }
    if (droppedScreens.get(key) !== dropped) continue;
    droppedScreens.delete(key);
    endPhoneScreen(userId, dropped.call, `they did not come back within ${DROPPED_SCREEN_MS / 60_000} minutes`);
  }
}
setInterval(() => void sweepDroppedScreens(), 15_000).unref();

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
  // A new picture reaches everyone in the rooms its owner is in at once, in the list of people
  // and in the call, the way they would see it after reconnecting.
  onProfileChanged(userId => {
    const user = profile(userId);
    if (!user) return;
    for (const [roomId, online] of onlineByRoom) {
      if (!online.has(userId)) continue;
      io.to(roomChannel(roomId)).emit('presence', { userId, online: true, user });
      broadcastVoice(roomId);
    }
  });

  // A phone's screen connection is closed on the server's side too when its owner leaves:
  // otherwise a phone whose app was killed would keep showing its screen to the call.
  function takeOutOfCall(userId: string, roomId: string, dropped = false) {
    const call = removeFromCall(userId, roomId);
    if (call?.phoneScreens.delete(userId)) {
      if (dropped) {
        console.log(`The connection of ${userId}, who shares a screen in ${call.roomName}, dropped`);
        droppedScreens.set(droppedKey(roomId, userId), { userId, call, since: Date.now() });
      } else endPhoneScreen(userId, call, 'they left the call');
    }
    return call;
  }
  function leaveCall(userId: string, roomId: string, dropped = false) {
    const call = takeOutOfCall(userId, roomId, dropped);
    if (call) broadcastVoice(call.roomId);
    return call;
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

    registerCallEvents();
    socket.on('disconnect', () => {
      forgetSocket(userId, socket.id);
      // The connection that joined a call carries it; if it drops, the app joins again when it
      // reconnects, so nobody is shown sitting in a call they have left.
      const call = callOf(userId, roomId);
      if (call?.members.get(userId) === socket.id) leaveCall(userId, roomId, true);
      const sockets = onlineUsers.get(userId);
      if (!sockets) return;
      sockets.delete(socket.id);
      if (sockets.size) return;
      onlineUsers.delete(userId);
      if (!onlineUsers.size) onlineByRoom.delete(roomId);
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), userId);
      io.to(room).emit('presence', { userId, online: false, lastSeen: Date.now() });
    });

    function registerCallEvents() {
      // Like Discord, a person is in at most one voice channel of a room; joining another moves them.
      socket.on('voice_join', (data: { channelId: unknown }, callback?: unknown) => {
        const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
        const channel = getChannel(data?.channelId, roomId);
        if (channel?.kind !== 'voice') return reply({ error: 'Unknown channel' });
        const previous = callOf(userId, roomId);
        if (previous && previous.channelId !== channel.id) takeOutOfCall(userId, roomId);
        const startsCall = !getCall(channel.id);
        const call = addToCall(channel.id, roomId, userId, socket.id);
        // Back after a dropped connection: their phone's screen, still going, is theirs again.
        const dropped = droppedScreens.get(droppedKey(roomId, userId));
        if (dropped) {
          droppedScreens.delete(droppedKey(roomId, userId));
          if (dropped.call.channelId === channel.id) call.phoneScreens.add(userId);
          else endPhoneScreen(userId, dropped.call, 'they came back in another call');
        }
        broadcastVoice(roomId);
        reply({ startedAt: call.startedAt });
        // Someone joining (or coming back) sees the chat so far, as far as it is theirs to see.
        socket.emit('call_chat_history', { messages: call.chat.filter(message => canSee(message, userId)).map(callChatPayload) });
        // An app coming back after a dropped connection (or a server restart) rejoins its call, which
        // is not news to anyone.
        if (startsCall && (data as { rejoin?: unknown })?.rejoin !== true) notifyCallStarted(channel, roomId, userId);
      });

      // Leaving on purpose also ends their sound and video in LiveKit, so an app that keeps its
      // connection open (or a copied pass) cannot go on listening once the call no longer shows them.
      // A dropped connection does not: a tablet teaching from the background loses its connection
      // to this server for minutes at a time while its sound and screen carry on (see droppedScreens).
      socket.on('voice_leave', () => {
        const call = leaveCall(userId, roomId);
        if (call && !getCall(call.channelId)?.members.has(userId)) void removeFromLiveKit(call.roomName, userId, 'they left the call');
      });

      // The call's chat, to everyone in the call or privately to one of them. Only people in the call
      // can write in it, and only to people who are in it too.
      socket.on('call_chat_send', (data: { text?: unknown; to?: unknown }, callback?: unknown) => {
        const reply = (payload: object) => { if (typeof callback === 'function') callback(payload); };
        const call = callOf(userId, roomId);
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
        const call = callOf(userId, roomId);
        if (!call || call.channelId !== data.channelId || data.raised === call.hands.has(userId)) return;
        if (data.raised) call.hands.set(userId, Date.now());
        else call.hands.delete(userId);
        broadcastVoice(call.roomId);
      });
    }
  });

  return io;
}
