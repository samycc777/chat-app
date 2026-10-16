import { ref, watch, type Ref } from 'vue';
import { createLocalAudioTrack, MediaDeviceFailure, Track, type AudioCaptureOptions, type LocalAudioTrack, type Room } from 'livekit-client';
import { useI18n } from '../i18n';
import { cleanVoice, prepareCleanVoice, type CleanVoice } from '../cleanVoice';
import { inMiniWindow, keepPhoneCallGoing } from '../nativeCall';
import type { CallSession, CallState } from './context';

// Louder than this on the muted microphone, for most of a second, is someone talking.
const MUTED_SPEECH_DB = -40;
const MUTED_HINT_EVERY_MS = 20_000;

// Every voice sent from the website is cleaned of noise, warmed and made a little louder; if that is not
// possible, it goes out as recorded.
export async function cleanMicrophone(room: Room | null) {
  const microphone = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  if (!microphone || microphone.getProcessor()) return;
  const voice = cleanVoice();
  try { await microphone.setProcessor(voice); } catch { /* Friends still hear the voice, just not cleaned. */ }
  // The microphone was opened without the browser's own noise filter and leveling, because ours were
  // going to replace them; if ours could not start after all, the browser's are brought back.
  if ((voice.denoising && voice.leveling) || recorded(microphone).getSettings().noiseSuppression !== false) return;
  try { await microphone.restartTrack({ noiseSuppression: true, voiceIsolation: true, autoGainControl: true }); } catch { /* It keeps the voice as it was. */ }
}
// With the voice cleaned, LiveKit's track is the cleaned one, which is silent while muted.
function recorded(microphone: LocalAudioTrack) {
  return (microphone.getProcessor() as CleanVoice | undefined)?.recordedTrack ?? microphone.mediaStreamTrack;
}
// Our noise filter replaces the browser's own: two filters in a row make voices sound watery. Our
// leveling replaces the browser's too: while someone was silent, the browser's slowly turned them up
// until the sounds of their house were as loud as a voice (see levelVoiceWorklet.js). The browser
// still takes out the echo of the call's own sound. This only counts the first time, when the
// microphone is opened; later, turning it on just unmutes it.
async function microphoneOptions(): Promise<AudioCaptureOptions | undefined> {
  return await prepareCleanVoice() ? { noiseSuppression: false, voiceIsolation: false, autoGainControl: false } : undefined;
}

