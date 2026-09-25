/** A recording in progress, made in the browser of the person who started it. */
export interface CallRecording {
  id: string;
  userId: string;
  startedAt: number;
}

export interface VoiceCall {
  channelId: string;
  roomName: string;
  startedAt: number;
  /** Who is in the call, by user ID, with the socket that joined it. */
  members: Map<string, string>;
  /** Raised hands, by user ID, with the time each was raised. */
  hands: Map<string, number>;
  /** People who were given a pass for sharing their phone's screen, by user ID. */
  phoneScreens: Set<string>;
  /** Everyone in the call is shown that it is being recorded, and by whom. */
  recording?: CallRecording;
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

export function allCalls(): VoiceCall[] {
  return [...calls.values()];
}

export function callOf(userId: string): VoiceCall | undefined {
  return allCalls().find(call => call.members.has(userId));
}

export function addToCall(channelId: string, userId: string, socketId: string): VoiceCall {
  let call = calls.get(channelId);
  if (!call) {
    // The room name is fixed per channel, so everyone who joins the channel meets in one LiveKit room.
    call = { channelId, roomName: `voice-${channelId}`, startedAt: Date.now(), members: new Map(), hands: new Map(), phoneScreens: new Set() };
    calls.set(channelId, call);
  }
  call.members.set(userId, socketId);
  return call;
}

/** Returns the call the user was in, if any. */
export function removeFromCall(userId: string): VoiceCall | undefined {
  const call = callOf(userId);
  if (!call) return undefined;
  call.members.delete(userId);
  call.hands.delete(userId);
  // A recording is made on its recorder's device, so it cannot go on once they have left.
  if (call.recording?.userId === userId) call.recording = undefined;
  if (!call.members.size) calls.delete(call.channelId);
  return call;
}

export function endCall(channelId: string): VoiceCall | undefined {
  const call = calls.get(channelId);
  calls.delete(channelId);
  return call;
}
