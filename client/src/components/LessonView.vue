<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Ellipsis, Hand, Info, Maximize, MessageSquare, Mic, MicOff, Minimize, Radio, RotateCcw, ScreenShare, ScreenShareOff,
  Users, Volume1, Volume2, VolumeX, X,
} from 'lucide-vue-next';
import {
  DisconnectReason, Room, RoomEvent, Track, type Participant, type RemoteAudioTrack, type RemoteParticipant, type RemoteTrack, type TrackPublication,
} from 'livekit-client';
import { api, ApiError } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import { warmVoice } from '../warmVoice';
import Avatar from './Avatar.vue';

type Sheet = 'participants' | 'chat' | 'more' | 'info' | 'leave';
type Status = 'joining' | 'waiting' | 'live' | 'sharing' | 'reconnecting' | 'disconnected';
type LessonMessage = { type: 'reaction'; emoji: string };
type LessonParticipant = { identity: string; name: string; local: boolean; teacher: boolean; micOn: boolean; speaking: boolean };

const REACTIONS = ['👍', '❤️', '😂', '👏', '🎉', '😮'];
const VOLUME_KEY = 'lessonVolume';
const PERSON_VOLUMES_KEY = 'lessonVolumes';
// The sliders stop short of silence, so a lesson never starts inaudible because of last week's
// setting; the speaker button is there for turning the sound off.
const MIN_VOLUME = 0.1;
const volumeAdjustable = (() => {
  try { const probe = new Audio(); probe.volume = 0.5; return probe.volume === 0.5; } catch { return false; }
})();
// iPhones and iPads ignore a page's volume, so there the voices are played through the browser's
// audio mixer instead. Everywhere else they stay in plain audio elements: Chrome's echo cancellation
// does not hear the mixer, and a student on speaker would send the teacher's voice back to the class.
const webAudioVolume = !volumeAdjustable && typeof AudioContext === 'function';
const canAdjustVolume = volumeAdjustable || webAudioVolume;
const AVATAR_COLORS = ['#7c5cc4', '#3a6ea5', '#2f8f6b', '#c0703a', '#b24a6c', '#5a7d2a'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const props = defineProps<{
  conversationId: string; userId: string; isTeacher: boolean; presenter: boolean; presenterId: string;
  hands: { userId: string; displayName: string }[];
}>();
const emit = defineEmits<{ leave: []; end: [] }>();
const { t, translateError } = useI18n();
const overlay = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const status = ref<Status>('joining');
const error = ref('');
const micOn = ref(false);
const sharingScreen = ref(false);
const audioBlocked = ref(false);
const soundOn = ref(true);
const volume = ref(savedVolume());
const personVolumes = ref(savedPersonVolumes());
const sheet = ref<Sheet | null>(null);
const participants = ref<LessonParticipant[]>([]);
// Raised hands come from the server, which knows who raised them even before LiveKit has told
// this app about a student who just joined.
const raisedHands = computed(() => new Set(props.hands.map(hand => hand.userId)));
const reactions = ref<{ id: number; emoji: string; name: string; drift: number }[]>([]);
const toast = ref('');
const unreadChat = ref(0);
const startedAt = ref(0);
const now = ref(Date.now());
const fullscreen = ref(false);
const fullscreenSupported = typeof document !== 'undefined' && document.fullscreenEnabled;
// Phones and tablets cannot share their screen from a browser; the teacher uses the Android app there.
const canShareScreen = computed(() => props.presenter && typeof navigator.mediaDevices?.getDisplayMedia === 'function');
const chromeVisible = ref(true);
const live = computed(() => status.value === 'live' && !error.value);
const statusText = computed(() => ({
  joining: t('joiningLesson'),
  waiting: t('waitingForTeacherScreen'),
  live: t('lessonLive'),
  sharing: t('youAreSharing'),
  reconnecting: t('lessonReconnecting'),
  disconnected: t('lessonDisconnected'),
})[status.value]);
let room: Room | null = null;
// Only on iPhones and iPads. The lesson keeps it across rejoins and resumes it itself, because
// LiveKit only resumes a suspended mixer and an iPhone back from another app can leave it interrupted.
let audioContext: AudioContext | undefined;
let wakeLock: WakeLockSentinel | null = null;
let mutingMyself = false;
let hideChromeTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let reactionId = 0;
let lastReactionAt = 0;
let disposed = false;
let rejoinWhenVisible = false;
let lastAutoRejoinAt = 0;
const detachedAudio: HTMLMediaElement[] = [];

const myIdentity = computed(() => props.userId);
const myHandRaised = computed(() => raisedHands.value.has(myIdentity.value));
const studentsWithMicOn = computed(() => participants.value.filter(person => !person.local && !person.teacher && person.micOn).length);
const elapsed = computed(() => {
  if (!startedAt.value) return '';
  const seconds = Math.max(0, Math.floor((now.value - startedAt.value) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const clock = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return hours ? `${hours}:${clock}` : clock;
});

function avatarColor(identity: string) {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function nameOf(identity: string) {
  return participants.value.find(participant => participant.identity === identity)?.name ?? '';
}
// The server marks the teacher's lesson token, which also covers a teacher who is not presenting.
function isTeacherParticipant(participant: Participant) {
  return participant.attributes?.role === 'teacher' || participant.identity === props.presenterId;
}

// Like a video call, the header and controls float over the teacher's screen and fade out while it is live.
function showChrome() {
  chromeVisible.value = true;
  clearTimeout(hideChromeTimer);
  if (live.value && !sheet.value) hideChromeTimer = setTimeout(() => { chromeVisible.value = false; }, 4000);
}
function onStageTap(event: PointerEvent) {
  if (event.pointerType !== 'mouse' && chromeVisible.value && live.value) {
    clearTimeout(hideChromeTimer);
    chromeVisible.value = false;
  } else showChrome();
}
function onPointerMove(event: PointerEvent) { if (event.pointerType === 'mouse') showChrome(); }
watch([live, sheet], showChrome);

function openSheet(next: Sheet) {
  sheet.value = sheet.value === next ? null : next;
  if (sheet.value === 'chat') unreadChat.value = 0;
}
function onKeydown(event: KeyboardEvent) { if (event.key === 'Escape' && sheet.value) sheet.value = null; }

function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 3500);
}

function refreshParticipants() {
  if (!room || disposed) return;
  const describe = (participant: Participant, local: boolean): LessonParticipant => ({
    identity: participant.identity,
    name: participant.name || participant.identity,
    local,
    teacher: isTeacherParticipant(participant),
    micOn: participant.isMicrophoneEnabled,
    speaking: participant.isSpeaking,
  });
  // The teacher comes first, then raised hands in the order they went up, then everyone else.
  const handOrder = (identity: string) => { const index = props.hands.findIndex(hand => hand.userId === identity); return index < 0 ? Infinity : index; };
  const others = [...room.remoteParticipants.values()]
    .map(participant => describe(participant, false))
    .sort((a, b) => Number(b.teacher) - Number(a.teacher) || handOrder(a.identity) - handOrder(b.identity) || a.name.localeCompare(b.name));
  participants.value = [describe(room.localParticipant, true), ...others];
  micOn.value = room.localParticipant.isMicrophoneEnabled;
  sharingScreen.value = room.localParticipant.isScreenShareEnabled;
  if (props.presenter && (status.value === 'waiting' || status.value === 'sharing')) status.value = sharingScreen.value ? 'sharing' : 'waiting';
}

function attach(track: RemoteTrack, participant: RemoteParticipant) {
  if (disposed) return;
  if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare && video.value) {
    track.attach(video.value);
    status.value = 'live';
    return;
  }
  if (track.kind === Track.Kind.Audio) {
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
}

async function send(message: LessonMessage) {
  try {
    await room?.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true, topic: 'lesson' });
  } catch { /* A dropped reaction is not worth interrupting the lesson for. */ }
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
  addReaction(emoji, nameOf(myIdentity.value));
  void send({ type: 'reaction', emoji });
  sheet.value = null;
}
function toggleHand() {
  getSocket()?.emit('raise_hand', { conversationId: props.conversationId, raised: !myHandRaised.value });
  sheet.value = null;
}
function lowerHandOf(identity: string) {
  getSocket()?.emit('lower_hand', { conversationId: props.conversationId, userId: identity });
}
watch(() => props.hands, (next, previous) => {
  const before = new Set(previous.map(hand => hand.userId));
  const raised = next.find(hand => !before.has(hand.userId) && hand.userId !== myIdentity.value);
  if (raised) showToast(t('handRaised', { name: raised.displayName }));
  refreshParticipants();
});
function onData(payload: Uint8Array, sender?: RemoteParticipant, _kind?: unknown, topic?: string) {
  if (disposed || topic !== 'lesson') return;
  let message: LessonMessage;
  try { message = JSON.parse(decoder.decode(payload)); } catch { return; }
  // A reaction can arrive before LiveKit has introduced its sender; it is still shown, just unnamed.
  if (message?.type === 'reaction' && REACTIONS.includes(message.emoji)) addReaction(message.emoji, sender ? sender.name || sender.identity : '');
}

