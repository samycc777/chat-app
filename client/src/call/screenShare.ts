import { AudioPresets } from 'livekit-client';
import { api, ApiError } from '../api';
import { useI18n } from '../i18n';
import {
  onPhoneScreenShareStopped, phoneScreenShareAvailable, SCREEN_SUFFIX, startPhoneScreenShare, stopPhoneScreenShare, wasCancelled,
} from '../nativeScreenShare';
import type { CallProps, CallSession, CallState } from './context';

// Computers share their screen from the browser, and the Android app from its own code; phone
// browsers and the iPhone app cannot share yet.
export const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function' || phoneScreenShareAvailable;

// A phone's screen arrives as a participant of its own, which stands for its owner's screen rather
// than for another person.
export const phoneScreenOf = (userId: string) => `${userId}${SCREEN_SUFFIX}`;
export const ownerOf = (identity: string) => identity.endsWith(SCREEN_SUFFIX) ? identity.slice(0, -SCREEN_SUFFIX.length) : identity;

export function useScreenShare(session: CallSession, state: CallState, options: {
  props: CallProps;
  showToast: (message: string) => void;
  refresh: () => void;
}) {
  const { t, translateError } = useI18n();
  const { props, showToast, refresh } = options;
  // Set while the Android app asks for the screen, so a second tap does not start a second share.
  const phoneShare = { starting: false };
  const phoneShareListener = onPhoneScreenShareStopped(() => refresh());

  async function togglePhoneScreenShare() {
    if (phoneShare.starting) return;
    phoneShare.starting = true;
    try {
      if (state.sharingScreen.value) await stopPhoneScreenShare();
      else await startPhoneScreenShare(await api.getScreenToken(props.channelId));
    } catch (cause) {
      if (!wasCancelled(cause)) showToast(cause instanceof ApiError ? translateError(cause.message) : t('screenShareFailed'));
    } finally {
      phoneShare.starting = false;
    }
    refresh();
  }
  async function toggleScreenShare() {
    const room = session.room;
    if (!room) return;
    if (!canShareScreen) { showToast(t('screenShareUnsupported')); return; }
    if (phoneScreenShareAvailable) { await togglePhoneScreenShare(); return; }
    try {
      // A shared browser tab can bring its sound along, for watching a video together. That sound
      // keeps a fuller quality than a microphone's, since it is not always one clear voice.
      await room.localParticipant.setScreenShareEnabled(!state.sharingScreen.value, {
        audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
      }, { audioPreset: AudioPresets.music });
    } catch { /* The browser's screen picker was closed. */ }
    refresh();
  }

  return {
    toggleScreenShare,
    // The phone's screen is a separate connection, so it would keep going after the call closes.
    stopPhoneShare() { if (state.sharingScreen.value && phoneScreenShareAvailable) void stopPhoneScreenShare().catch(() => {}); },
    dispose() { void phoneShareListener?.remove(); },
  };
}
export type ScreenShare = ReturnType<typeof useScreenShare>;
