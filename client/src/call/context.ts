import { inject, ref, shallowRef, type InjectionKey } from 'vue';
import type { Room } from 'livekit-client';
import type { OnlineUser } from '../types';
import type { usePhoto } from '../photo';
import type { Tile } from '../components/CallTile.vue';
import type { Toasts } from './toasts';
import type { Sound } from './sound';
import type { Microphone } from './microphone';
import type { ScreenShare } from './screenShare';
import type { TabletBoard } from './tabletBoard';
import type { FullScreen } from './fullScreen';
import type { TileLayout } from './layout';
import type { CallTiles } from './tiles';
import type { CallChat } from './chat';
import type { LiveKitRoom } from './room';

// The call screen is CallView.vue with its parts in this folder: each composable here does one job,
// and the components beside CallView.vue reach them through the call context below.

export type Sheet = 'participants' | 'more' | 'chat';
export type Status = 'joining' | 'connected' | 'reconnecting' | 'disconnected';
export type CallParticipant = { identity: string; name: string; local: boolean; micOn: boolean; speaking: boolean };

export interface CallProps {
  channelId: string; channelName: string; userId: string; visible: boolean;
  people: Map<string, OnlineUser>;
  hands: { userId: string; displayName: string }[];
  /** Chosen before joining: whether the microphone and camera start on. */
  startMic: boolean; startCamera: boolean;
}

export type CallUpdate = {
  micOn: boolean; cameraOn: boolean; sharing: boolean; speaking: string[];
};

// The LiveKit room is replaced on every rejoin, and Vue must not wrap LiveKit's objects, so the
// parts of the call share it, and what else changes with it, through this plain object.
export interface CallSession {
  room: Room | null;
  disposed: boolean;
  // Only on iPhones and iPads. The call keeps it across rejoins and resumes it itself, because
  // LiveKit only resumes a suspended mixer and an iPhone back from another app can leave it interrupted.
  audioContext?: AudioContext;
  // On Android, voices wait until the microphone is open (see room.ts).
  voicesWaiting: boolean;
}

// What the call screen shows, kept up to date from LiveKit by refresh() in tiles.ts.
export function createCallState() {
  return {
    status: ref<Status>('joining'),
    error: ref(''),
    micOn: ref(false),
    cameraOn: ref(false),
    sharingScreen: ref(false),
    sheet: ref<Sheet | null>(null),
    participants: ref<CallParticipant[]>([]),
    // Shallow, because each tile holds a LiveKit track that Vue must not wrap; the list is replaced whole.
    tiles: shallowRef<Tile[]>([]),
    focusedKey: ref<string | null>(null),
  };
}
export type CallState = ReturnType<typeof createCallState>;

export interface CallContext {
  props: CallProps;
  state: CallState;
  toasts: Toasts;
  sound: Sound;
  microphone: Microphone;
  screenShare: ScreenShare;
  tablet: TabletBoard;
  fullScreen: FullScreen;
  layout: TileLayout;
  tiles: CallTiles;
  chat: CallChat;
  room: LiveKitRoom;
  photo: ReturnType<typeof usePhoto>;
  openSheet: (sheet: Sheet) => void;
  closeSheet: () => void;
  toggleCamera: () => Promise<void>;
  toggleHand: () => void;
  leave: () => void;
}

export const callKey: InjectionKey<CallContext> = Symbol('call');

export function useCall() {
  const call = inject(callKey);
  if (!call) throw new Error('useCall() is only for the parts of the call screen');
  return call;
}
