import { ref, watch } from 'vue';
import { LocalAudioTrack, Track, type Room } from 'livekit-client';
import clipUrl from '../assets/yes.m4a?url';
import type { CallSession, CallState } from './context';

// Bilal's own button: one tap sends his recorded «نعم» to everyone in the call, so he can answer
// without unmuting. Only someone with his name sees it; it gives no power over anyone.
export const YES_BUTTON_NAME = 'بلال';
// The others' phones need a moment to start playing a sound that has only just appeared, or they
// would miss the start of the word. Later taps play at once, because the sound stays connected.
const FIRST_TAP_WAIT_MS = 800;

// The call server only takes the microphone, camera and screen as sources, so the word goes out as
// screen sound, which nobody's screen shows as anything. LiveKit stops a screen share by looking up
// the screen sound by that source, so the word is taken off the call while the screen is shared, or
// stopping the share could stop the word instead and leave the computer's sound going out.
export function useYes(session: CallSession, state: CallState) {
  const saying = ref(false);
  let context: AudioContext | undefined;
  let ownContext = false;
  let clip: Promise<AudioBuffer> | undefined;
  let sent: { room: Room; track: LocalAudioTrack; destination: MediaStreamAudioDestinationNode } | undefined;

  async function sayYes() {
    const room = session.room;
    if (!room || saying.value) return;
    saying.value = true;
    try {
      // On an iPhone, where a page gets few audio contexts, the call's mixer plays it.
      if (!context) { context = session.audioContext ?? new AudioContext(); ownContext = !session.audioContext; }
      const mixer = context;
      if (mixer.state !== 'running') await mixer.resume();
      clip ??= fetch(clipUrl).then(response => response.arrayBuffer()).then(data => mixer.decodeAudioData(data));
      const buffer = await clip;
      let wait = 0;
      // A rejoin replaces the room, so the sound is connected again to the new one.
      if (sent?.room !== room || !room.localParticipant.getTrackPublications().some(publication => publication.track === sent?.track)) {
        drop();
        const destination = mixer.createMediaStreamDestination();
        const track = new LocalAudioTrack(destination.stream.getAudioTracks()[0], undefined, false);
        await room.localParticipant.publishTrack(track, { name: 'yes', source: Track.Source.ScreenShareAudio });
        sent = { room, track, destination };
        wait = FIRST_TAP_WAIT_MS;
      }
      const { destination } = sent;
      await new Promise(resolve => setTimeout(resolve, wait));
      // Only sent, not played here: the echo canceller would have to take it out of the microphone.
      const source = new AudioBufferSourceNode(mixer, { buffer });
      source.connect(destination);
      await new Promise(resolve => { source.onended = resolve; source.start(); });
      source.disconnect();
      if (state.sharingScreen.value) drop();
    } catch {
      // A failed download is tried again on the next tap.
      clip = undefined;
    } finally {
      saying.value = false;
    }
  }

  function drop() {
    if (!sent) return;
    const { room, track } = sent;
    sent = undefined;
    if (room === session.room) void room.localParticipant.unpublishTrack(track).catch(() => {});
    track.stop();
  }
  watch(state.sharingScreen, sharing => { if (sharing && !saying.value) drop(); });

  return {
    saying, sayYes,
    dispose() {
      drop();
      if (ownContext) void context?.close().catch(() => {});
    },
  };
}
export type Yes = ReturnType<typeof useYes>;
