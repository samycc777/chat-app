<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Ellipsis, Hand, Info, Maximize, MessageSquare, Mic, MicOff, Minimize, Radio, RotateCcw, ScreenShare, ScreenShareOff,
  Users, Volume2, VolumeX, X,
} from 'lucide-vue-next';
import { DisconnectReason, Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrack, type TrackPublication } from 'livekit-client';
import { api, ApiError } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

type Sheet = 'participants' | 'chat' | 'more' | 'info' | 'leave';
type Status = 'joining' | 'waiting' | 'live' | 'sharing' | 'reconnecting' | 'disconnected';
type LessonMessage = { type: 'reaction'; emoji: string };
type LessonParticipant = { identity: string; name: string; local: boolean; teacher: boolean; micOn: boolean; speaking: boolean };

const REACTIONS = ['👍', '❤️', '😂', '👏', '🎉', '😮'];
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

function attach(track: RemoteTrack) {
  if (disposed) return;
  if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare && video.value) {
    track.attach(video.value);
    status.value = 'live';
    return;
  }
  if (track.kind === Track.Kind.Audio) {
    const element = track.attach() as HTMLAudioElement;
    element.autoplay = true;
    element.muted = !soundOn.value;
    element.addEventListener('pause', resumeSound);
    document.body.appendChild(element);
    detachedAudio.push(element);
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

function applySound() { detachedAudio.forEach(element => { element.muted = !soundOn.value; }); }
// A phone pauses the lesson's sound when another app takes the speaker or the browser is put away,
// and nothing starts it again by itself, so it is restarted whenever the student is back on the page.
function resumeSound() {
  if (disposed || document.visibilityState !== 'visible') return;
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
  try { await room?.startAudio(); audioBlocked.value = false; soundOn.value = true; applySound(); } catch { showToast(t('voicePlaybackBlocked')); }
}
// Students join listening, with their microphone off, so a class of open microphones never
// drowns out the teacher; each student unmutes to speak.
async function setMicrophone(enabled: boolean) {
  if (!room) return;
  try {
    if (enabled && audioBlocked.value) await enableAudio();
    mutingMyself = !enabled;
    await room.localParticipant.setMicrophoneEnabled(enabled);
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
    const connectingRoom = new Room();
    room = connectingRoom;
    // Events from a room that a rejoin has replaced are ignored.
    const current = () => !disposed && room === connectingRoom;
    connectingRoom.on(RoomEvent.TrackSubscribed, (track) => { if (current()) attach(track as RemoteTrack); });
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
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track);
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
            <span class="lesson-person-name">
              <bdi>{{ person.name }}</bdi>
              <small v-if="person.local">{{ t('youLabel') }}</small>
              <small v-else-if="person.teacher">{{ t('hostLabel') }}</small>
            </span>
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
