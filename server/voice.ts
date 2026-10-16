/** A message in a call's chat, to everyone in it or to one person (toId). */
export interface CallChatMessage {
  id: string;
  fromId: string;
  toId: string | null;
  text: string;
  sentAt: number;
}

export interface VoiceCall {
  channelId: string;
  /** The room whose call this is; only people in that room see it or can join it. */
  roomId: string;
  roomName: string;
  startedAt: number;
  /** Who is in the call, by user ID, with the socket that joined it. */
  members: Map<string, string>;
  /** Raised hands, by user ID, with the time each was raised. */
  hands: Map<string, number>;
  /** People who were given a pass for sharing their phone's screen, by user ID. */
  phoneScreens: Set<string>;
  /** The call's chat. It is kept only here, so it is gone as soon as the last person leaves. */
  chat: CallChatMessage[];
}

// The phone apps cannot share the screen from their web page, so the app's own Android code joins
// the call a second time just for the screen. That connection has its own identity, which every
// call screen recognises and shows as its owner's screen rather than as another person.
export const SCREEN_SUFFIX = ':screen';
export const screenIdentity = (userId: string) => `${userId}${SCREEN_SUFFIX}`;

// Calls live only in memory: a voice channel's call starts when the first person joins and ends
// when the last one leaves, and a server restart simply empties every channel.
const calls = new Map<string, VoiceCall>();

export function getCall(channelId: string): VoiceCall | undefined {
  return calls.get(channelId);
}

export function allCalls(roomId?: string): VoiceCall[] {
  return [...calls.values()].filter(call => roomId === undefined || call.roomId === roomId);
}

// One person can be in two rooms at once (on two devices, or two invite links on one), so a call is
// always looked up within the room of the session asking: a session from one room must never be
// able to leave, chat in or raise a hand in another room's call.
export function callOf(userId: string, roomId: string): VoiceCall | undefined {
  return allCalls(roomId).find(call => call.members.has(userId));
}

export function addToCall(channelId: string, roomId: string, userId: string, socketId: string): VoiceCall {
  let call = calls.get(channelId);
  if (!call) {
    // The room name is fixed per channel, so everyone who joins the channel meets in one LiveKit room.
    call = { channelId, roomId, roomName: `voice-${channelId}`, startedAt: Date.now(), members: new Map(), hands: new Map(), phoneScreens: new Set(), chat: [] };
    calls.set(channelId, call);
  }
  call.members.set(userId, socketId);
  return call;
}

/** Returns the call the user was in, if any. */
export function removeFromCall(userId: string, roomId: string): VoiceCall | undefined {
  const call = callOf(userId, roomId);
  if (!call) return undefined;
  call.members.delete(userId);
  call.hands.delete(userId);
  if (!call.members.size) calls.delete(call.channelId);
  return call;
}

export function endCall(channelId: string): VoiceCall | undefined {
  const call = calls.get(channelId);
  calls.delete(channelId);
  return call;
}
