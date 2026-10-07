<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import {
  Ellipsis, Hand, Maximize, MessageSquare, Mic, MicOff, Minimize, Moon, PhoneOff, RotateCcw, ScreenShare, ScreenShareOff,
  SendHorizontal, Sun, Users, Video, VideoOff, Volume1, Volume2, VolumeX, WifiOff, X, ZoomOut,
} from 'lucide-vue-next';
import {
  AudioPresets, ConnectionQuality, createLocalAudioTrack, DisconnectReason, MediaDeviceFailure, Room, RoomEvent, Track, VideoPreset, VideoPresets, type AudioCaptureOptions, type LocalAudioTrack, type Participant, type RemoteAudioTrack, type RemoteParticipant,
  type RemoteTrack, type RemoteTrackPublication, type VideoTrack,
} from 'livekit-client';
import { api, ApiError } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { cleanVoice, prepareCleanVoice, type CleanVoice } from '../cleanVoice';
import {
  bridge, onPhoneScreenShareStopped, phoneScreenShareAvailable, SCREEN_SUFFIX, startPhoneScreenShare, stopPhoneScreenShare, wasCancelled,
} from '../nativeScreenShare';
import {
  endPhoneCall, inMiniWindow, keepPhoneCallGoing, miniWindowAvailable, onPhoneCallLeave, onPhoneFullScreenExit, phoneFullScreenAvailable, setMiniWindow,
  setPhoneFullScreen,
} from '../nativeCall';
import { callChat, onCallChatMessage, sendCallChat } from '../callChat';
import { createSpeakingDetector } from '../speaking';
import type { OnlineUser } from '../types';
import Avatar from './Avatar.vue';
import CallTile, { type Tile } from './CallTile.vue';

type Sheet = 'participants' | 'more' | 'chat';
type Status = 'joining' | 'connected' | 'reconnecting' | 'disconnected';
type CallParticipant = { identity: string; name: string; local: boolean; micOn: boolean; speaking: boolean };

const VOLUME_KEY = 'callVolume';
const PERSON_VOLUMES_KEY = 'callVolumes';
const ZOOM_HINT_KEY = 'zoomHintSeen';
const DARK_SCREEN_KEY = 'darkScreen';
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
// Chrome on Android, which the Android app is built on, decides once, as a sound starts playing,
// whether it is a call's sound or a video's, and it only takes the echo out of a call's. A sound
// counts as a call's only while the microphone is open. Voices that started before it, as they did
// for anyone who joined muted and spoke later, came out of the speaker and went straight back into
// the microphone: the echo everyone heard in September 2026, until that person rejoined. So on
// Android the microphone is opened before any voice plays, muted when its owner joined muted.
const onAndroid = /Android/i.test(navigator.userAgent);
// Longer than this, as when the phone is still asking whether the app may use the microphone, and
// the voices play anyway: hearing the call matters more.
const MICROPHONE_WAIT_MS = 4000;
// Computers share their screen from the browser, and the Android app from its own code; phone
// browsers and the iPhone app cannot share yet.
const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function' || phoneScreenShareAvailable;
const FALLBACK_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b84ee'];

const props = defineProps<{
  channelId: string; channelName: string; userId: string; visible: boolean;
  people: Map<string, OnlineUser>;
  hands: { userId: string; displayName: string }[];
  /** Chosen before joining: whether the microphone and camera start on. */
  startMic: boolean; startCamera: boolean;
}>();
const emit = defineEmits<{
  leave: [];
  state: [state: { micOn: boolean; cameraOn: boolean; sharing: boolean; speaking: string[] }];
}>();
const { t, translateError } = useI18n();
const { theme, toggleTheme } = useTheme();
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
const toast = ref('');
const weakConnection = ref(false);
// Once this device's internet has shown it cannot keep up, other people's cameras stop being
// downloaded until the call is left, so what little there is goes to voices and the shared screen.
const savingData = ref(false);
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
// Measures who is speaking on this device, so their glow follows their voice (see speaking.ts). On
// an iPhone, where a page gets few audio contexts, the call's mixer does the measuring.
let speakingContext: AudioContext | undefined;
const speakingDetector = createSpeakingDetector(() => {
  if (audioContext) return audioContext;
  try {
    if (!speakingContext) { speakingContext = new AudioContext(); void speakingContext.resume().catch(() => {}); }
  } catch { /* No measuring; LiveKit's answer is used. */ }
  return speakingContext;
}, () => refresh());
let lastMutedHintAt = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
let rejoinWhenVisible = false;
let lastAutoRejoinAt = 0;
// How many times in a row joining has failed and been tried again by itself.
let joinRetries = 0;
// On Android, voices wait until the microphone is open (see onAndroid).
let voicesWaiting = false;
const detachedAudio: HTMLMediaElement[] = [];