// Each voice plays at the lesson's volume times the volume chosen for that person.
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
// Remembered on this device only, so each student keeps the level that suits their speaker.
function savedVolume() {
  try {
    const saved = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
    return Number.isFinite(saved) ? clampVolume(saved) : 1;
  } catch { return 1; }
}
watch(volume, level => {
  applySound();
  try { localStorage.setItem(VOLUME_KEY, String(level)); } catch { /* Private browsing: the level lasts for this lesson. */ }
});
// Each person's level is remembered the same way, so a teacher turned down stays down next lesson.
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
  try { localStorage.setItem(PERSON_VOLUMES_KEY, JSON.stringify(personVolumes.value)); } catch { /* Lasts for this lesson. */ }
}
// On an iPhone the mixer is the sound, so the "tap to turn on sound" button follows whether it is running.
function onMixerStateChange() {
  if (!disposed && audioContext) audioBlocked.value = audioContext.state !== 'running';
}
// Made as the lesson opens, still within the student's tap on "Join lesson", which is when an
// iPhone is most likely to let it start without asking for another tap.
function createMixer() {
  if (!webAudioVolume) return;
  try { audioContext = new AudioContext({ latencyHint: 'interactive' }); } catch { return; }
  audioContext.addEventListener('statechange', onMixerStateChange);
  resumeMixer();
}
function resumeMixer() {
  if (audioContext && audioContext.state !== 'running' && audioContext.state !== 'closed') void audioContext.resume().catch(() => {});
}
// A phone pauses the lesson's sound when another app takes the speaker or the browser is put away,
// and nothing starts it again by itself, so it is restarted whenever the student is back on the page.
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
  // The page's audio is running again, so a microphone that was sent as recorded can be warmed again.
  await warmMicrophone();
}
// Every voice sent from the website gets the warmer tone; if that is not possible, it goes out as recorded.
async function warmMicrophone() {
  const microphone = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  if (!microphone || microphone.getProcessor()) return;
  try { await microphone.setProcessor(warmVoice()); } catch { /* The class still hears the voice, just not warmed. */ }
}
// Students join listening, with their microphone off, so a class of open microphones never
// drowns out the teacher; each student unmutes to speak.
async function setMicrophone(enabled: boolean) {
  if (!room) return;
  try {
    if (enabled && audioBlocked.value) await enableAudio();
    mutingMyself = !enabled;
    await room.localParticipant.setMicrophoneEnabled(enabled);
    if (enabled) await warmMicrophone();
  } catch {
    showToast(t('micBlocked'));
  } finally {
    mutingMyself = false;
    refreshParticipants();
  }
}
async function muteParticipant(identity?: string) {
  try {
    await api.muteInLesson(identity);
    if (!identity) showToast(t('mutedEveryone'));
  } catch (cause) {
    showToast(cause instanceof ApiError ? translateError(cause.message) : t('muteFailed'));
  }
}
async function toggleScreenShare() {
  if (!room) return;
  try {
    await room.localParticipant.setScreenShareEnabled(!sharingScreen.value, { audio: false, contentHint: 'text', selfBrowserSurface: 'exclude' });
  } catch { /* The teacher closed the browser's screen picker. */ }
  refreshParticipants();
}
async function toggleFullscreen() {
  sheet.value = null;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await overlay.value?.requestFullscreen();
  } catch { /* Some mobile browsers only allow video elements to go full screen. */ }
}
function onFullscreenChange() { fullscreen.value = Boolean(document.fullscreenElement); }

