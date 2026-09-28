import { ref } from 'vue';
import type { Socket } from 'socket.io-client';
import { getSocket } from './socket';

/** A message in the call's chat: to everyone in the call, or privately to one person (to). */
export interface CallChatMessage {
  id: string;
  from: { id: string; displayName: string };
  to: { id: string; displayName: string } | null;
  text: string;
  sentAt: number;
}

// The chat lives only on the server, in memory, for as long as the call lasts; this is this
// device's copy of what it may see of it. Joining the call (or coming back to it) replaces it with
// the server's, so nothing is kept after the call.
export const callChat = ref<CallChatMessage[]>([]);
const listeners = new Set<(message: CallChatMessage) => void>();

export function listenForCallChat(socket: Socket) {
  socket.on('call_chat_history', ({ messages }: { messages: CallChatMessage[] }) => { callChat.value = messages; });
  socket.on('call_chat_message', (message: CallChatMessage) => {
    callChat.value = [...callChat.value, message];
    for (const listener of listeners) listener(message);
  });
}

/** Called for each new message as it arrives, not for the history given on joining. */
export function onCallChatMessage(listener: (message: CallChatMessage) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function clearCallChat() {
  callChat.value = [];
}

/** Resolves with the server's error, or nothing once the message is sent. */
export function sendCallChat(text: string, to: string | null): Promise<string | undefined> {
  const socket = getSocket();
  if (!socket?.connected) return Promise.resolve('Network error');
  return new Promise(resolve => {
    socket.timeout(10_000).emit('call_chat_send', { text, to }, (timedOut: Error | null, result?: { error?: string }) => {
      resolve(timedOut ? 'Network error' : result?.error);
    });
  });
}