// The call's chat: to everyone, or privately to one person in the call (chatTo, their user ID).
const chatTo = ref<string | null>(null);
const chatDraft = ref('');
const chatSending = ref(false);
const chatUnread = ref(0);
const chatList = ref<HTMLElement>();
const chatPeople = computed(() => participants.value.filter(person => !person.local));
const stopChatListener = onCallChatMessage(message => {
  if (message.from.id === props.userId || sheet.value === 'chat') return;
  chatUnread.value++;
  const text = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
  showToast(`${message.from.displayName}: ${text}`, 5000);
});
function scrollChatToEnd() {
  void nextTick(() => { if (chatList.value) chatList.value.scrollTop = chatList.value.scrollHeight; });
}
watch(sheet, open => { if (open === 'chat') { chatUnread.value = 0; scrollChatToEnd(); } });
watch(() => callChat.value.length, () => { if (sheet.value === 'chat') scrollChatToEnd(); });
// Someone who leaves the call can no longer be written to.
watch(chatPeople, people => { if (chatTo.value && !people.some(person => person.identity === chatTo.value)) chatTo.value = null; });
function messagePrivately(identity: string) {
  chatTo.value = identity;
  sheet.value = 'chat';
}
async function sendChat() {
  const text = chatDraft.value.trim();
  if (!text || chatSending.value) return;
  chatSending.value = true;
  const failure = await sendCallChat(text, chatTo.value);
  chatSending.value = false;
  if (failure) { showToast(t('chatSendFailed')); return; }
  chatDraft.value = '';
}
const chatTime = (sentAt: number) => new Date(sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const myHandRaised = computed(() => raisedHands.value.has(props.userId));
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
// Each tile's video is made once and moved between the grid, the big spot, full screen and the
// Android app's small window, never made anew. A new video stays empty until the picture next
// changes, which for a teacher's still screen can take a long time, so students used to wait
// for the screen after going in or out of full screen. Hidden tiles wait in a hidden holder.
type TileSpot = 'grid' | 'focus' | 'strip' | 'full' | 'mini' | 'parked';
function spotOf(tile: Tile): TileSpot {
  if (inMiniWindow.value) return tile.key === miniTile.value?.key && status.value === 'connected' ? 'mini' : 'parked';
  if (error.value || status.value === 'disconnected' || status.value === 'joining') return 'parked';
  if (fullTile.value) return tile.key === fullTile.value.key ? 'full' : 'parked';
  if (focusedTile.value) return tile.key === focusedTile.value.key ? 'focus' : 'strip';
  return 'grid';
}
function onTileClick(tile: Tile) {
  const spot = spotOf(tile);
  if (spot === 'full') toggleFullBar();
  else if (spot !== 'mini') toggleFocus(tile.key);
}
function setTileView(tile: Tile, view: unknown) {
  if (tile.key === fullKey.value) fullTileView.value = (view ?? undefined) as InstanceType<typeof CallTile> | undefined;
}
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

function openSheet(next: Sheet) { sheet.value = sheet.value === next ? null : next; }
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (sheet.value) sheet.value = null;
  else exitFullScreen();
}
function showToast(message: string, duration = 3500) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, duration);
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
  speakingDetector.follow(new Map(everyone.flatMap(([participant]) => {
    const microphone = participant.getTrackPublication(Track.Source.Microphone)?.track;
    return microphone && participant.isMicrophoneEnabled ? [[participant.identity, microphone.mediaStreamTrack] as const] : [];
  })));
  const isSpeaking = (participant: Participant) => participant.isMicrophoneEnabled && (speakingDetector.speaking(participant.identity) ?? participant.isSpeaking);
  participants.value = everyone.filter(([participant]) => !participant.identity.endsWith(SCREEN_SUFFIX)).map(([participant, local]) => ({
    identity: participant.identity, name: participant.name || participant.identity, local,
    micOn: participant.isMicrophoneEnabled, speaking: isSpeaking(participant),
  }));
  const next: Tile[] = [];
  for (const [participant, remoteOrLocal] of everyone) {
    const owner = ownerOf(participant.identity);
    const phoneScreen = owner !== participant.identity;
    const local = remoteOrLocal || owner === props.userId;
    const base = {
      identity: owner, name: participant.name || owner, color: colorOf(owner), local,
      micOn: participant.isMicrophoneEnabled, speaking: isSpeaking(participant), hand: raisedHands.value.has(owner),
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
// The size of the picture each video really shows, once it has arrived. Every tile reports it, so
// the small window has the right shape as soon as it opens, rather than changing shape once showing.
const videoSizes = shallowRef<Record<string, { width: number; height: number }>>({});
function onVideoSize(tile: Tile, size: { width: number; height: number }) {
  const known = videoSizes.value[tile.key];
  if (known?.width === size.width && known.height === size.height) return;
  videoSizes.value = { ...videoSizes.value, [tile.key]: size };
}
// Only the shape matters, so a smaller copy of the same picture, sent on weak internet, changes nothing.
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const miniShape = computed(() => {
  const tile = miniTile.value;
  if (!tile) return '';
  const size = videoSizes.value[tile.key] ?? tile.dimensions
    ?? (tile.kind === 'screen' ? { width: 16, height: 9 } : { width: 4, height: 3 });
  const divisor = gcd(Math.round(size.width), Math.round(size.height)) || 1;
  return `${Math.round(size.width) / divisor}x${Math.round(size.height) / divisor}`;
});
function tellMiniShape() {
  const [width, height] = miniShape.value.split('x').map(Number);
  setMiniWindow(miniShape.value ? { width, height } : null);
}
watch(miniShape, tellMiniShape);
function toggleFocus(key: string) { focusedKey.value = focusedKey.value === key ? null : key; }

function attachAudio(track: RemoteTrack, participant: RemoteParticipant) {
  if (disposed || voicesWaiting || track.kind !== Track.Kind.Audio) return;
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

function toggleHand() {
  getSocket()?.emit('raise_hand', { channelId: props.channelId, raised: !myHandRaised.value });
  sheet.value = null;
}
watch(() => props.hands, (next, previous) => {
  const before = new Set(previous.map(hand => hand.userId));
  const raised = next.find(hand => !before.has(hand.userId) && hand.userId !== props.userId);
  if (raised) showToast(t('handRaised', { name: raised.displayName }));
  refresh();
});
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
// Opens the microphone without sending anything, only so the phone treats the call's sound as a
// call's (see onAndroid). Turning the microphone on later just unmutes it.
async function openMutedMicrophone() {
  if (!room) return;
  try {
    const microphone = await createLocalAudioTrack({ ...room.options.audioCaptureDefaults, ...await microphoneOptions() });
    await microphone.mute();
    if (disposed || !room) { microphone.stop(); return; }
    await room.localParticipant.publishTrack(microphone, { source: Track.Source.Microphone });
    await cleanMicrophone();
  } catch { /* Not allowed to use the microphone: the voices still play, just perhaps with an echo. */ }
}
async function setMicrophone(enabled: boolean) {
  if (!room) return;
  try {
    if (enabled && audioBlocked.value) await enableAudio();
    await room.localParticipant.setMicrophoneEnabled(enabled, enabled ? await microphoneOptions() : undefined);
    if (enabled) await cleanMicrophone();
    // The first time, the phone has only just been allowed to use the microphone.
    if (enabled) keepPhoneCallGoing();
  } catch (cause) {
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
    await room.localParticipant.setCameraEnabled(!cameraOn.value, { resolution: VideoPresets.h360.resolution, facingMode: 'user' });
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
  if (participant.identity === myPhoneScreen()) publication.setSubscribed(false);
  else if (publication.source === Track.Source.Camera) publication.setSubscribed(!savingData.value);
}
function saveData() {
  if (savingData.value || !room) return;
  savingData.value = true;
  applySavingData();
  showToast(t('camerasHiddenSlowInternet'), 6000);
}
function applySavingData() {
  for (const participant of room?.remoteParticipants.values() ?? []) {
    for (const publication of participant.trackPublications.values()) onTrackPublished(publication, participant);
  }
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
    // A shared browser tab can bring its sound along, for watching a video together. That sound
    // keeps a fuller quality than a microphone's, since it is not always one clear voice.
    await room.localParticipant.setScreenShareEnabled(!sharingScreen.value, {
      audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
    }, { audioPreset: AudioPresets.music });
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
// Dark screen is each viewer's own choice, remembered on this device, for anyone who finds the
// teacher's white pages too bright; it only changes how the screen is drawn here.
const darkScreen = ref((() => { try { return localStorage.getItem(DARK_SCREEN_KEY) === '1'; } catch { return false; } })());
function toggleDarkScreen() {
  darkScreen.value = !darkScreen.value;
  try { localStorage.setItem(DARK_SCREEN_KEY, darkScreen.value ? '1' : '0'); } catch { /* Private browsing: the choice lasts for this call. */ }
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
  // Otherwise the next full screen would open zoomed in where this one was left.
  fullTileView.value?.resetZoom();
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
  let attempt: Room | undefined;
  try {
    const credentials = await api.getLiveKitToken(props.channelId);
    if (disposed) return;
    startedAt.value = credentials.startedAt;
    // Adaptive streaming sends each tile only as much video as its size needs, and dynacast stops
    // sending camera layers nobody is watching, which keeps calls light on mobile data.
    const connectingRoom = new Room({
      adaptiveStream: true, dynacast: true, ...(audioContext ? { webAudioMix: { audioContext } } : {}),
      // Everything is sent as lightly as it can be while staying clear, because some of the class
      // have slow internet. Each video also goes out in smaller copies, and the server gives every
      // person the largest copy their internet can take, so one slow connection slows nobody else.
      // A voice needs far less than music; a shared browser tab's sound keeps music quality (see
      // toggleScreenShare).
      publishDefaults: {
        audioPreset: AudioPresets.speech,
        videoSimulcastLayers: [VideoPresets.h90, VideoPresets.h180],
        // A screen is mostly still text, so a few frames a second keep it readable at a fraction of the data.
        screenShareEncoding: { maxBitrate: 1_200_000, maxFramerate: 15 },
        screenShareSimulcastLayers: [new VideoPreset(640, 360, 120_000, 3), new VideoPreset(1280, 720, 400_000, 5)],
      },
    });
    room = attempt = connectingRoom;
    voicesWaiting = onAndroid;
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
      // A join that fails is tried again by connect() itself.
      if (!current() || error.value || status.value === 'joining') return;
      status.value = 'disconnected';
      // A deleted channel, or the call opened on another device, stays closed. Anything else, such
      // as the browser putting the page to sleep while its owner was in another app, is rejoined as
      // soon as the page is looked at. A call that keeps dropping straight after a rejoin is left
      // to be rejoined by hand.
      if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.DUPLICATE_IDENTITY) return;
      if (Date.now() - lastAutoRejoinAt < 15_000) return;
      lastAutoRejoinAt = Date.now();
      if (document.visibilityState === 'visible') void rejoin();
      else rejoinWhenVisible = true;
    });
    // A weak connection for more than a moment is worth knowing about: it explains a voice that cuts
    // out, and that the problem is here rather than with the others.
    connectingRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (!current() || participant !== connectingRoom.localParticipant) return;
      clearTimeout(weakTimer);
      if (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) weakTimer = setTimeout(() => { weakConnection.value = true; saveData(); }, 3000);
      else weakConnection.value = false;
    });
    connectingRoom.on(RoomEvent.TrackPublished, (publication, participant) => { if (current()) onTrackPublished(publication, participant); });
    // The server pauses a video when this device's internet cannot carry it.
    connectingRoom.on(RoomEvent.TrackStreamStateChanged, (publication, state) => {
      if (current() && state === Track.StreamState.Paused && publication.kind === Track.Kind.Video && publication.isSubscribed) saveData();
    });
    for (const event of [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged,
    ] as const) connectingRoom.on(event, () => { if (current()) refresh(); });
    // A slow connection gets twice LiveKit's usual time to join before it counts as failed.
    await connectingRoom.connect(credentials.url, credentials.token, { websocketTimeout: 30_000, peerConnectionTimeout: 30_000, maxRetries: 2 });
    if (!current()) { connectingRoom.disconnect(); return; }
    // A phone set to save data (Android's Data Saver in Chrome) is slow or on a limited plan from the start.
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) savingData.value = true;
    status.value = 'connected';
    joinRetries = 0;
    for (const participant of connectingRoom.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) onTrackPublished(publication, participant);
    }
    refresh();
    // Started before the microphone, so the call's sound keeps going even if the microphone is refused.
    keepPhoneCallGoing();
    // Told again once the call is running on the phone, so the small window never misses its shape.
    tellMiniShape();
    // The microphone and camera start as chosen on the screen before the call.
    const microphone = props.startMic ? setMicrophone(true) : onAndroid ? openMutedMicrophone() : Promise.resolve();
    if (voicesWaiting) await Promise.race([microphone, new Promise(resolve => setTimeout(resolve, MICROPHONE_WAIT_MS))]);
    if (room !== connectingRoom) return;
    voicesWaiting = false;
    for (const participant of connectingRoom.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) attachAudio(publication.track, participant);
      }
    }
    await microphone;
    if (props.startCamera && !disposed) await toggleCamera();
  } catch (cause) {
    if (disposed) return;
    // On weak internet a join often fails once and works the next time, so it is tried twice more
    // by itself, still showing "Joining the call…", before the Rejoin button is offered.
    if (!(cause instanceof ApiError) && status.value === 'joining' && joinRetries < 2) {
      joinRetries++;
      if (room === attempt) room = null;
      void attempt?.disconnect();
      setTimeout(() => { if (!disposed && !room && status.value === 'joining') void connect(); }, 2000);
      return;
    }
    joinRetries = 0;
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
  stopChatListener();
  void phoneShareListener?.remove();
  void phoneLeaveListener?.remove();
  void phoneFullScreenListener?.remove();
  endPhoneCall();
  room?.disconnect(); room = null;
  detachedAudio.splice(0).forEach(element => element.remove());
  speakingDetector.stop();
  void speakingContext?.close().catch(() => {});
  speakingContext = undefined;
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
    <!-- The Android app's small window over other apps: just one video, or who is talking. The
         full call screen stays on the page, only hidden, and the video moves into the small window,
         so going in and out of it shows the picture straight away. -->
    <div v-if="miniWindowAvailable" v-show="inMiniWindow" class="call-mini">
      <div v-show="miniTile && status === 'connected'" id="call-spot-mini" class="call-mini-spot" />
      <div v-if="!miniTile || status !== 'connected'" class="call-mini-card">
        <Avatar v-if="miniSpeaker" :name="miniSpeaker.name" :color="colorOf(miniSpeaker.identity)" size="small" />
        <Volume2 v-else :size="22" aria-hidden="true" />
        <bdi>{{ miniSpeaker?.name ?? channelName }}</bdi>
      </div>
    </div>
    <div v-show="!inMiniWindow" class="call-main">
      <header class="call-header">
        <Volume2 :size="20" class="call-header-icon" aria-hidden="true" />
        <h2><bdi>{{ channelName }}</bdi></h2>
        <bdi v-if="elapsed" class="call-clock">{{ elapsed }}</bdi>
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
        <button class="call-icon-btn" type="button" :aria-pressed="sheet === 'chat'" :title="t('chat')" :aria-label="chatUnread ? t('chatWithCount', { count: chatUnread }) : t('chat')" @click="openSheet('chat')">
          <MessageSquare :size="20" /><span v-if="chatUnread" class="call-chat-badge">{{ chatUnread > 99 ? '99+' : chatUnread }}</span>
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
          <div id="call-spot-full" class="call-full-spot" />
          <div class="call-full-bar top" :class="{ hidden: !fullBarShown }">
            <span class="call-full-name">
              <ScreenShare v-if="fullTile.kind === 'screen'" :size="16" aria-hidden="true" />
              <bdi>{{ fullTile.kind === 'screen' ? t('screenOf', { name: fullTile.name }) : fullTile.name }}</bdi>
            </span>
            <span class="call-full-actions">
              <button v-if="fullTile.kind === 'screen'" class="call-full-btn" type="button" :aria-pressed="darkScreen" @click="toggleDarkScreen(); showFullBar()">
                <Sun v-if="darkScreen" :size="18" /><Moon v-else :size="18" />{{ darkScreen ? t('lightScreen') : t('darkScreen') }}
              </button>
              <button class="call-full-btn" type="button" @click="exitFullScreen"><Minimize :size="18" />{{ t('exitFullscreen') }}</button>
            </span>
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
          <div id="call-spot-focus" class="call-focus" />
          <div v-show="otherTiles.length" id="call-spot-strip" class="call-strip" />
        </template>
        <div v-else id="call-spot-grid" class="call-grid" :style="gridStyle" />
        <p v-if="status === 'reconnecting'" class="call-pill call-reconnecting" role="status">{{ t('callReconnecting') }}</p>
        <p v-else-if="weakConnection && status === 'connected'" class="call-pill call-weak" role="status"><WifiOff :size="16" aria-hidden="true" />{{ t('weakConnection') }}</p>
      </main>

      <button v-if="audioBlocked" class="call-pill call-sound-pill" type="button" @click="enableAudio">
        <Volume2 :size="17" />{{ t('tapToEnableSound') }}
      </button>
      <div v-if="toast" class="call-pill call-toast" role="status"><bdi>{{ toast }}</bdi></div>

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
              <span v-if="raisedHands.has(person.identity)" class="call-person-hand anime-wave">✋</span>
              <button v-if="!person.local" class="call-icon-btn" type="button" :title="t('messagePrivately', { name: person.name })" :aria-label="t('messagePrivately', { name: person.name })" @click="messagePrivately(person.identity)">
                <MessageSquare :size="18" />
              </button>
              <Mic v-if="person.micOn" :size="18" class="call-person-mic" :class="{ on: person.speaking }" />
              <MicOff v-else :size="18" class="call-person-mic off" />
            </li>
          </ul>
        </section>

        <section v-else-if="sheet === 'chat'" class="call-sheet side call-chat" :aria-label="t('chat')">
          <div class="call-sheet-head">
            <strong>{{ t('chat') }}</strong>
            <button class="call-icon-btn" type="button" :aria-label="t('close')" @click="sheet = null"><X :size="18" /></button>
          </div>
          <ol ref="chatList" class="call-chat-list">
            <li v-if="!callChat.length" class="call-chat-empty">{{ t('chatEmpty') }}</li>
            <li v-for="message in callChat" :key="message.id" class="call-chat-message" :class="{ private: message.to, mine: message.from.id === userId }">
              <div class="call-chat-meta">
                <bdi class="call-chat-name">{{ message.from.id === userId ? t('youLabel') : message.from.displayName }}</bdi>
                <span>{{ chatTime(message.sentAt) }}</span>
              </div>
              <button
                v-if="message.to"
                class="call-chat-private"
                type="button"
                @click="chatTo = message.from.id === userId ? message.to.id : message.from.id"
              >
                <bdi>{{ message.from.id === userId ? t('chatPrivateTo', { name: message.to.displayName }) : t('chatPrivateFrom', { name: message.from.displayName }) }}</bdi>
              </button>
              <p dir="auto">{{ message.text }}</p>
            </li>
          </ol>
          <form class="call-chat-form" @submit.prevent="sendChat">
            <label class="call-chat-to">
              <span>{{ t('chatTo') }}</span>
              <select v-model="chatTo" :class="{ private: chatTo }">
                <option :value="null">{{ t('chatEveryone') }}</option>
                <option v-for="person in chatPeople" :key="person.identity" :value="person.identity">{{ person.name }}</option>
              </select>
            </label>
            <div class="call-chat-compose">
              <input v-model="chatDraft" type="text" dir="auto" maxlength="2000" :placeholder="t('chatPlaceholder')" :aria-label="t('chatPlaceholder')" enterkeyhint="send">
              <button class="call-chat-send" type="submit" :disabled="!chatDraft.trim() || chatSending" :title="t('sendMessage')" :aria-label="t('sendMessage')">
                <SendHorizontal :size="20" />
              </button>
            </div>
          </form>
        </section>

        <section v-else-if="sheet === 'more'" class="call-sheet" :aria-label="t('more')">
          <span class="call-sheet-handle" />
          <label v-if="canAdjustVolume" class="call-volume">
            <Volume1 :size="20" aria-hidden="true" />
            <span>{{ t('callVolume') }}</span>
            <input v-model.number="volume" type="range" :min="MIN_VOLUME" max="1" step="0.05">
            <Volume2 :size="20" aria-hidden="true" />
          </label>
          <button v-if="fullScreenChoice" class="call-sheet-row" type="button" @click="enterFullScreen(fullScreenChoice.key)">
            <Maximize :size="20" />{{ t('fullscreen') }}
          </button>
          <button class="call-sheet-row" type="button" @click="toggleTheme">
            <Moon v-if="theme === 'light'" :size="20" /><Sun v-else :size="20" />{{ theme === 'light' ? t('darkMode') : t('lightMode') }}
          </button>
        </section>
      </template>
    </div>
    <!-- Last, so the spots above already exist when a tile moves into one. -->
    <div id="call-spot-parked" hidden />
    <Teleport v-for="(tile, index) in tiles" :key="tile.key" :to="`#call-spot-${spotOf(tile)}`" defer>
      <CallTile
        :ref="view => setTileView(tile, view)"
        :tile="tile"
        :focused="spotOf(tile) === 'focus' || spotOf(tile) === 'full'"
        :small="spotOf(tile) === 'strip' || spotOf(tile) === 'mini'"
        :full="spotOf(tile) === 'full'"
        :dark="darkScreen"
        :style="{ order: index }"
        @focus="toggleFocus(tile.key)"
        @fullscreen="enterFullScreen(tile.key)"
        @dark-screen="toggleDarkScreen"
        @click="onTileClick(tile)"
        @video-size="size => onVideoSize(tile, size)"
      />
    </Teleport>
  </section>
</template>

<style scoped>
/* A voice channel's call fills the main area: near-black like most video calls, or white in light mode. */
.call-view {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--call-text);
  /* The lofi glow stays still here, so nothing moves behind the videos. */
  background: var(--lofi-glow), var(--call-bg);
}