// Keeps a phone from dimming and locking while its student watches the teacher's screen. Browsers
// release the lock whenever the page is hidden, so it is requested again when the page returns.
async function keepScreenOn() {
  if (disposed || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Battery saver, or not supported. */ }
}
function onVisibilityChange() {
  if (disposed || document.visibilityState !== 'visible') return;
  void keepScreenOn();
  if (rejoinWhenVisible) { rejoinWhenVisible = false; void rejoin(); } else resumeSound();
}

function onChatMessage(message: { conversationId: string; senderId: string }) {
  if (message.conversationId === props.conversationId && message.senderId !== myIdentity.value && sheet.value !== 'chat') unreadChat.value++;
}

async function connect() {
  try {
    const credentials = await api.getLiveKitToken(props.conversationId);
    if (disposed) return;
    startedAt.value = credentials.startedAt;
    const connectingRoom = new Room(audioContext ? { webAudioMix: { audioContext } } : undefined);
    room = connectingRoom;
    // Events from a room that a rejoin has replaced are ignored.
    const current = () => !disposed && room === connectingRoom;
    connectingRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => { if (current()) attach(track, participant); });
    connectingRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      const elements = track.detach();
      for (const element of elements) {
        const index = detachedAudio.indexOf(element);
        if (index !== -1) detachedAudio.splice(index, 1);
        if (element !== video.value) element.remove();
      }
      if (current() && track.source === Track.Source.ScreenShare) status.value = 'waiting';
    });
    connectingRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (current()) audioBlocked.value = !connectingRoom.canPlaybackAudio; });
    // LiveKit retries a dropped connection for a while before giving up with Disconnected.
    connectingRoom.on(RoomEvent.Reconnecting, () => { if (current()) status.value = 'reconnecting'; });
    connectingRoom.on(RoomEvent.Reconnected, () => {
      if (!current()) return;
      const screenShown = [...connectingRoom.remoteParticipants.values()].some(participant => participant.getTrackPublication(Track.Source.ScreenShare)?.track);
      status.value = screenShown ? 'live' : 'waiting';
      refreshParticipants();
    });
    connectingRoom.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (!current() || error.value) return;
      status.value = 'disconnected';
      // An ended lesson, a teacher removing this student, or the lesson opened on another device
      // stays closed. Anything else, such as the browser putting the page to sleep while the student
      // was in another app, is rejoined as soon as the student is looking at the page. A lesson that
      // keeps dropping straight after a rejoin is left for the student to rejoin by hand.
      if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.DUPLICATE_IDENTITY) return;
      if (Date.now() - lastAutoRejoinAt < 15_000) return;
      lastAutoRejoinAt = Date.now();
      if (document.visibilityState === 'visible') void rejoin();
      else rejoinWhenVisible = true;
    });
    connectingRoom.on(RoomEvent.DataReceived, onData);
    connectingRoom.on(RoomEvent.TrackMuted, (publication: TrackPublication, participant: Participant) => {
      if (current() && participant === connectingRoom.localParticipant && publication.source === Track.Source.Microphone && !mutingMyself) {
        showToast(t('teacherMutedYou'));
      }
    });
    for (const event of [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged, RoomEvent.ParticipantAttributesChanged,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged,
    ] as const) connectingRoom.on(event, () => { if (current()) refreshParticipants(); });
    await connectingRoom.connect(credentials.url, credentials.token);
    if (!current()) { connectingRoom.disconnect(); return; }
    status.value = 'waiting';
    for (const participant of connectingRoom.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track, participant);
    }
    refreshParticipants();
    // The teacher is heard as soon as the lesson opens; students start muted.
    if (props.presenter) await setMicrophone(true);
  } catch (cause) {
    if (disposed) return;
    error.value = cause instanceof ApiError ? translateError(cause.message) : t('lessonConnectFailed');
  }
}
async function rejoin() {
  rejoinWhenVisible = false;
  const previous = room;
  room = null;
  previous?.disconnect();
  detachedAudio.splice(0).forEach(element => element.remove());
  error.value = '';
  status.value = 'joining';
  participants.value = [];
  await connect();
}
function cleanup() {
  if (disposed) return;
  disposed = true;
  if (myHandRaised.value) getSocket()?.emit('raise_hand', { conversationId: props.conversationId, raised: false });
  clearTimeout(hideChromeTimer);
  clearTimeout(toastTimer);
  clearInterval(clockTimer);
  getSocket()?.off('new_message', onChatMessage);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pageshow', onVisibilityChange);
  void wakeLock?.release().catch(() => {});
  if (document.fullscreenElement === overlay.value) void document.exitFullscreen().catch(() => {});
  room?.disconnect(); room = null;
  detachedAudio.splice(0).forEach(element => element.remove());
  audioContext?.removeEventListener('statechange', onMixerStateChange);
  void audioContext?.close().catch(() => {});
  audioContext = undefined;
}
function leave() { cleanup(); emit('leave'); }
function finish() { if (props.presenter) sheet.value = 'leave'; else leave(); }
function endForEveryone() { sheet.value = null; emit('end'); }
onMounted(() => {
  getSocket()?.on('new_message', onChatMessage);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  // Escape closes an open panel wherever keyboard focus happens to be.
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // A page brought back from the browser's back-forward cache may not report a visibility change.
  window.addEventListener('pageshow', onVisibilityChange);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  void keepScreenOn();
  createMixer();
  void connect();
});
onBeforeUnmount(cleanup);
</script>

