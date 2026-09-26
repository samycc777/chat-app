<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  Circle, Ellipsis, Hand, Maximize, Menu, Mic, MicOff, Minimize, PhoneOff, RotateCcw, ScreenShare, ScreenShareOff,
  Square, Users, Video, VideoOff, Volume1, Volume2, VolumeX, WifiOff, X, ZoomOut,
} from 'lucide-vue-next';
import {
  ConnectionQuality, DisconnectReason, Room, RoomEvent, Track, VideoPresets, type AudioCaptureOptions, type LocalAudioTrack, type Participant, type RemoteAudioTrack, type RemoteParticipant,
  type RemoteTrack, type RemoteTrackPublication, type VideoTrack,
} from 'livekit-client';
import { api, ApiError } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import { cleanVoice, prepareCleanVoice, type CleanVoice } from '../cleanVoice';
import {
  bridge, onPhoneScreenShareStopped, phoneScreenShareAvailable, SCREEN_SUFFIX, startPhoneScreenShare, stopPhoneScreenShare, wasCancelled,
} from '../nativeScreenShare';
import {
  endPhoneCall, inMiniWindow, keepPhoneCallGoing, onPhoneCallLeave, onPhoneFullScreenExit, phoneFullScreenAvailable, setMiniWindow,
  setPhoneFullScreen,
} from '../nativeCall';
import { canRecord, isRecording, startRecording, stopRecording } from '../callRecorder';
import { recordingState } from '../recordingState';
import type { OnlineUser, VoiceCall } from '../types';
import Avatar from './Avatar.vue';
import CallTile, { type Tile } from './CallTile.vue';

type Sheet = 'participants' | 'more';
type Status = 'joining' | 'connected' | 'reconnecting' | 'disconnected';
type CallMessage = { type: 'reaction'; emoji: string };
type CallParticipant = { identity: string; name: string; local: boolean; micOn: boolean; speaking: boolean };

// None of the reactions has a face.
const REACTIONS = ['👍', '❤️', '👏', '🤲', '✅', '🎉'];
const VOLUME_KEY = 'callVolume';
const PERSON_VOLUMES_KEY = 'callVolumes';
const ZOOM_HINT_KEY = 'zoomHintSeen';
// Louder than this on the muted microphone, for most of a second, is someone talking.
const MUTED_SPEECH_DB = -40;
const MUTED_HINT_EVERY_MS = 20_000;
// The sliders stop short of silence, so a call never starts inaudible because of last week's
// setting; the speaker button is there for turning the sound off.
const MIN_VOLUME = 0.1;
const volumeAdjustable = (() => {
  try { const probe = new Audio(); probe.volume = 0.5; return probe.volume === 0.5; } catch { return false; }
})();
// iPhones and iPads ignore a page's volume, so there the voices are played through the browser's
// audio mixer instead. Everywhere else they stay in plain audio elements: Chrome's echo cancellation
// does not hear the mixer, and someone on speaker would send everyone's voices back to the call.
const webAudioVolume = !volumeAdjustable && typeof AudioContext === 'function';
const canAdjustVolume = volumeAdjustable || webAudioVolume;
// Computers share their screen from the browser, and the Android app from its own code; phone
// browsers and the iPhone app cannot share yet.
const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function' || phoneScreenShareAvailable;
const FALLBACK_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b84ee'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const props = defineProps<{
  channelId: string; channelName: string; userId: string; visible: boolean;
  people: Map<string, OnlineUser>;
  hands: { userId: string; displayName: string }[];
  /** Who is recording this call, as the server tells everyone in it. */
  recording?: VoiceCall['recording'];
}>();
const emit = defineEmits<{
  leave: []; menu: [];
  state: [state: { micOn: boolean; cameraOn: boolean; sharing: boolean; speaking: string[] }];
}>();
const { t, translateError } = useI18n();
const root = ref<HTMLElement>();
const status = ref<Status>('joining');
const error = ref('');
const micOn = ref(false);
const cameraOn = ref(false);
const sharingScreen = ref(false);
let phoneShareStarting = false;
const phoneShareListener = onPhoneScreenShareStopped(() => refresh());
const phoneLeaveListener = onPhoneCallLeave(() => leave());
const phoneFullScreenListener = onPhoneFullScreenExit(() => exitFullScreen());
const audioBlocked = ref(false);
const soundOn = ref(true);
const volume = ref(savedVolume());
const personVolumes = ref(savedPersonVolumes());
const sheet = ref<Sheet | null>(null);
const participants = ref<CallParticipant[]>([]);
// Shallow, because each tile holds a LiveKit track that Vue must not wrap; the list is replaced whole.
const tiles = shallowRef<Tile[]>([]);
const focusedKey = ref<string | null>(null);
const lastSpeakerKey = ref('');
const raisedHands = computed(() => new Set(props.hands.map(hand => hand.userId)));
const reactions = ref<{ id: number; emoji: string; name: string; drift: number }[]>([]);
const toast = ref('');
const weakConnection = ref(false);
const startedAt = ref(0);
const now = ref(Date.now());
// The tile shown full screen, alone over everything else, and whether its bar of buttons is showing.
const fullKey = ref<string | null>(null);
const fullBarShown = ref(true);
const fullTileView = ref<InstanceType<typeof CallTile>>();
// Inside the phone apps, Capacitor cancels a page's full screen as soon as it starts, so there the
// call fills the app itself, and the Android app hides the phone's bars.
const browserFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled && !bridge;
const landscapeQuery = window.matchMedia('(orientation: landscape)');
let room: Room | null = null;
// Only on iPhones and iPads. The call keeps it across rejoins and resumes it itself, because
// LiveKit only resumes a suspended mixer and an iPhone back from another app can leave it interrupted.
let audioContext: AudioContext | undefined;
let wakeLock: WakeLockSentinel | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let fullBarTimer: ReturnType<typeof setTimeout> | undefined;
let weakTimer: ReturnType<typeof setTimeout> | undefined;
let stopListeningWhileMuted: (() => void) | undefined;
let listeningContext: AudioContext | undefined;
let lastMutedHintAt = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let reactionId = 0;
let lastReactionAt = 0;
let disposed = false;
let rejoinWhenVisible = false;
let lastAutoRejoinAt = 0;
const detachedAudio: HTMLMediaElement[] = [];