/* In the Android app's small window, the call covers the whole page, even when a text channel was open. */
.call-view.mini {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.call-main {
  display: contents;
}

.call-mini {
  flex: 1;
  min-height: 0;
  display: flex;
}

.call-mini-spot {
  flex: 1;
  min-width: 0;
  display: flex;
}

.call-mini-spot .call-tile {
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
  color: var(--call-text-muted);
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
  background: var(--call-bar);
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
  color: var(--text-secondary);
}

.call-header-spacer {
  flex: 1;
}

.call-clock {
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
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
  color: var(--call-text-muted);
}

.call-icon-btn:hover {
  color: var(--call-text);
  background: var(--call-hover);
}

.call-count {
  font-size: 13px;
  font-weight: 700;
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
  background: var(--call-surface);
  text-align: center;
}

.call-state-card p {
  color: var(--call-text-muted);
  font-size: 13px;
  line-height: 1.55;
}

.call-state-card.error strong {
  color: var(--danger);
}

.call-state-action {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  padding: 0 16px;
  border-radius: 12px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-size: 14px;
  font-weight: 600;
}

.call-controls {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  gap: 10px;
  padding: 10px 12px max(12px, env(safe-area-inset-bottom));
  background: var(--call-bg);
}

.call-control {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--call-text);
  background: var(--call-surface);
  /* Squashes when pressed and springs back when let go. */
  transition: background 160ms ease, scale 380ms var(--spring);
}