<template>
  <section
    ref="overlay"
    class="lesson-overlay"
    :class="{ 'chrome-hidden': !chromeVisible }"
    :aria-label="t('liveLesson')"
    @pointermove="onPointerMove"
    @focusin="showChrome"
  >
    <header class="lesson-header">
      <div class="lesson-title">
        <span class="lesson-title-icon"><Radio :size="18" /></span>
        <div>
          <span class="lesson-eyebrow"><span class="live-dot" />{{ t('liveNow') }}<bdi v-if="elapsed" class="lesson-clock">{{ elapsed }}</bdi></span>
          <strong>{{ t('liveLesson') }}</strong>
          <p v-if="!error">{{ statusText }}</p>
        </div>
      </div>
      <div class="lesson-header-actions">
        <button
          class="lesson-round-btn"
          type="button"
          :title="soundOn && !audioBlocked ? t('lessonSoundOn') : t('lessonSoundOff')"
          :aria-label="soundOn && !audioBlocked ? t('lessonSoundOn') : t('lessonSoundOff')"
          @click="toggleSound"
        >
          <Volume2 v-if="soundOn && !audioBlocked" :size="20" />
          <VolumeX v-else :size="20" />
        </button>
      </div>
    </header>

    <main class="lesson-stage" @pointerup="onStageTap">
      <!-- Muted: the teacher's voice plays through separate audio elements, and a muted video may always autoplay. -->
      <video ref="video" class="lesson-screen" autoplay playsinline muted />
      <div v-if="error" class="lesson-state-card error" role="alert">
        <span class="lesson-state-icon"><X :size="22" /></span>
        <strong>{{ t('lessonJoinFailed') }}</strong>
        <p dir="auto">{{ error }}</p>
        <button class="lesson-state-action" type="button" @click="rejoin"><RotateCcw :size="16" />{{ t('rejoinLesson') }}</button>
      </div>
      <div v-else-if="status === 'disconnected'" class="lesson-state-card" role="status">
        <span class="lesson-state-icon"><Radio :size="22" /></span>
        <strong>{{ t('lessonDisconnected') }}</strong>
        <button class="lesson-state-action" type="button" @click="rejoin"><RotateCcw :size="16" />{{ t('rejoinLesson') }}</button>
      </div>
      <div v-else-if="status === 'sharing'" class="lesson-state-card" role="status">
        <span class="lesson-state-icon"><ScreenShare :size="22" /></span>
        <strong>{{ t('youAreSharing') }}</strong>
        <p>{{ t('youAreSharingBody') }}</p>
      </div>
      <div v-else-if="status !== 'live'" class="lesson-state-card" role="status">
        <span class="lesson-state-icon"><Radio :size="22" /></span>
        <strong>{{ t('lessonWaitingTitle') }}</strong>
        <p>{{ statusText }}</p>
      </div>
    </main>

    <button v-if="audioBlocked" class="lesson-pill lesson-sound-pill" type="button" @click="enableAudio">
      <Volume2 :size="17" />{{ t('tapToEnableSound') }}
    </button>
    <div v-if="toast" class="lesson-pill lesson-toast" role="status"><bdi>{{ toast }}</bdi></div>

    <div class="lesson-reactions" aria-hidden="true">
      <div v-for="reaction in reactions" :key="reaction.id" class="lesson-reaction" :style="{ '--drift': `${reaction.drift}px` }">
        <span class="lesson-reaction-emoji">{{ reaction.emoji }}</span>
        <bdi class="lesson-reaction-name">{{ reaction.name }}</bdi>
      </div>
    </div>

    <button v-if="myHandRaised" class="lesson-pill lesson-hand-pill" type="button" @click="toggleHand">
      <Hand :size="17" />{{ t('lowerHand') }}
    </button>

    <footer class="lesson-controls" @pointerdown="showChrome">
      <button
        class="lesson-control mic"
        :class="{ active: micOn, muted: !micOn }"
        type="button"
        :aria-pressed="micOn"
        :disabled="status === 'joining' || Boolean(error)"
        @click="setMicrophone(!micOn)"
      >
        <Mic v-if="micOn" :size="22" />
        <MicOff v-else :size="22" />
        <span>{{ micOn ? t('mute') : t('unmute') }}</span>
      </button>
      <button v-if="canShareScreen" class="lesson-control share" :class="{ active: sharingScreen }" type="button" :aria-pressed="sharingScreen" @click="toggleScreenShare">
        <ScreenShareOff v-if="sharingScreen" :size="22" />
        <ScreenShare v-else :size="22" />
        <span>{{ sharingScreen ? t('stopSharing') : t('shareScreen') }}</span>
      </button>
      <button class="lesson-control chat" type="button" :aria-pressed="sheet === 'chat'" @click="openSheet('chat')">
        <span class="lesson-control-icon">
          <MessageSquare :size="22" />
          <span v-if="unreadChat" class="lesson-badge">{{ unreadChat > 9 ? '9+' : unreadChat }}</span>
        </span>
        <span>{{ t('lessonChat') }}</span>
      </button>
      <button class="lesson-control people" type="button" :aria-pressed="sheet === 'participants'" @click="openSheet('participants')">
        <span class="lesson-control-icon">
          <Users :size="22" />
          <span v-if="participants.length" class="lesson-count">{{ participants.length }}</span>
          <span v-if="raisedHands.size" class="lesson-badge hand">✋</span>
        </span>
        <span>{{ t('participants') }}</span>
      </button>
      <button class="lesson-control more" type="button" :aria-pressed="sheet === 'more'" @click="openSheet('more')">
        <Ellipsis :size="22" />
        <span>{{ t('more') }}</span>
      </button>
      <button class="lesson-control danger" type="button" @click="finish">
        <span class="lesson-leave-icon"><X :size="16" :stroke-width="3" /></span>
        <span>{{ presenter ? t('end') : t('leave') }}</span>
      </button>
    </footer>

    <template v-if="sheet">
      <div class="lesson-sheet-backdrop" @click="sheet = null" />

      <section v-if="sheet === 'participants'" class="lesson-sheet side" :aria-label="t('participants')">
        <div class="lesson-sheet-head">
          <button class="lesson-round-btn small" type="button" :aria-label="t('close')" @click="sheet = null"><X :size="18" /></button>
          <strong>{{ t('participantsCount', { count: participants.length }) }}</strong>
        </div>
        <button v-if="isTeacher && studentsWithMicOn" class="lesson-mute-all" type="button" @click="muteParticipant()">
          <MicOff :size="17" />{{ t('muteEveryone') }}
        </button>
        <ul class="lesson-people">
          <li v-for="person in participants" :key="person.identity" :class="{ speaking: person.speaking }">
            <Avatar :name="person.name" :color="avatarColor(person.identity)" />
            <div class="lesson-person-main">
              <span class="lesson-person-name">
                <bdi>{{ person.name }}</bdi>
                <small v-if="person.local">{{ t('youLabel') }}</small>
                <small v-else-if="person.teacher">{{ t('hostLabel') }}</small>
              </span>
              <!-- Only on this device: turning someone down here changes nothing for the rest of the class. -->
              <label v-if="canAdjustVolume && !person.local" class="lesson-person-volume">
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
            <button
              v-if="raisedHands.has(person.identity) && (isTeacher || person.local)"
              class="lesson-person-hand"
              type="button"
              :title="t('lowerHand')"
              :aria-label="t('lowerHand')"
              @click="person.local ? toggleHand() : lowerHandOf(person.identity)"
            >✋</button>
            <span v-else-if="raisedHands.has(person.identity)" class="lesson-person-hand">✋</span>
            <button
              v-if="isTeacher && !person.local && !person.teacher && person.micOn"
              class="lesson-person-mute"
              type="button"
              :title="t('muteParticipant', { name: person.name })"
              :aria-label="t('muteParticipant', { name: person.name })"
              @click="muteParticipant(person.identity)"
            >
              <Mic :size="20" class="lesson-person-mic on" />
            </button>
            <Mic v-else-if="person.micOn" :size="20" class="lesson-person-mic" :class="{ on: person.speaking }" />
            <MicOff v-else :size="20" class="lesson-person-mic off" />
          </li>
        </ul>
      </section>

      <section v-else-if="sheet === 'chat'" class="lesson-sheet side chat" :aria-label="t('lessonChat')">
        <div class="lesson-sheet-head">
          <button class="lesson-round-btn small" type="button" :aria-label="t('close')" @click="sheet = null"><X :size="18" /></button>
          <strong>{{ t('lessonChat') }}</strong>
        </div>
        <div class="lesson-chat-body"><slot name="chat" /></div>
      </section>

      <section v-else-if="sheet === 'more'" class="lesson-sheet" :aria-label="t('more')">
        <span class="lesson-sheet-handle" />
        <div class="lesson-reaction-row">
          <button class="lesson-hand-btn" :class="{ raised: myHandRaised }" type="button" @click="toggleHand">
            <span aria-hidden="true">✋</span>{{ myHandRaised ? t('lowerHand') : t('raiseHand') }}
          </button>
          <button v-for="emoji in REACTIONS" :key="emoji" class="lesson-emoji-btn" type="button" :aria-label="`${t('reactions')} ${emoji}`" @click="react(emoji)">{{ emoji }}</button>
        </div>
        <label v-if="canAdjustVolume" class="lesson-volume">
          <Volume1 :size="20" aria-hidden="true" />
          <span>{{ t('lessonVolume') }}</span>
          <input v-model.number="volume" type="range" :min="MIN_VOLUME" max="1" step="0.05">
          <Volume2 :size="20" aria-hidden="true" />
        </label>
        <div class="lesson-more-grid">
          <button type="button" @click="openSheet('participants')">
            <span class="lesson-control-icon"><Users :size="24" /><span class="lesson-count">{{ participants.length }}</span></span>
            {{ t('participants') }}
          </button>
          <button v-if="fullscreenSupported" type="button" @click="toggleFullscreen">
            <Minimize v-if="fullscreen" :size="24" /><Maximize v-else :size="24" />{{ fullscreen ? t('exitFullscreen') : t('fullscreen') }}
          </button>
          <button type="button" @click="openSheet('info')"><Info :size="24" />{{ t('lessonInfo') }}</button>
        </div>
      </section>

      <section v-else-if="sheet === 'info'" class="lesson-sheet" :aria-label="t('lessonInfo')">
        <span class="lesson-sheet-handle" />
        <strong class="lesson-sheet-title">{{ t('liveLesson') }}</strong>
        <dl class="lesson-info">
          <div><dt>{{ t('lessonDuration') }}</dt><dd><bdi>{{ elapsed || '—' }}</bdi></dd></div>
          <div><dt>{{ t('participants') }}</dt><dd>{{ participants.length }}</dd></div>
          <div v-if="participants.find(person => person.teacher)"><dt>{{ t('lessonTeacher') }}</dt><dd><bdi>{{ participants.find(person => person.teacher)?.name }}</bdi></dd></div>
        </dl>
      </section>

      <section v-else-if="sheet === 'leave'" class="lesson-sheet" :aria-label="t('end')">
        <span class="lesson-sheet-handle" />
        <p class="lesson-sheet-prompt">{{ t('endLessonPrompt') }}</p>
        <div class="lesson-leave-actions">
          <button class="danger" type="button" @click="endForEveryone">{{ t('endLessonForAll') }}</button>
          <button type="button" @click="leave">{{ t('leaveLessonOnly') }}</button>
          <button type="button" @click="sheet = null">{{ t('cancel') }}</button>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.lesson-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-accent);
  font-size: 11px;
  font-weight: 700;
}