export function useMicrophone(session: CallSession, options: {
  state: CallState;
  visible: () => boolean;
  audioBlocked: Ref<boolean>;
  enableAudio: () => Promise<void>;
  showToast: (message: string, duration?: number) => void;
  refresh: () => void;
}) {
  const { t } = useI18n();
  const { state, audioBlocked, enableAudio, showToast, refresh } = options;
  // Stays true until the microphone works, so what to fix is still on screen after the notice is gone.
  const micBlocked = ref(false);
  let stopListeningWhileMuted: (() => void) | undefined;
  let listeningContext: AudioContext | undefined;
  let lastMutedHintAt = 0;

  // Opens the microphone without sending anything, only so the phone treats the call's sound as a
  // call's (see onAndroid in room.ts). Turning the microphone on later just unmutes it.
  async function openMutedMicrophone() {
    if (!session.room) return;
    try {
      const microphone = await createLocalAudioTrack({ ...session.room.options.audioCaptureDefaults, ...await microphoneOptions() });
      await microphone.mute();
      if (session.disposed || !session.room) { microphone.stop(); return; }
      await session.room.localParticipant.publishTrack(microphone, { source: Track.Source.Microphone });
      await cleanMicrophone(session.room);
    } catch { /* Not allowed to use the microphone: the voices still play, just perhaps with an echo. */ }
  }
  async function setMicrophone(enabled: boolean) {
    if (!session.room) return;
    try {
      if (enabled && audioBlocked.value) await enableAudio();
      // Read again, because a rejoin may have replaced the room meanwhile.
      await session.room!.localParticipant.setMicrophoneEnabled(enabled, enabled ? await microphoneOptions() : undefined);
      if (enabled) await cleanMicrophone(session.room);
      // The first time, the phone has only just been allowed to use the microphone.
      if (enabled) keepPhoneCallGoing();
      micBlocked.value = false;
    } catch (cause) {
      micBlocked.value = true;
      // Instructions to follow take longer to read than a notice.
      showToast(microphoneProblem(cause), 10_000);
    } finally {
      refresh();
    }
  }
  // A friend whose microphone will not turn on needs to know what to fix: the browser, the computer
  // (Windows can block every browser at once), another app holding it, or no microphone at all.
  function microphoneProblem(cause: unknown) {
    const failure = cause instanceof Error ? MediaDeviceFailure.getFailure(cause) : undefined;
    if (failure === MediaDeviceFailure.NotFound) return t('micNotFound');
    if (failure === MediaDeviceFailure.DeviceInUse) return t('micInUse');
    // Chrome and Edge say "Permission denied by system" when the computer, not the page, refused.
    if (failure === MediaDeviceFailure.PermissionDenied && /system/i.test((cause as Error).message)) {
      return t(/Mac/.test(navigator.userAgent) ? 'micBlockedByMac' : 'micBlockedByWindows');
    }
    return t('micBlocked');
  }
  // Talking while muted gets a reminder, as in Zoom. A copy of the microphone is listened to on this
  // device only; it is never sent, and it is let go as soon as the microphone is turned back on.
  function listenWhileMuted() {
    const microphone = session.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    if (!microphone || recorded(microphone).readyState !== 'live') return;
    // On an iPhone, where a page gets few audio contexts, the call's mixer does the listening.
    let context = session.audioContext;
    try { context ??= listeningContext ??= new AudioContext(); } catch { return; }
    const copy = recorded(microphone).clone();
    copy.enabled = true;
    const source = context.createMediaStreamSource(new MediaStream([copy]));
    const lowCut = new BiquadFilterNode(context, { type: 'highpass', frequency: 150 });
    const analyser = new AnalyserNode(context, { fftSize: 2048 });
    // Some browsers only listen to what reaches the speakers, so the copy goes there, silenced.
    const silent = new GainNode(context, { gain: 0 });
    source.connect(lowCut).connect(analyser).connect(silent).connect(context.destination);
    const samples = new Float32Array(analyser.fftSize);
    const recent: boolean[] = [];
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      analyser.getFloatTimeDomainData(samples);
      let power = 0;
      for (const sample of samples) power += sample * sample;
      recent.push(10 * Math.log10(power / samples.length || 1e-12) > MUTED_SPEECH_DB);
      if (recent.length > 15) recent.shift();
      // A cough or a door is shorter than this; talking fills most of the last second and a half.
      if (recent.filter(Boolean).length < 7 || Date.now() - lastMutedHintAt < MUTED_HINT_EVERY_MS) return;
      lastMutedHintAt = Date.now();
      recent.length = 0;
      showToast(t('youAreMuted'));
    }, 100);
    stopListeningWhileMuted = () => {
      clearInterval(timer);
      [source, lowCut, analyser, silent].forEach(node => node.disconnect());
      copy.stop();
      stopListeningWhileMuted = undefined;
    };
  }
  // Only while the call is on screen: someone reading a text channel may well be talking to someone at home.
  watch(() => [state.micOn.value, state.status.value, options.visible(), inMiniWindow.value] as const, ([on, status, visible, mini]) => {
    const wanted = !on && status === 'connected' && visible && !mini;
    if (!wanted) stopListeningWhileMuted?.();
    else if (!stopListeningWhileMuted) listenWhileMuted();
  });

  return {
    micBlocked, setMicrophone, openMutedMicrophone,
    stopListening: () => stopListeningWhileMuted?.(),
    dispose() {
      stopListeningWhileMuted?.();
      void listeningContext?.close().catch(() => {});
    },
  };
}
export type Microphone = ReturnType<typeof useMicrophone>;