.call-control:active:not(:disabled) {
  scale: 0.88;
  transition-duration: 160ms, 70ms;
}

/* The icon bounces in each time the button is turned on or off. */
.call-control svg {
  animation: anime-icon-on 420ms ease-out;
}

.call-control.on svg,
.call-control.off svg {
  animation-name: anime-icon-off;
}

/* On joining, the buttons spring up one after another. */
.call-controls > * {
  animation: anime-rise 480ms var(--spring) both;
}

.call-controls > :nth-child(1) { animation-delay: 250ms; }
.call-controls > :nth-child(2) { animation-delay: 290ms; }
.call-controls > :nth-child(3) { animation-delay: 330ms; }
.call-controls > :nth-child(4) { animation-delay: 370ms; }
.call-controls > :nth-child(5) { animation-delay: 410ms; }
.call-controls > :nth-child(6) { animation-delay: 450ms; }

.call-control:hover:not(:disabled),
.call-control[aria-pressed='true'] {
  background: var(--call-surface-active);
}

.call-control:disabled {
  opacity: 0.45;
}

.call-control.off {
  color: var(--danger);
}

.call-control.on {
  color: var(--call-bg);
  background: var(--call-text);
}

.call-control.leave {
  color: #ffffff;
  background: var(--leave);
}