/* Live lesson: the teacher's screen fills the viewport and the header and controls float over it. */
.lesson-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  min-width: 320px;
  overflow: hidden;
  color: #edf3ef;
  background: #000000;
}

.lesson-overlay.chrome-hidden {
  cursor: none;
}

.lesson-stage {
  position: absolute;
  inset: 0;
  display: grid;
  /* A definite cell lets the video's 100% height resolve, so portrait screens are fitted instead of cropped. */
  grid-template: minmax(0, 1fr) / minmax(0, 1fr);
  place-items: center;
}

.lesson-screen {
  width: 100%;
  height: 100%;
  display: block;
  background: #000000;
  object-fit: contain;
}

.lesson-header,
.lesson-controls {
  position: absolute;
  inset-inline: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  transition: opacity 220ms ease, transform 220ms ease;
}

.lesson-header {
  top: 0;
  padding: max(12px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 28px max(16px, env(safe-area-inset-left));
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.72), transparent);
}

.lesson-controls {
  bottom: 0;
  justify-content: center;
  gap: 6px;
  padding: 30px max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  background: linear-gradient(to top, rgba(0, 0, 0, 0.78), transparent);
}

.chrome-hidden .lesson-header {
  opacity: 0;
  pointer-events: none;
  transform: translateY(-100%);
}

