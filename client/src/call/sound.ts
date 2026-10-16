import { ref, watch } from 'vue';
import { Track, type RemoteAudioTrack, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import { useI18n } from '../i18n';
import { cleanMicrophone } from './microphone';
import type { CallSession } from './context';

// The call's sound: the other people's voices, how loud each one plays on this device, and the
// browser's audio mixer on iPhones.

const VOLUME_KEY = 'callVolume';
const PERSON_VOLUMES_KEY = 'callVolumes';
// Every voice is sent at the same level (see levelVoiceWorklet.js). The friends asked for the
// teacher's voice (Ayman2) to be louder than the others: 30%, then 20% more after a lesson. Voices are
// sent as loud as they can go without crackling, so his cannot be sent louder; instead everyone
// else's is played softer.
const LOUDER_VOICES = new Set(['ayman2']);
const SOFTER_THAN_LOUDER = 1 / (1.3 * 1.2);
// The sliders stop short of silence, so a call never starts inaudible because of last week's
// setting; the speaker button is there for turning the sound off.
export const MIN_VOLUME = 0.1;
const volumeAdjustable = (() => {
  try { const probe = new Audio(); probe.volume = 0.5; return probe.volume === 0.5; } catch { return false; }
})();
// iPhones and iPads ignore a page's volume, so there the voices are played through the browser's
// audio mixer instead. Everywhere else they stay in plain audio elements: Chrome's echo cancellation
// does not hear the mixer, and someone on speaker would send everyone's voices back to the call.
const webAudioVolume = !volumeAdjustable && typeof AudioContext === 'function';
export const canAdjustVolume = volumeAdjustable || webAudioVolume;

const clampVolume = (level: number) => Math.min(1, Math.max(MIN_VOLUME, level));
// Remembered on this device only, so everyone keeps the level that suits their speaker.
function savedVolume() {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
    return Number.isFinite(saved) ? clampVolume(saved) : 1;
  } catch { return 1; }
}
// Each person's level is remembered the same way, so a loud friend turned down stays down next time.
function savedPersonVolumes() {
  const levels: Record<string, number> = {};
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PERSON_VOLUMES_KEY) ?? '{}');
    if (saved && typeof saved === 'object') {
      for (const [identity, level] of Object.entries(saved)) if (Number.isFinite(level)) levels[identity] = clampVolume(level);
    }
  } catch { /* Nothing saved yet, or private browsing: everyone starts at full volume. */ }
  return levels;
}