.call-control.leave:hover {
  background: var(--leave-strong);
}

/* Full screen: one video over the whole app, with bars that fade away and come back with a tap. */
.call-full-spot {
  min-width: 0;
  min-height: 0;
  display: grid;
}

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

.call-full-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
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
  color: #f3eadf;
  background: rgba(36, 30, 44, 0.94);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateX(-50%);
}

.call-sound-pill {
  top: 64px;
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.call-toast {
  top: 112px;
  animation: anime-pop 480ms ease-out;
  width: max-content;
  max-width: min(460px, calc(100% - 32px));
  border-radius: 14px;
  white-space: normal;
  text-align: center;
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

/* The call's chat: messages above, and who they go to and what they say below. */
.call-chat-badge {
  min-width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0 5px;
  border-radius: 999px;
  color: #ffffff;
  background: var(--leave);
  font-size: 11px;
  font-weight: 800;
}

.call-sheet.call-chat {
  overflow: hidden;
}

.call-chat-list {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 12px 0;
  list-style: none;
}

.call-chat-empty {
  margin: auto 0;
  color: var(--call-text-muted);
  font-size: 14px;
  line-height: 1.55;
  text-align: center;
}

.call-chat-message {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.call-chat-message.private {
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(88, 101, 242, 0.18);
}

.call-chat-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}

.call-chat-name {
  color: var(--call-text);
  font-size: 14px;
  font-weight: 700;
}

.call-chat-message.mine .call-chat-name {
  color: var(--text-secondary);
}

.call-chat-private {
  align-self: flex-start;
  color: var(--call-link);
  font-size: 12px;
  font-weight: 700;
}

.call-chat-message p {
  color: var(--call-text-soft);
  font-size: 15px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.call-chat-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--call-line);
}

.call-chat-to {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--call-text-muted);
  font-size: 13px;
  font-weight: 700;
}