.chrome-hidden .lesson-controls {
  opacity: 0;
  pointer-events: none;
  transform: translateY(100%);
}

.lesson-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.lesson-title-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: #59cda0;
  background: rgba(89, 205, 160, 0.16);
}

.lesson-title strong {
  font-size: 14px;
}

.lesson-title p {
  overflow: hidden;
  color: rgba(237, 243, 239, 0.7);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lesson-state-card {
  max-width: min(390px, calc(100% - 32px));
  position: absolute;
  inset: 50% auto auto 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 22px 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  color: #edf3ef;
  background: rgba(21, 33, 30, 0.9);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
  text-align: center;
  transform: translate(-50%, -50%);
  backdrop-filter: blur(14px);
}

.lesson-state-card p {
  color: #9eaca4;
  font-size: 12px;
  line-height: 1.55;
}

.lesson-state-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  margin-bottom: 2px;
  border-radius: 14px;
  color: #59cda0;
  background: rgba(89, 205, 160, 0.13);
}

.lesson-state-card.error .lesson-state-icon {
  color: #f0776e;
  background: rgba(240, 119, 110, 0.13);
}

.lesson-state-action {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  padding: 0 16px;
  border-radius: 12px;
  color: #0b1a14;
  background: #59cda0;
  font-size: 13px;
  font-weight: 700;
}