const myHandRaised = computed(() => raisedHands.value.has(props.userId));
const recordingHere = computed(() => recordingState.phase === 'recording' && recordingState.voiceChannelId === props.channelId);
const elapsed = computed(() => {
  if (!startedAt.value) return '';
  const seconds = Math.max(0, Math.floor((now.value - startedAt.value) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const clock = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return hours ? `${hours}:${clock}` : clock;
});
const focusedTile = computed(() => tiles.value.find(tile => tile.key === focusedKey.value) ?? null);
const otherTiles = computed(() => tiles.value.filter(tile => tile.key !== focusedKey.value));
const fullTile = computed(() => tiles.value.find(tile => tile.key === fullKey.value) ?? null);
const fullZoomed = computed(() => Boolean(fullTileView.value?.zoomed));
// A tile with a video to look at; your own shared screen is never shown back to you.
const watchable = (tile: Tile) => Boolean(tile.track) && !(tile.local && tile.kind === 'screen');
// What Full screen in the More menu shows: the big tile, else a shared screen, else a camera.
const fullScreenChoice = computed(() => {
  const videos = tiles.value.filter(watchable);
  return videos.find(tile => tile.key === focusedKey.value) ?? videos.find(tile => tile.kind === 'screen')
    ?? videos.find(tile => !tile.local) ?? videos[0] ?? null;
});
// The one video the Android app shows in its small window over other apps: the one made big, else
// a shared screen, else whoever spoke last with their camera on. Never your own video, and nothing
// while you share your screen, because the small window would then appear in what you share.
const miniTile = computed(() => {
  if (sharingScreen.value) return null;
  const watchable = tiles.value.filter(tile => !tile.local && tile.track);
  return watchable.find(tile => tile.key === focusedKey.value) ?? watchable.find(tile => tile.kind === 'screen')
    ?? watchable.find(tile => tile.key === lastSpeakerKey.value) ?? watchable[0] ?? null;
});
const miniSpeaker = computed(() => participants.value.find(person => person.speaking && !person.local) ?? null);
// Columns grow with the number of tiles, so everyone stays as large as the screen allows; a phone
// held upright stacks them instead.
const narrow = ref(window.innerWidth < 700);
function onResize() { narrow.value = window.innerWidth < 700; }
const gridStyle = computed(() => {
  const count = Math.max(1, tiles.value.length);
  const columns = narrow.value ? (count <= 2 ? 1 : 2) : Math.ceil(Math.sqrt(count));
  return { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(count / columns)}, minmax(0, 1fr))` };
});

function colorOf(identity: string) {
  const known = props.people.get(identity)?.avatarColor;
  if (known) return known;
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}
function nameOf(identity: string) {
  return participants.value.find(participant => participant.identity === identity)?.name ?? '';
}

function openSheet(next: Sheet) { sheet.value = sheet.value === next ? null : next; }
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (sheet.value) sheet.value = null;
  else exitFullScreen();
}
function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 3500);
}

const myPhoneScreen = () => `${props.userId}${SCREEN_SUFFIX}`;
// A phone's screen arrives as a participant of its own, which stands for its owner's screen rather
// than for another person.
const ownerOf = (identity: string) => identity.endsWith(SCREEN_SUFFIX) ? identity.slice(0, -SCREEN_SUFFIX.length) : identity;

// Tiles are rebuilt from LiveKit's view of the room after every change: one per person, showing
// their camera or their initials, and one more for each shared screen.
function refresh() {
  if (!room || disposed) return;
  const everyone: [Participant, boolean][] = [[room.localParticipant, true], ...[...room.remoteParticipants.values()].map(p => [p, false] as [Participant, boolean])];
  participants.value = everyone.filter(([participant]) => !participant.identity.endsWith(SCREEN_SUFFIX)).map(([participant, local]) => ({
    identity: participant.identity, name: participant.name || participant.identity, local,
    micOn: participant.isMicrophoneEnabled, speaking: participant.isSpeaking,
  }));
  const next: Tile[] = [];
  for (const [participant, remoteOrLocal] of everyone) {
    const owner = ownerOf(participant.identity);
    const phoneScreen = owner !== participant.identity;
    const local = remoteOrLocal || owner === props.userId;
    const base = {
      identity: owner, name: participant.name || owner, color: colorOf(owner), local,
      micOn: participant.isMicrophoneEnabled, speaking: participant.isSpeaking, hand: raisedHands.value.has(owner),
    };
    const screen = participant.getTrackPublication(Track.Source.ScreenShare);
    // This phone's own screen is never downloaded (see onTrackPublished), so it has no track here.
    if (phoneScreen && local && screen && !screen.isMuted) next.push({ ...base, key: `${participant.identity}:screen`, kind: 'screen', track: null });
    else if (screen?.track && !screen.isMuted) next.push({ ...base, key: `${participant.identity}:screen`, kind: 'screen', track: markRaw(screen.track as VideoTrack), dimensions: screen.dimensions });
    if (phoneScreen) continue;
    const camera = participant.getTrackPublication(Track.Source.Camera);
    const cameraTrack = camera?.track && !camera.isMuted ? markRaw(camera.track as VideoTrack) : null;
    next.push({ ...base, key: `${participant.identity}:camera`, kind: 'camera', track: cameraTrack, dimensions: camera?.dimensions });
  }
  const speaker = next.find(tile => tile.speaking && tile.kind === 'camera' && tile.track && !tile.local);
  if (speaker) lastSpeakerKey.value = speaker.key;
  // A screen someone starts sharing is made big straight away, as in a video call; it goes back
  // to the grid when they stop.
  const screens = next.filter(tile => tile.kind === 'screen' && !tile.local);
  const newScreen = screens.find(tile => !tiles.value.some(old => old.key === tile.key));
  if (newScreen && !focusedTile.value) focusedKey.value = newScreen.key;
  if (focusedKey.value && !next.some(tile => tile.key === focusedKey.value)) focusedKey.value = null;
  // A screen that stops being shared, or a camera turned off, leaves full screen.
  if (fullKey.value && !next.some(tile => tile.key === fullKey.value && watchable(tile))) exitFullScreen();
  tiles.value = next;
  micOn.value = room.localParticipant.isMicrophoneEnabled;
  cameraOn.value = room.localParticipant.isCameraEnabled;
  sharingScreen.value = room.localParticipant.isScreenShareEnabled || room.remoteParticipants.has(myPhoneScreen());
  emit('state', {
    micOn: micOn.value, cameraOn: cameraOn.value, sharing: sharingScreen.value,
    speaking: participants.value.filter(person => person.speaking).map(person => person.identity),
  });
}
// Tells the Android app whether to shrink into the small window when its owner leaves it, and in
// what shape. Wide or tall, the window matches the video, so none of it is cut off. The shape is
// compared as text, so the app is only told when it really changes, not on every refresh.
const miniShape = computed(() => {
  const tile = miniTile.value;
  if (!tile) return '';
  const size = tile.dimensions ?? (tile.kind === 'screen' ? { width: 16, height: 9 } : { width: 4, height: 3 });
  return `${size.width}x${size.height}`;
});
watch(miniShape, shape => {
  const [width, height] = shape.split('x').map(Number);
  setMiniWindow(shape ? { width, height } : null);
});
function toggleFocus(key: string) { focusedKey.value = focusedKey.value === key ? null : key; }

function attachAudio(track: RemoteTrack, participant: RemoteParticipant) {
  if (disposed || track.kind !== Track.Kind.Audio) return;
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

async function send(message: CallMessage) {
  try {
    await room?.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true, topic: 'call' });
  } catch { /* A dropped reaction is not worth interrupting the call for. */ }
}
function addReaction(emoji: string, name: string) {
  reactions.value = [...reactions.value.slice(-11), { id: ++reactionId, emoji, name, drift: Math.round(Math.random() * 40) }];
  const id = reactionId;
  setTimeout(() => { reactions.value = reactions.value.filter(reaction => reaction.id !== id); }, 3200);
}
function react(emoji: string) {
  if (room?.state !== 'connected') return;
  if (Date.now() - lastReactionAt < 500) return;
  lastReactionAt = Date.now();
  addReaction(emoji, nameOf(props.userId));
  void send({ type: 'reaction', emoji });
  sheet.value = null;
}
function toggleHand() {
  getSocket()?.emit('raise_hand', { channelId: props.channelId, raised: !myHandRaised.value });
  sheet.value = null;
}
// Anyone can record the call, one recording at a time. It is made on this device, so it stops when
// this device leaves the call; everyone in the call sees who is recording.
async function toggleRecording() {
  sheet.value = null;
  if (recordingHere.value) { stopRecording(); return; }
  if (!canRecord) { showToast(t('recordingUnsupported')); return; }
  if (props.recording) { showToast(t('recordingAlreadyOn')); return; }
  try {
    await startRecording({ getRoom: () => room, screenLabel: name => t('screenOf', { name }), userId: props.userId, voiceChannelId: props.channelId, channelName: props.channelName });
    if (recordingHere.value) showToast(t('recordingStarted'));
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : '';
    showToast(message === 'Already recording' ? t('recordingAlreadyOn') : message ? translateError(message) : t('recordingFailed'));
  }
}
watch(() => props.recording, (next, previous) => {
  if (next && next.userId !== props.userId && next.userId !== previous?.userId) showToast(t('recordingStartedBy', { name: next.displayName }));
});
// The Android app's own shared screen is normally not downloaded to the phone sharing it, but a
// recording made on that phone needs it.
function syncOwnPhoneScreen() {
  const screen = room?.remoteParticipants.get(myPhoneScreen());
  for (const publication of screen?.trackPublications.values() ?? []) onTrackPublished(publication, screen!);
}
watch(recordingHere, syncOwnPhoneScreen);
watch(() => props.hands, (next, previous) => {
  const before = new Set(previous.map(hand => hand.userId));
  const raised = next.find(hand => !before.has(hand.userId) && hand.userId !== props.userId);
  if (raised) showToast(t('handRaised', { name: raised.displayName }));
  refresh();
});
function onData(payload: Uint8Array, sender?: RemoteParticipant, _kind?: unknown, topic?: string) {
  if (disposed || topic !== 'call') return;
  let message: CallMessage;
  try { message = JSON.parse(decoder.decode(payload)); } catch { return; }
  // A reaction can arrive before LiveKit has introduced its sender; it is still shown, just unnamed.
  if (message?.type === 'reaction' && REACTIONS.includes(message.emoji)) addReaction(message.emoji, sender ? sender.name || sender.identity : '');
}

// Each voice plays at the call's volume times the volume chosen for that person.
function applyVoice(track: RemoteAudioTrack, identity: string) {
  const level = volume.value * levelOf(identity);
  // The mixer plays the voice while LiveKit keeps its element muted; unmuting it would play it twice.
  if (webAudioVolume) { track.setVolume(soundOn.value ? level : 0); return; }
  track.attachedElements.forEach(element => { element.muted = !soundOn.value; });
  track.setVolume(level);
}
function applySound() {
  for (const participant of room?.remoteParticipants.values() ?? []) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.audioTrack) applyVoice(publication.audioTrack as RemoteAudioTrack, participant.identity);
    }
  }
}
const clampVolume = (level: number) => Math.min(1, Math.max(MIN_VOLUME, level));
// Remembered on this device only, so everyone keeps the level that suits their speaker.
function savedVolume() {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
    return Number.isFinite(saved) ? clampVolume(saved) : 1;
  } catch { return 1; }
}
watch(volume, level => {
  applySound();
  try { localStorage.setItem(VOLUME_KEY, String(level)); } catch { /* Private browsing: the level lasts for this call. */ }
});
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
function levelOf(identity: string) { return personVolumes.value[identity] ?? 1; }
function setPersonVolume(identity: string, level: number) {
  personVolumes.value = { ...personVolumes.value, [identity]: clampVolume(level) };
  applySound();
  try { localStorage.setItem(PERSON_VOLUMES_KEY, JSON.stringify(personVolumes.value)); } catch { /* Lasts for this call. */ }
}
// On an iPhone the mixer is the sound, so the "tap to turn on sound" button follows whether it is running.
function onMixerStateChange() {
  if (!disposed && audioContext) audioBlocked.value = audioContext.state !== 'running';
}
// Made as the call opens, still within the tap on the voice channel, which is when an iPhone is
// most likely to let it start without asking for another tap. It runs at 48 kHz, the only rate the
// noise filter on the microphone understands, since that filter runs in the same mixer.
function createMixer() {
  if (!webAudioVolume) return;
  try { audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48_000 }); } catch { return; }
  audioContext.addEventListener('statechange', onMixerStateChange);
  resumeMixer();
}
function resumeMixer() {
  if (audioContext && audioContext.state !== 'running' && audioContext.state !== 'closed') void audioContext.resume().catch(() => {});
}
// A phone pauses the call's sound when another app takes the speaker or the browser is put away,
// and nothing starts it again by itself, so it is restarted whenever the page is back in view.
function resumeSound() {
  if (disposed || document.visibilityState !== 'visible') return;
  resumeMixer();
  for (const element of detachedAudio) {
    if (!element.paused) continue;
    element.play().catch((cause: unknown) => {
      // Only a browser that wants a tap first is worth the "tap to turn on sound" button.
      if (!disposed && cause instanceof DOMException && cause.name === 'NotAllowedError') audioBlocked.value = true;
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
  try { await room?.startAudio(); audioBlocked.value = false; soundOn.value = true; applySound(); } catch { showToast(t('voicePlaybackBlocked')); return; }
  // The page's audio is running again, so a microphone that was sent as recorded can be cleaned again.
  await cleanMicrophone();
}
// Every voice sent from the website is cleaned of noise, warmed and made a little louder; if that is not
// possible, it goes out as recorded.
async function cleanMicrophone() {
  const microphone = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  if (!microphone || microphone.getProcessor()) return;
  const voice = cleanVoice();
  try { await microphone.setProcessor(voice); } catch { /* Friends still hear the voice, just not cleaned. */ }
  // The microphone was opened without the browser's own noise filter, because ours was going to
  // replace it; if ours could not start after all, the browser's is brought back.
  if (voice.denoising || recorded(microphone).getSettings().noiseSuppression !== false) return;
  try { await microphone.restartTrack({ noiseSuppression: true, voiceIsolation: true }); } catch { /* It keeps the voice as it was. */ }
}
// With the voice cleaned, LiveKit's track is the cleaned one, which is silent while muted.
function recorded(microphone: LocalAudioTrack) {
  return (microphone.getProcessor() as CleanVoice | undefined)?.recordedTrack ?? microphone.mediaStreamTrack;
}
// Our noise filter replaces the browser's own: two filters in a row make voices sound watery. The
// browser still takes out the echo of the call's own sound and evens out the level. This only
// counts the first time, when the microphone is opened; later, turning it on just unmutes it.
async function microphoneOptions(): Promise<AudioCaptureOptions | undefined> {
  return await prepareCleanVoice() ? { noiseSuppression: false, voiceIsolation: false } : undefined;
}
async function setMicrophone(enabled: boolean) {
  if (!room) return;
  try {
    if (enabled && audioBlocked.value) await enableAudio();
    await room.localParticipant.setMicrophoneEnabled(enabled, enabled ? await microphoneOptions() : undefined);
    if (enabled) await cleanMicrophone();
    // The first time, the phone has only just been allowed to use the microphone.
    if (enabled) keepPhoneCallGoing();
  } catch {
    showToast(t('micBlocked'));
  } finally {
    refresh();
  }
}
// Talking while muted gets a reminder, as in Zoom. A copy of the microphone is listened to on this
// device only; it is never sent, and it is let go as soon as the microphone is turned back on.
function listenWhileMuted() {
  const microphone = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  if (!microphone || recorded(microphone).readyState !== 'live') return;
  // On an iPhone, where a page gets few audio contexts, the call's mixer does the listening.
  let context = audioContext;
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
watch(() => [micOn.value, status.value, props.visible, inMiniWindow.value] as const, ([on, state, visible, mini]) => {
  const wanted = !on && state === 'connected' && visible && !mini;
  if (!wanted) stopListeningWhileMuted?.();
  else if (!stopListeningWhileMuted) listenWhileMuted();
});
async function toggleCamera() {
  if (!room) return;
  try {
    await room.localParticipant.setCameraEnabled(!cameraOn.value, { resolution: VideoPresets.h540.resolution, facingMode: 'user' });
  } catch {
    showToast(t('cameraBlocked'));
  }
  refresh();
}
async function togglePhoneScreenShare() {
  if (phoneShareStarting) return;
  phoneShareStarting = true;
  try {
    if (sharingScreen.value) await stopPhoneScreenShare();
    else await startPhoneScreenShare(await api.getScreenToken(props.channelId));
  } catch (cause) {
    if (!wasCancelled(cause)) showToast(cause instanceof ApiError ? translateError(cause.message) : t('screenShareFailed'));
  } finally {
    phoneShareStarting = false;
  }
  refresh();
}
// Downloading your own phone's screen would only use data to show it back to you.
function onTrackPublished(publication: RemoteTrackPublication, participant: RemoteParticipant) {
  if (participant.identity === myPhoneScreen()) publication.setSubscribed(recordingHere.value && publication.source === Track.Source.ScreenShare);
}
// Two short pulses when someone else joins the call, so a phone in a pocket feels it; there is no
// sound. A friend whose connection dropped for a moment is coming back rather than joining.
const leftAt = new Map<string, number>();
let quietUntil = 0;
function onParticipantConnected(participant: RemoteParticipant) {
  if (participant.identity.endsWith(SCREEN_SUFFIX) || participant.identity === props.userId || Date.now() < quietUntil) return;
  if (Date.now() - (leftAt.get(participant.identity) ?? 0) < 30_000) return;
  try { navigator.vibrate?.([70, 60, 70]); } catch { /* Not a phone, or vibration is turned off. */ }
}
async function toggleScreenShare() {
  if (!room) return;
  if (!canShareScreen) { showToast(t('screenShareUnsupported')); return; }
  if (phoneScreenShareAvailable) { await togglePhoneScreenShare(); return; }
  try {
    // A shared browser tab can bring its sound along, for watching a video together.
    await room.localParticipant.setScreenShareEnabled(!sharingScreen.value, {
      audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
    });
  } catch { /* The browser's screen picker was closed. */ }
  refresh();
}
// Full screen shows one video alone on the whole screen, with a bar of buttons that comes back with
// a tap. On a phone, a wide video also turns the screen sideways, as YouTube does.
const onPhone = () => Math.min(window.screen.width, window.screen.height) < 600;
function wantsLandscape() {
  const size = fullTile.value?.dimensions;
  return onPhone() && Boolean(size && size.width > size.height);
}
async function enterFullScreen(key: string) {
  sheet.value = null;
  focusedKey.value = key;
  fullKey.value = key;
  showFullBar();
  showZoomHint();
  if (phoneFullScreenAvailable) { setPhoneFullScreen(true, wantsLandscape()); return; }
  if (!browserFullscreen || document.fullscreenElement) return;
  // Without a tap, as when the phone is turned sideways, the browser refuses; the call still fills the page.
  try { await root.value?.requestFullscreen(); } catch { return; }
  turnSideways();
}
function exitFullScreen() {
  if (!fullKey.value) return;
  fullKey.value = null;
  clearTimeout(fullBarTimer);
  if (phoneFullScreenAvailable) setPhoneFullScreen(false, false);
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  try { screen.orientation?.unlock(); } catch { /* Nothing was locked. */ }
}
// Only phone browsers in full screen can be turned sideways, and Chrome on Android is the one that does.
function turnSideways() {
  const orientation = screen.orientation as ScreenOrientation & { lock?: (to: string) => Promise<void> };
  if (wantsLandscape()) orientation?.lock?.('landscape').catch(() => {});
  else try { orientation?.unlock(); } catch { /* Nothing was locked. */ }
}
// The teacher may turn the tablet while it is shown full screen.
watch(wantsLandscape, () => {
  if (!fullKey.value) return;
  if (phoneFullScreenAvailable) setPhoneFullScreen(true, wantsLandscape());
  else if (document.fullscreenElement) turnSideways();
});
// Leaving the browser's full screen, for example with Escape or the Back gesture, leaves the call's too.
function onFullscreenChange() { if (!document.fullscreenElement) exitFullScreen(); }
// Turning a phone sideways while a video is big shows it full screen.
function onOrientationChange() {
  if (!landscapeQuery.matches || fullKey.value || inMiniWindow.value || !props.visible || sheet.value || !onPhone()) return;
  if (focusedTile.value && watchable(focusedTile.value)) void enterFullScreen(focusedTile.value.key);
}
watch(() => props.visible, visible => { if (!visible) exitFullScreen(); });
function showFullBar() {
  fullBarShown.value = true;
  clearTimeout(fullBarTimer);
  fullBarTimer = setTimeout(() => { fullBarShown.value = false; }, 3000);
}
function toggleFullBar() {
  if (!fullBarShown.value) { showFullBar(); return; }
  fullBarShown.value = false;
  clearTimeout(fullBarTimer);
}
// Once per device, the first time, so everyone learns that the teacher's writing can be made bigger.
function showZoomHint() {
  try {
    if (localStorage.getItem(ZOOM_HINT_KEY)) return;
    localStorage.setItem(ZOOM_HINT_KEY, '1');
  } catch { return; }
  showToast(t(window.matchMedia('(pointer: coarse)').matches ? 'pinchToZoom' : 'scrollToZoom'));
}

// Keeps a phone from dimming and locking during a call. Browsers release the lock whenever the
// page is hidden, so it is requested again when the page returns.
async function keepScreenOn() {
  if (disposed || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Battery saver, or not supported. */ }
}
function onVisibilityChange() {
  if (disposed || document.visibilityState !== 'visible') return;
  void keepScreenOn();
  if (rejoinWhenVisible) { rejoinWhenVisible = false; void rejoin(); } else resumeSound();
}

async function connect() {
  try {
    const credentials = await api.getLiveKitToken(props.channelId);
    if (disposed) return;
    startedAt.value = credentials.startedAt;
    // Adaptive streaming sends each tile only as much video as its size needs, and dynacast stops
    // sending camera layers nobody is watching, which keeps calls light on mobile data.
    const connectingRoom = new Room({ adaptiveStream: true, dynacast: true, ...(audioContext ? { webAudioMix: { audioContext } } : {}) });
    room = connectingRoom;
    // Events from a room that a rejoin has replaced are ignored.
    const current = () => !disposed && room === connectingRoom;
    connectingRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (!current()) return;
      attachAudio(track, participant);
      refresh();
    });
    connectingRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        for (const element of track.detach()) {
          const index = detachedAudio.indexOf(element);
          if (index !== -1) detachedAudio.splice(index, 1);
          element.remove();
        }
      }
      if (current()) refresh();
    });
    connectingRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (current()) audioBlocked.value = !connectingRoom.canPlaybackAudio; });
    // LiveKit retries a dropped connection for a while before giving up with Disconnected.
    connectingRoom.on(RoomEvent.Reconnecting, () => { if (current()) status.value = 'reconnecting'; });
    connectingRoom.on(RoomEvent.Reconnected, () => { if (current()) { status.value = 'connected'; quietUntil = Date.now() + 3000; refresh(); } });
    connectingRoom.on(RoomEvent.ParticipantConnected, participant => { if (current()) onParticipantConnected(participant); });
    connectingRoom.on(RoomEvent.ParticipantDisconnected, participant => { leftAt.set(participant.identity, Date.now()); });
    connectingRoom.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (!current() || error.value) return;
      status.value = 'disconnected';
      // A deleted channel, or the call opened on another device, stays closed. Anything else, such
      // as the browser putting the page to sleep while its owner was in another app, is rejoined as
      // soon as the page is looked at. A call that keeps dropping straight after a rejoin is left
      // to be rejoined by hand.
      if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.DUPLICATE_IDENTITY) {
        // The call is over for this device, so its recording ends and is offered for posting.
        if (isRecording(props.channelId)) stopRecording();
        return;
      }
      if (Date.now() - lastAutoRejoinAt < 15_000) return;
      lastAutoRejoinAt = Date.now();
      if (document.visibilityState === 'visible') void rejoin();
      else rejoinWhenVisible = true;
    });
    connectingRoom.on(RoomEvent.DataReceived, onData);
    // A weak connection for more than a moment is worth knowing about: it explains a voice that cuts
    // out, and that the problem is here rather than with the others.
    connectingRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (!current() || participant !== connectingRoom.localParticipant) return;
      clearTimeout(weakTimer);
      if (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) weakTimer = setTimeout(() => { weakConnection.value = true; }, 3000);
      else weakConnection.value = false;
    });
    connectingRoom.on(RoomEvent.TrackPublished, (publication, participant) => { if (current()) onTrackPublished(publication, participant); });
    for (const event of [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged,
    ] as const) connectingRoom.on(event, () => { if (current()) refresh(); });
    await connectingRoom.connect(credentials.url, credentials.token);
    if (!current()) { connectingRoom.disconnect(); return; }
    status.value = 'connected';
    for (const participant of connectingRoom.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        onTrackPublished(publication, participant);
        if (publication.track) attachAudio(publication.track, participant);
      }
    }
    refresh();
    // Started before the microphone, so the call's sound keeps going even if the microphone is refused.
    keepPhoneCallGoing();
    // Like Discord, you join a voice channel with your microphone on; one tap mutes it.
    await setMicrophone(true);
  } catch (cause) {
    if (disposed) return;
    error.value = cause instanceof ApiError ? translateError(cause.message) : t('callConnectFailed');
  }
}
async function rejoin() {
  rejoinWhenVisible = false;
  const previous = room;
  room = null;
  stopListeningWhileMuted?.();
  clearTimeout(weakTimer);
  weakConnection.value = false;
  previous?.disconnect();
  detachedAudio.splice(0).forEach(element => element.remove());
  error.value = '';
  status.value = 'joining';
  participants.value = [];
  tiles.value = [];
  // The server forgets whoever lost their connection, so it is told again before the call is rejoined.
  await new Promise(resolve => getSocket()?.emit('voice_join', { channelId: props.channelId }, resolve));
  await connect();
}
function cleanup() {
  if (disposed) return;
  disposed = true;
  // Leaving the call ends a recording made here; the person then chooses where to post it.
  if (isRecording(props.channelId)) stopRecording();
  exitFullScreen();
  stopListeningWhileMuted?.();
  void listeningContext?.close().catch(() => {});
  clearTimeout(weakTimer);
  clearTimeout(toastTimer);
  clearInterval(clockTimer);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  landscapeQuery.removeEventListener('change', onOrientationChange);
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pageshow', onVisibilityChange);
  window.removeEventListener('resize', onResize);
  void wakeLock?.release().catch(() => {});
  // The phone's screen is a separate connection, so it would keep going after the call closes.
  if (sharingScreen.value && phoneScreenShareAvailable) void stopPhoneScreenShare().catch(() => {});
  void phoneShareListener?.remove();
  void phoneLeaveListener?.remove();
  void phoneFullScreenListener?.remove();
  endPhoneCall();
  room?.disconnect(); room = null;
  detachedAudio.splice(0).forEach(element => element.remove());
  audioContext?.removeEventListener('statechange', onMixerStateChange);
  void audioContext?.close().catch(() => {});
  audioContext = undefined;
}
function leave() { cleanup(); emit('leave'); }
defineExpose({ toggleMicrophone: () => setMicrophone(!micOn.value), leave });
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  landscapeQuery.addEventListener('change', onOrientationChange);
  // Escape closes an open panel wherever keyboard focus happens to be.
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // A page brought back from the browser's back-forward cache may not report a visibility change.
  window.addEventListener('pageshow', onVisibilityChange);
  window.addEventListener('resize', onResize);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  void keepScreenOn();
  createMixer();
  // Fetched while the call connects, so the microphone does not wait for it.
  void prepareCleanVoice();
  void connect();
});
onBeforeUnmount(cleanup);
</script>

<template>
  <section v-show="visible || inMiniWindow" ref="root" class="call-view" :class="{ mini: inMiniWindow }" :aria-label="channelName">
    <!-- The Android app's small window over other apps: just one video, or who is talking. -->
    <div v-if="inMiniWindow" class="call-mini">
      <CallTile v-if="miniTile && status === 'connected'" :tile="miniTile" :focused="false" small />
      <div v-else class="call-mini-card">
        <Avatar v-if="miniSpeaker" :name="miniSpeaker.name" :color="colorOf(miniSpeaker.identity)" size="small" />
        <Volume2 v-else :size="22" aria-hidden="true" />
        <bdi>{{ miniSpeaker?.name ?? channelName }}</bdi>
      </div>
    </div>
    <template v-else>
      <header class="call-header">
        <button class="call-icon-btn menu-btn" type="button" :aria-label="t('channels')" @click="emit('menu')"><Menu :size="20" /></button>
        <Volume2 :size="20" class="call-header-icon" aria-hidden="true" />
        <h2><bdi>{{ channelName }}</bdi></h2>
        <bdi v-if="elapsed" class="call-clock">{{ elapsed }}</bdi>
        <span v-if="recording" class="call-recording" role="status">
          <span class="call-recording-dot" aria-hidden="true" />
          <bdi>{{ recording.userId === userId ? t('recordingByYou') : t('recordingBy', { name: recording.displayName }) }}</bdi>
        </span>
        <span class="call-header-spacer" />
        <button
          class="call-icon-btn"
          type="button"
          :title="soundOn && !audioBlocked ? t('callSoundOn') : t('callSoundOff')"
          :aria-label="soundOn && !audioBlocked ? t('callSoundOn') : t('callSoundOff')"
          @click="toggleSound"
        >
          <Volume2 v-if="soundOn && !audioBlocked" :size="20" />
          <VolumeX v-else :size="20" />
        </button>
        <button class="call-icon-btn" type="button" :title="t('participants')" :aria-label="t('participantsCount', { count: participants.length })" @click="openSheet('participants')">
          <Users :size="20" /><span class="call-count">{{ participants.length }}</span>
        </button>
      </header>

      <main class="call-stage">
        <div v-if="error" class="call-state-card error" role="alert">
          <strong>{{ t('callJoinFailed') }}</strong>
          <p dir="auto">{{ error }}</p>
          <button class="call-state-action" type="button" @click="rejoin"><RotateCcw :size="16" />{{ t('rejoinCall') }}</button>
        </div>
        <div v-else-if="status === 'disconnected'" class="call-state-card" role="status">
          <strong>{{ t('callDisconnected') }}</strong>
          <button class="call-state-action" type="button" @click="rejoin"><RotateCcw :size="16" />{{ t('rejoinCall') }}</button>
        </div>
        <div v-else-if="status === 'joining'" class="call-state-card" role="status">
          <strong>{{ t('joiningCall') }}</strong>
        </div>
        <div v-else-if="fullTile" class="call-full" :class="{ idle: !fullBarShown }" @pointermove="$event.pointerType === 'mouse' && showFullBar()">
          <CallTile ref="fullTileView" :tile="fullTile" focused full @click="toggleFullBar" />
          <span v-if="recording" class="call-recording call-full-recording" role="status">
            <span class="call-recording-dot" aria-hidden="true" />
            <bdi>{{ recording.userId === userId ? t('recordingByYou') : t('recordingBy', { name: recording.displayName }) }}</bdi>
          </span>
          <div class="call-full-bar top" :class="{ hidden: !fullBarShown }">
            <span class="call-full-name">
              <ScreenShare v-if="fullTile.kind === 'screen'" :size="16" aria-hidden="true" />
              <bdi>{{ fullTile.kind === 'screen' ? t('screenOf', { name: fullTile.name }) : fullTile.name }}</bdi>
            </span>
            <button class="call-full-btn" type="button" @click="exitFullScreen"><Minimize :size="18" />{{ t('exitFullscreen') }}</button>
          </div>
          <div class="call-full-bar bottom" :class="{ hidden: !fullBarShown }">
            <!-- A student can answer the teacher without leaving full screen. -->
            <button class="call-control" :class="{ off: !micOn }" type="button" :aria-pressed="micOn" :title="micOn ? t('mute') : t('unmute')" :aria-label="micOn ? t('mute') : t('unmute')" @click="setMicrophone(!micOn); showFullBar()">
              <Mic v-if="micOn" :size="22" /><MicOff v-else :size="22" />
            </button>
            <button v-if="fullZoomed" class="call-full-btn" type="button" @click="fullTileView?.resetZoom(); showFullBar()"><ZoomOut :size="18" />{{ t('zoomOut') }}</button>
          </div>
        </div>
        <template v-else-if="focusedTile">
          <div class="call-focus">
            <CallTile :tile="focusedTile" focused @focus="toggleFocus(focusedTile.key)" @fullscreen="enterFullScreen(focusedTile.key)" @click="toggleFocus(focusedTile.key)" />
          </div>
          <div v-if="otherTiles.length" class="call-strip">
            <CallTile v-for="tile in otherTiles" :key="tile.key" :tile="tile" :focused="false" small @click="toggleFocus(tile.key)" />
          </div>
        </template>
        <div v-else class="call-grid" :style="gridStyle">
          <CallTile v-for="tile in tiles" :key="tile.key" :tile="tile" :focused="false" @focus="toggleFocus(tile.key)" @fullscreen="enterFullScreen(tile.key)" @click="toggleFocus(tile.key)" />
        </div>
        <p v-if="status === 'reconnecting'" class="call-pill call-reconnecting" role="status">{{ t('callReconnecting') }}</p>
        <p v-else-if="weakConnection && status === 'connected'" class="call-pill call-weak" role="status"><WifiOff :size="16" aria-hidden="true" />{{ t('weakConnection') }}</p>
      </main>

      <button v-if="audioBlocked" class="call-pill call-sound-pill" type="button" @click="enableAudio">
        <Volume2 :size="17" />{{ t('tapToEnableSound') }}
      </button>
      <div v-if="toast" class="call-pill call-toast" role="status"><bdi>{{ toast }}</bdi></div>

      <div class="call-reactions" aria-hidden="true">
        <div v-for="reaction in reactions" :key="reaction.id" class="call-reaction" :style="{ '--drift': `${reaction.drift}px` }">
          <span class="call-reaction-emoji">{{ reaction.emoji }}</span>
          <bdi class="call-reaction-name">{{ reaction.name }}</bdi>
        </div>
      </div>

      <footer class="call-controls">
        <button class="call-control" :class="{ off: !micOn }" type="button" :aria-pressed="micOn" :title="micOn ? t('mute') : t('unmute')" :aria-label="micOn ? t('mute') : t('unmute')" :disabled="status !== 'connected'" @click="setMicrophone(!micOn)">
          <Mic v-if="micOn" :size="22" /><MicOff v-else :size="22" />
        </button>
        <button class="call-control" :class="{ on: cameraOn }" type="button" :aria-pressed="cameraOn" :title="cameraOn ? t('cameraOff') : t('cameraOn')" :aria-label="cameraOn ? t('cameraOff') : t('cameraOn')" :disabled="status !== 'connected'" @click="toggleCamera">
          <Video v-if="cameraOn" :size="22" /><VideoOff v-else :size="22" />
        </button>
        <button class="call-control" :class="{ on: sharingScreen }" type="button" :aria-pressed="sharingScreen" :title="sharingScreen ? t('stopSharing') : t('shareScreen')" :aria-label="sharingScreen ? t('stopSharing') : t('shareScreen')" :disabled="status !== 'connected'" @click="toggleScreenShare">
          <ScreenShareOff v-if="sharingScreen" :size="22" /><ScreenShare v-else :size="22" />
        </button>
        <button class="call-control" :class="{ on: myHandRaised }" type="button" :aria-pressed="myHandRaised" :title="myHandRaised ? t('lowerHand') : t('raiseHand')" :aria-label="myHandRaised ? t('lowerHand') : t('raiseHand')" @click="toggleHand">
          <Hand :size="22" />
        </button>
        <button class="call-control" type="button" :aria-pressed="sheet === 'more'" :title="t('more')" :aria-label="t('more')" @click="openSheet('more')">
          <Ellipsis :size="22" />
        </button>
        <button class="call-control leave" type="button" :title="t('disconnect')" :aria-label="t('disconnect')" @click="leave">
          <PhoneOff :size="22" />
        </button>
      </footer>

      <template v-if="sheet">
        <div class="call-sheet-backdrop" @click="sheet = null" />

        <section v-if="sheet === 'participants'" class="call-sheet side" :aria-label="t('participants')">
          <div class="call-sheet-head">
            <strong>{{ t('participantsCount', { count: participants.length }) }}</strong>
            <button class="call-icon-btn" type="button" :aria-label="t('close')" @click="sheet = null"><X :size="18" /></button>
          </div>
          <ul class="call-people">
            <li v-for="person in participants" :key="person.identity" :class="{ speaking: person.speaking }">
              <Avatar :name="person.name" :color="colorOf(person.identity)" size="small" />
              <div class="call-person-main">
                <span class="call-person-name">
                  <bdi>{{ person.name }}</bdi>
                  <small v-if="person.local">{{ t('youLabel') }}</small>
                </span>
                <!-- Only on this device: turning someone down here changes nothing for anyone else. -->
                <label v-if="canAdjustVolume && !person.local" class="call-person-volume">
                  <Volume1 :size="16" aria-hidden="true" />
                  <input
                    type="range"
                    :min="MIN_VOLUME"
                    max="1"
                    step="0.05"
                    :value="levelOf(person.identity)"
                    :aria-label="t('personVolume', { name: person.name })"
                    @input="setPersonVolume(person.identity, ($event.target as HTMLInputElement).valueAsNumber)"
                  >
                </label>
              </div>
              <span v-if="raisedHands.has(person.identity)" class="call-person-hand">✋</span>
              <Mic v-if="person.micOn" :size="18" class="call-person-mic" :class="{ on: person.speaking }" />
              <MicOff v-else :size="18" class="call-person-mic off" />
            </li>
          </ul>
        </section>

        <section v-else-if="sheet === 'more'" class="call-sheet" :aria-label="t('more')">
          <span class="call-sheet-handle" />
          <div class="call-reaction-row">
            <button v-for="emoji in REACTIONS" :key="emoji" class="call-emoji-btn" type="button" :aria-label="`${t('reactions')} ${emoji}`" @click="react(emoji)">{{ emoji }}</button>
          </div>
          <label v-if="canAdjustVolume" class="call-volume">
            <Volume1 :size="20" aria-hidden="true" />
            <span>{{ t('callVolume') }}</span>
            <input v-model.number="volume" type="range" :min="MIN_VOLUME" max="1" step="0.05">
            <Volume2 :size="20" aria-hidden="true" />
          </label>
          <button v-if="fullScreenChoice" class="call-sheet-row" type="button" @click="enterFullScreen(fullScreenChoice.key)">
            <Maximize :size="20" />{{ t('fullscreen') }}
          </button>
          <button class="call-sheet-row" :class="{ 'call-record-stop': recordingHere }" type="button" :disabled="status !== 'connected' || recordingState.phase === 'starting'" @click="toggleRecording">
            <template v-if="recordingHere"><Square :size="20" />{{ t('stopRecording') }}</template>
            <template v-else><Circle :size="20" class="call-record-icon" />{{ t('record') }}</template>
          </button>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
/* A voice channel's call fills the main area, on the near-black background of a video call. */
.call-view {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #f2f3f5;
  background: #000000;
}

/* In the Android app's small window, the call covers the whole page, even when a text channel was open. */
.call-view.mini {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.call-mini {
  flex: 1;
  min-height: 0;
  display: flex;
}

.call-mini .call-tile {
  flex: 1;
  border-radius: 0;
}

.call-mini-card {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  color: #b5bac1;
  font-size: 13px;
  font-weight: 600;
}

.call-mini-card bdi {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.call-header {
  min-height: 48px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(6px, env(safe-area-inset-top)) 12px 6px;
  background: #111214;
}

.call-header h2 {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.call-header-icon {
  flex: none;
  color: #949ba4;
}

.call-header-spacer {
  flex: 1;
}

.call-clock {
  color: #949ba4;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.call-recording {
  min-width: 0;
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  padding: 3px 10px;
  border-radius: 999px;
  color: #ffffff;
  background: #da373c;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.call-recording bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.call-recording-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: #ffffff;
}

@media (prefers-reduced-motion: no-preference) {
  .call-recording-dot {
    animation: call-recording-pulse 1.6s ease-in-out infinite;
  }
}

@keyframes call-recording-pulse {
  50% { opacity: 0.35; }
}

/* Stays on in full screen, even while the bars are hidden, so nobody forgets they are recorded. */
.call-full-recording {
  max-width: calc(100% - 24px);
  position: absolute;
  z-index: 1;
  bottom: max(14px, env(safe-area-inset-bottom));
  inset-inline-start: max(12px, env(safe-area-inset-left));
  pointer-events: none;
}

.call-icon-btn {
  min-width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 8px;
  color: #b5bac1;
}

.call-icon-btn:hover {
  color: #f2f3f5;
  background: rgba(255, 255, 255, 0.08);
}

.call-count {
  font-size: 13px;
  font-weight: 700;
}

.menu-btn {
  display: none;
}

.call-stage {
  position: relative;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}

.call-grid {
  min-height: 0;
  flex: 1;
  display: grid;
  gap: 8px;
}

.call-focus {
  min-height: 0;
  flex: 1;
  display: grid;
}

.call-strip {
  flex: 0 0 96px;
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.call-strip > * {
  flex: 0 0 160px;
}

.call-state-card {
  max-width: min(390px, calc(100% - 32px));
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 22px 24px;
  border-radius: 12px;
  background: #2b2d31;
  text-align: center;
}

.call-state-card p {
  color: #b5bac1;
  font-size: 13px;
  line-height: 1.55;
}

.call-state-card.error strong {
  color: #f23f43;
}

.call-state-action {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  padding: 0 16px;
  border-radius: 6px;
  color: #ffffff;
  background: #5865f2;
  font-size: 14px;
  font-weight: 600;
}

.call-controls {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  gap: 10px;
  padding: 10px 12px max(12px, env(safe-area-inset-bottom));
  background: #000000;
}

.call-control {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #f2f3f5;
  background: #2b2d31;
  transition: background 160ms ease;
}

.call-control:hover:not(:disabled),
.call-control[aria-pressed='true'] {
  background: #404249;
}

.call-control:disabled {
  opacity: 0.45;
}

.call-control.off {
  color: #f23f43;
}

.call-control.on {
  color: #000000;
  background: #f2f3f5;
}

.call-control.leave {
  color: #ffffff;
  background: #da373c;
}

.call-control.leave:hover {
  background: #a12828;
}

/* Full screen: one video over the whole app, with bars that fade away and come back with a tap. */
.call-full {
  position: fixed;
  inset: 0;
  z-index: 5;
  display: grid;
  background: #000000;
}

.call-full.idle,
.call-full.idle .call-tile {
  cursor: none;
}

.call-full-bar {
  position: absolute;
  inset-inline: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left));
  pointer-events: none;
  transition: opacity 200ms ease;
}

.call-full-bar > * {
  pointer-events: auto;
}

.call-full-bar.hidden {
  opacity: 0;
}

.call-full-bar.hidden > * {
  pointer-events: none;
}

.call-full-bar.top {
  top: 0;
  justify-content: space-between;
  padding-top: max(12px, env(safe-area-inset-top));
  background: linear-gradient(rgba(0, 0, 0, 0.55), transparent);
}

.call-full-bar.bottom {
  bottom: 0;
  justify-content: center;
  padding-bottom: max(14px, env(safe-area-inset-bottom));
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
}

.call-full-name {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  padding: 6px 10px;
  border-radius: 8px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.call-full-name bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.call-full-btn {
  min-height: 42px;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 999px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 14px;
  font-weight: 600;
}

.call-full-btn:hover {
  background: rgba(0, 0, 0, 0.8);
}

/* Floating notices, shown over full screen too. */
.call-pill {
  position: absolute;
  z-index: 6;
  left: 50%;
  max-width: calc(100% - 32px);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  overflow: hidden;
  padding: 9px 15px;
  border-radius: 999px;
  color: #f2f3f5;
  background: rgba(17, 18, 20, 0.94);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateX(-50%);
}

.call-sound-pill {
  top: 64px;
  color: #ffffff;
  background: #5865f2;
}

.call-toast {
  top: 112px;
}

.call-reconnecting {
  top: 12px;
}

/* Just above the buttons, where it stays clear of full screen's bar too. */
.call-weak {
  bottom: calc(env(safe-area-inset-bottom) + 84px);
  white-space: normal;
  text-align: center;
}

.call-reactions {
  width: 1px;
  position: absolute;
  bottom: calc(env(safe-area-inset-bottom) + 90px);
  inset-inline-end: 56px;
  z-index: 6;
  pointer-events: none;
}

.call-reaction {
  position: absolute;
  bottom: 0;
  inset-inline-end: var(--drift);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  animation: call-reaction-float 3.2s ease-out forwards;
}

.call-reaction-emoji {
  font-size: 34px;
  line-height: 1;
}

.call-reaction-name {
  max-width: 110px;
  overflow: hidden;
  padding: 1px 7px;
  border-radius: 999px;
  color: #f2f3f5;
  background: rgba(0, 0, 0, 0.55);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes call-reaction-float {
  0% { opacity: 0; transform: translateY(0) scale(0.6); }
  12% { opacity: 1; transform: translateY(-20px) scale(1); }
  75% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-38dvh); }
}

/* Sheets: bottom sheets on phones; the participants list docks to the side on wide screens. */
.call-sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: rgba(0, 0, 0, 0.45);
}

.call-sheet {
  width: min(480px, 100%);
  max-height: 85%;
  position: absolute;
  bottom: 0;
  inset-inline: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  overflow: auto;
  margin-inline: auto;
  padding: 10px 16px max(18px, env(safe-area-inset-bottom));
  border-radius: 16px 16px 0 0;
  background: #2b2d31;
  box-shadow: 0 -16px 50px rgba(0, 0, 0, 0.45);
  animation: call-sheet-in 200ms ease-out;
}

.call-sheet.side {
  height: 85%;
  padding-top: 12px;
}

@keyframes call-sheet-in {
  from { opacity: 0; translate: 0 40px; }
}

.call-sheet-handle {
  width: 38px;
  height: 4px;
  flex: 0 0 auto;
  margin: 0 auto 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.3);
}

.call-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.call-people {
  margin: 0 -16px;
  padding: 6px 0;
  list-style: none;
}

.call-people li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
}

.call-people li.speaking .avatar {
  box-shadow: 0 0 0 2px #2b2d31, 0 0 0 4px #23a55a;
}

.call-person-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.call-person-name {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  font-size: 15px;
  white-space: nowrap;
}

.call-person-name bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.call-person-name small {
  color: #949ba4;
  font-size: 13px;
}

.call-person-volume {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #949ba4;
}

.call-person-volume input {
  min-width: 0;
  height: 30px;
  flex: 1;
  margin: 0;
  accent-color: #5865f2;
}

.call-person-hand {
  font-size: 18px;
}

.call-person-mic {
  flex: none;
  color: #949ba4;
}

.call-person-mic.on {
  color: #23a55a;
}

.call-person-mic.off {
  color: #f23f43;
}

.call-reaction-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.call-emoji-btn {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  font-size: 24px;
  line-height: 1;
}

.call-emoji-btn:hover,
.call-sheet-row:hover {
  background: rgba(255, 255, 255, 0.08);
}

.call-volume {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 14px;
  font-weight: 600;
}

.call-volume svg {
  flex: none;
  color: #949ba4;
}

.call-volume input {
  min-width: 0;
  height: 44px;
  flex: 1;
  accent-color: #5865f2;
}

.call-sheet-row:disabled {
  opacity: 0.45;
}

.call-record-icon {
  color: #f23f43;
  fill: #f23f43;
}

.call-sheet-row.call-record-stop {
  color: #f23f43;
}

.call-sheet-row {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
}

@media (min-width: 900px) {
  .call-sheet.side {
    width: 340px;
    height: auto;
    max-height: none;
    top: 0;
    inset-inline-start: auto;
    margin: 0;
    border-radius: 0;
  }

  .call-sheet-backdrop:has(+ .call-sheet.side) {
    background: transparent;
  }
}

@media (max-width: 768px) {
  .menu-btn {
    display: inline-flex;
  }

  .call-controls {
    gap: 8px;
  }

  .call-control {
    width: 48px;
    height: 48px;
  }

  .call-strip {
    flex-basis: 80px;
  }

  .call-strip > * {
    flex-basis: 120px;
  }
}
</style>