.call-chat-to select {
  min-width: 0;
  flex: 1;
  height: 34px;
  padding: 0 8px;
  border: 1px solid var(--call-line-strong);
  border-radius: 8px;
  color: var(--call-text);
  background: var(--call-input);
  font-size: 14px;
}

.call-chat-to select.private {
  border-color: var(--text-accent);
}

.call-chat-compose {
  display: flex;
  gap: 8px;
}

.call-chat-compose input {
  min-width: 0;
  flex: 1;
  height: 44px;
  padding: 0 12px;
  border: 1px solid var(--call-line-strong);
  border-radius: 10px;
  color: var(--call-text);
  background: var(--call-input);
  /* 16px keeps iPhones from zooming in on the box. */
  font-size: 16px;
}

.call-chat-send {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.call-chat-send:disabled {
  opacity: 0.45;
}

[dir='rtl'] .call-chat-send svg {
  transform: scaleX(-1);
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
  border-radius: 24px 24px 0 0;
  background: var(--call-sheet);
  box-shadow: 0 -16px 50px rgba(0, 0, 0, 0.45);
  animation: call-sheet-in 380ms var(--soft-spring);
}

.call-sheet.side {
  height: 85%;
  padding-top: 12px;
}

@keyframes call-sheet-in {
  from { opacity: 0; translate: 0 60px; }
}

.call-sheet-handle {
  width: 38px;
  height: 4px;
  flex: 0 0 auto;
  margin: 0 auto 14px;
  border-radius: 999px;
  background: var(--call-handle);
}

.call-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--call-line);
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
  box-shadow: 0 0 0 2px var(--call-sheet), 0 0 0 4px var(--speaking);
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
  color: var(--text-secondary);
  font-size: 13px;
}

.call-person-volume {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
}

.call-person-volume input {
  min-width: 0;
  height: 30px;
  flex: 1;
  margin: 0;
  accent-color: var(--text-accent);
}

.call-person-hand {
  font-size: 18px;
}

.call-person-mic {
  flex: none;
  color: var(--text-secondary);
}

.call-person-mic.on {
  color: var(--speaking);
}

.call-person-mic.off {
  color: var(--danger);
}

.call-sheet-row:hover {
  background: var(--call-hover);
}

.call-volume {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--call-line);
  font-size: 14px;
  font-weight: 600;
}

.call-volume svg {
  flex: none;
  color: var(--text-secondary);
}

.call-volume input {
  min-width: 0;
  height: 44px;
  flex: 1;
  accent-color: var(--text-accent);
}

.call-sheet-row:disabled {
  opacity: 0.45;
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