.lesson-control:disabled {
  opacity: 0.45;
}

.lesson-control.share.active > svg {
  color: #59cda0;
}

.lesson-mute-all {
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 12px 0 2px;
  border-radius: 12px;
  color: #edf3ef;
  background: rgba(240, 119, 110, 0.16);
  font-size: 13px;
  font-weight: 700;
}

.lesson-mute-all:hover {
  background: rgba(240, 119, 110, 0.26);
}

/* The teacher taps a student's open microphone to mute it. */
button.lesson-person-mute {
  display: grid;
  place-items: center;
  padding: 4px;
  border-radius: 10px;
  background: rgba(89, 205, 160, 0.14);
}

button.lesson-person-mute:hover {
  background: rgba(240, 119, 110, 0.22);
}

.lesson-control {
  min-width: 0;
  min-height: 58px;
  flex: 0 1 80px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 4px;
  border-radius: 12px;
  color: #edf3ef;
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  text-align: center;
  transition: background 160ms ease, color 160ms ease;
}

.lesson-control:hover,
.lesson-control[aria-pressed='true'] {
  background: rgba(255, 255, 255, 0.12);
}

.lesson-control.active > svg {
  color: #59cda0;
}

.lesson-control.muted > svg {
  color: #f0776e;
}

.lesson-control-icon {
  position: relative;
  display: inline-grid;
}

.lesson-count {
  position: absolute;
  top: -7px;
  inset-inline-end: -11px;
  font-size: 11px;
  font-weight: 700;
}

.lesson-badge {
  min-width: 17px;
  height: 17px;
  position: absolute;
  top: -6px;
  inset-inline-end: -10px;
  display: grid;
  place-items: center;
  padding-inline: 4px;
  border-radius: 999px;
  color: #ffffff;
  background: #e0453b;
  font-size: 10px;
  font-weight: 700;
}

.lesson-badge.hand {
  top: auto;
  bottom: -6px;
  background: transparent;
  font-size: 12px;
}

.lesson-leave-icon {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: 2px solid #f0776e;
  border-radius: 8px;
  color: #f0776e;
  transform: rotate(45deg);
}

.lesson-leave-icon svg {
  transform: rotate(-45deg);
}

.lesson-header {
  justify-content: space-between;
  gap: 12px;
}

.lesson-header-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 8px;
}

.lesson-round-btn {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #edf3ef;
  background: rgba(255, 255, 255, 0.14);
}

.lesson-round-btn:hover {
  background: rgba(255, 255, 255, 0.22);
}

.lesson-round-btn.small {
  width: 36px;
  height: 36px;
}

.lesson-clock {
  margin-inline-start: 6px;
  color: rgba(237, 243, 239, 0.75);
  font-variant-numeric: tabular-nums;
}

/* Floating notices stay put while the header and controls fade. */
.lesson-pill {
  position: absolute;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 15px;
  border-radius: 999px;
  color: #edf3ef;
  background: rgba(28, 36, 33, 0.92);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  backdrop-filter: blur(10px);
}

.lesson-sound-pill {
  top: calc(env(safe-area-inset-top) + 86px);
  left: 50%;
  color: #0b1a14;
  background: #59cda0;
  transform: translateX(-50%);
}

.lesson-toast {
  top: calc(env(safe-area-inset-top) + 136px);
  left: 50%;
  max-width: calc(100% - 32px);
  overflow: hidden;
  text-overflow: ellipsis;
  transform: translateX(-50%);
}

.lesson-hand-pill {
  bottom: calc(env(safe-area-inset-bottom) + 108px);
  inset-inline-start: 16px;
}

.lesson-reactions {
  width: 1px;
  position: absolute;
  bottom: calc(env(safe-area-inset-bottom) + 108px);
  inset-inline-end: 56px;
  z-index: 2;
  pointer-events: none;
}

.lesson-reaction {
  position: absolute;
  bottom: 0;
  inset-inline-end: var(--drift);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  animation: lesson-reaction-float 3.2s ease-out forwards;
}

.lesson-reaction-emoji {
  font-size: 34px;
  line-height: 1;
}

.lesson-reaction-name {
  max-width: 110px;
  overflow: hidden;
  padding: 1px 7px;
  border-radius: 999px;
  color: #edf3ef;
  background: rgba(0, 0, 0, 0.55);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes lesson-reaction-float {
  0% { opacity: 0; transform: translateY(0) scale(0.6); }
  12% { opacity: 1; transform: translateY(-20px) scale(1); }
  75% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-38dvh); }
}

/* Sheets: bottom sheets on phones, the participants and chat panels dock to the side on wide screens. */
.lesson-sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: rgba(0, 0, 0, 0.4);
}