export function useSound(session: CallSession, showToast: (message: string) => void) {
  const { t } = useI18n();
  const audioBlocked = ref(false);
  const soundOn = ref(true);
  const volume = ref(savedVolume());
  const personVolumes = ref(savedPersonVolumes());
  const detachedAudio: HTMLMediaElement[] = [];

  function attachAudio(track: RemoteTrack, participant: RemoteParticipant) {
    if (session.disposed || session.voicesWaiting || track.kind !== Track.Kind.Audio) return;
    // connect() attaches the voices that were already there, which LiveKit may have handed over
    // through TrackSubscribed as well; a second element would play the same voice twice, distorted.
    if (track.attachedElements.length) return;
    const element = track.attach() as HTMLAudioElement;
    element.autoplay = true;
    element.addEventListener('pause', resumeSound);
    document.body.appendChild(element);
    detachedAudio.push(element);
    applyVoice(track as RemoteAudioTrack, participant.identity);
  }
  function detachAudio(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio) return;
    for (const element of track.detach()) {
      const index = detachedAudio.indexOf(element);
      if (index !== -1) detachedAudio.splice(index, 1);
      element.remove();
    }
  }
  function removeVoices() { detachedAudio.splice(0).forEach(element => element.remove()); }

  // Each voice plays at the call's volume times the volume chosen for that person, softened beside Ayman2's.
  function applyVoice(track: RemoteAudioTrack, identity: string) {
    const name = (session.room?.remoteParticipants.get(identity)?.name ?? '').trim().toLowerCase();
    const level = volume.value * levelOf(identity) * (LOUDER_VOICES.has(name) ? 1 : SOFTER_THAN_LOUDER);
    // The mixer plays the voice while LiveKit keeps its element muted; unmuting it would play it twice.
    if (webAudioVolume) { track.setVolume(soundOn.value ? level : 0); return; }
    track.attachedElements.forEach(element => { element.muted = !soundOn.value; });
    track.setVolume(level);
  }
  function applySound() {
    for (const participant of session.room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.audioTrack) applyVoice(publication.audioTrack as RemoteAudioTrack, participant.identity);
      }
    }
  }
  watch(volume, level => {
    applySound();
    try { localStorage.setItem(VOLUME_KEY, String(level)); } catch { /* Private browsing: the level lasts for this call. */ }
  });
  function levelOf(identity: string) { return personVolumes.value[identity] ?? 1; }
  function setPersonVolume(identity: string, level: number) {
    personVolumes.value = { ...personVolumes.value, [identity]: clampVolume(level) };
    applySound();
    try { localStorage.setItem(PERSON_VOLUMES_KEY, JSON.stringify(personVolumes.value)); } catch { /* Lasts for this call. */ }
  }

  // On an iPhone the mixer is the sound, so the "tap to turn on sound" button follows whether it is running.
  function onMixerStateChange() {
    if (!session.disposed && session.audioContext) audioBlocked.value = session.audioContext.state !== 'running';
  }
  // Made as the call opens, still within the tap on the voice channel, which is when an iPhone is
  // most likely to let it start without asking for another tap. It runs at 48 kHz, the only rate the
  // noise filter on the microphone understands, since that filter runs in the same mixer.
  function createMixer() {
    if (!webAudioVolume) return;
    try { session.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 }); } catch { return; }
    session.audioContext.addEventListener('statechange', onMixerStateChange);
    resumeMixer();
  }
  function resumeMixer() {
    const mixer = session.audioContext;
    if (mixer && mixer.state !== 'running' && mixer.state !== 'closed') void mixer.resume().catch(() => {});
  }
  function closeMixer() {
    session.audioContext?.removeEventListener('statechange', onMixerStateChange);
    void session.audioContext?.close().catch(() => {});
    session.audioContext = undefined;
  }
  // A phone pauses the call's sound when another app takes the speaker or the browser is put away,
  // and nothing starts it again by itself, so it is restarted whenever the page is back in view.
  function resumeSound() {
    if (session.disposed || document.visibilityState !== 'visible') return;
    resumeMixer();
    for (const element of detachedAudio) {
      if (!element.paused) continue;
      element.play().catch((cause: unknown) => {
        // Only a browser that wants a tap first is worth the "tap to turn on sound" button.
        if (!session.disposed && cause instanceof DOMException && cause.name === 'NotAllowedError') audioBlocked.value = true;
      });
    }
  }
  async function toggleSound() {
    if (audioBlocked.value) { await enableAudio(); return; }
    soundOn.value = !soundOn.value;
    applySound();
    // Tapping the speaker always brings the sound back, even if the phone had paused it.
    if (soundOn.value) resumeSound();
  }
  async function enableAudio() {
    // An iPhone only lets the mixer start from within the tap itself.
    resumeMixer();
    try { await session.room?.startAudio(); audioBlocked.value = false; soundOn.value = true; applySound(); } catch { showToast(t('voicePlaybackBlocked')); return; }
    // The page's audio is running again, so a microphone that was sent as recorded can be cleaned again.
    await cleanMicrophone(session.room);
  }

  return {
    audioBlocked, soundOn, volume, levelOf, setPersonVolume,
    attachAudio, detachAudio, removeVoices, createMixer, closeMixer, resumeSound, toggleSound, enableAudio,
  };
}
export type Sound = ReturnType<typeof useSound>;