.lesson-sheet {
  width: min(520px, 100%);
  max-height: 85dvh;
  position: absolute;
  bottom: 0;
  inset-inline: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  overflow: auto;
  padding: 10px 16px max(18px, env(safe-area-inset-bottom));
  border-radius: 22px 22px 0 0;
  color: #edf3ef;
  background: #1d2421;
  margin-inline: auto;
  box-shadow: 0 -16px 50px rgba(0, 0, 0, 0.45);
  animation: lesson-sheet-in 220ms ease-out;
}

.lesson-sheet.side {
  height: 85dvh;
  padding-top: 14px;
}

.lesson-sheet.chat {
  overflow: hidden;
  padding-inline: 0;
  padding-bottom: 0;
}

@keyframes lesson-sheet-in {
  from { opacity: 0; translate: 0 40px; }
}

.lesson-sheet-handle {
  width: 38px;
  height: 4px;
  flex: 0 0 auto;
  margin: 0 auto 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.3);
}

.lesson-sheet-head {
  display: grid;
  grid-template-columns: 36px 1fr 36px;
  align-items: center;
  flex: 0 0 auto;
  padding: 0 16px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.lesson-sheet.side:not(.chat) .lesson-sheet-head {
  margin-inline: -16px;
}

.lesson-sheet-head strong {
  font-size: 16px;
  text-align: center;
}

.lesson-sheet-title {
  margin-bottom: 8px;
  font-size: 16px;
  text-align: center;
}

.lesson-chat-body {
  min-height: 0;
  flex: 1;
  display: flex;
}

.lesson-people {
  margin: 0 -16px;
  padding: 6px 0;
  list-style: none;
}

.lesson-people li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
}

.lesson-people li.speaking .avatar {
  box-shadow: 0 0 0 2px #1d2421, 0 0 0 4px #59cda0;
}

.lesson-person-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.lesson-person-name {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  overflow: hidden;
  font-size: 15px;
  white-space: nowrap;
}

.lesson-person-name bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.lesson-person-name small {
  color: rgba(237, 243, 239, 0.6);
  font-size: 13px;
}

.lesson-person-volume {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lesson-person-volume svg {
  flex: none;
  color: #a9b6af;
}

.lesson-person-volume input {
  flex: 1;
  min-width: 0;
  height: 32px;
  margin: 0;
  accent-color: #59cda0;
}

.lesson-person-hand {
  font-size: 18px;
}

button.lesson-person-hand {
  padding: 4px 6px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.1);
}

.lesson-person-mic {
  flex: 0 0 auto;
  color: rgba(237, 243, 239, 0.6);
}

.lesson-person-mic.on {
  color: #59cda0;
}

.lesson-person-mic.off {
  color: #f0776e;
}

.lesson-reaction-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.lesson-volume {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: #edf3ef;
  font-size: 14px;
  font-weight: 600;
}

.lesson-volume svg {
  flex: none;
  color: #a9b6af;
}

.lesson-volume input {
  flex: 1;
  min-width: 0;
  height: 44px;
  accent-color: #59cda0;
}

.lesson-hand-btn {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 999px;
  color: #edf3ef;
  background: rgba(255, 255, 255, 0.1);
  font-size: 14px;
  font-weight: 600;
}

.lesson-hand-btn.raised {
  color: #0b1a14;
  background: #59cda0;
}

.lesson-emoji-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  font-size: 24px;
  line-height: 1;
}

.lesson-emoji-btn:hover,
.lesson-more-grid button:hover {
  background: rgba(255, 255, 255, 0.1);
}

.lesson-more-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  padding-top: 12px;
}

.lesson-more-grid button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 4px;
  border-radius: 14px;
  color: #edf3ef;
  font-size: 13px;
  line-height: 1.3;
  text-align: center;
}

.lesson-info {
  margin: 0;
}

.lesson-info dt {
  color: rgba(237, 243, 239, 0.6);
}

.lesson-info dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.lesson-sheet-prompt {
  margin-bottom: 14px;
  color: rgba(237, 243, 239, 0.8);
  font-size: 14px;
  line-height: 1.5;
  text-align: center;
}

.lesson-leave-actions {
  display: grid;
  gap: 8px;
}

.lesson-leave-actions button {
  min-height: 48px;
  border-radius: 14px;
  color: #edf3ef;
  background: rgba(255, 255, 255, 0.1);
  font-size: 14px;
  font-weight: 600;
}

.lesson-leave-actions button.danger {
  color: #ffffff;
  background: #e0453b;
}

@media (min-width: 900px) {
  .lesson-sheet.side {
    width: 380px;
    height: auto;
    max-height: none;
    top: 0;
    inset-inline-start: auto;
    margin: 0;
    border-radius: 0;
  }

  .lesson-sheet-backdrop:has(+ .lesson-sheet.side) {
    background: transparent;
  }
}

@media (max-width: 768px) {
  .lesson-state-card {
    padding: 18px;
  }
}

@media (max-width: 460px) {
  .lesson-controls {
    gap: 2px;
    padding-inline: 6px;
  }
}

@media (orientation: landscape) and (max-height: 520px) {
  .lesson-header {
    padding-bottom: 18px;
  }

  .lesson-controls {
    padding-top: 18px;
  }

  .lesson-control {
    min-height: 48px;
  }
}
</style>
