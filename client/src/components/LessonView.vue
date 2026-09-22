<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Ellipsis, Hand, Headphones, Info, Maximize, MessageSquare, Mic, MicOff, Minimize, Radio, Users, Volume2, VolumeX, X,
} from 'lucide-vue-next';
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrack } from 'livekit-client';
import { api } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

type Sheet = 'participants' | 'chat' | 'more' | 'info' | 'leave';
type LessonMessage = { type: 'reaction'; emoji: string } | { type: 'hand'; raised: boolean } | { type: 'lower-hand'; identity: string };
type LessonParticipant = { identity: string; name: string; local: boolean; teacher: boolean; micOn: boolean; speaking: boolean };

const REACTIONS = ['👍', '❤️', '😂', '👏', '🎉', '😮'];
const AVATAR_COLORS = ['#7c5cc4', '#3a6ea5', '#2f8f6b', '#c0703a', '#b24a6c', '#5a7d2a'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const props = defineProps<{ conversationId: string; userId: string; presenter: boolean; presenterId: string }>();
const emit = defineEmits<{ leave: []; end: [] }>();
const { t } = useI18n();
const overlay = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
const status = ref(t('joiningLesson'));
const error = ref('');
const micJoined = ref(false);
const micMuted = ref(false);
const audioBlocked = ref(false);
const soundOn = ref(true);
const sheet = ref<Sheet | null>(null);
const participants = ref<LessonParticipant[]>([]);
const raisedHands = ref(new Set<string>());
const reactions = ref<{ id: number; emoji: string; name: string; drift: number }[]>([]);
const toast = ref('');
const unreadChat = ref(0);
const startedAt = ref(0);
const now = ref(Date.now());
const fullscreen = ref(false);
const fullscreenSupported = typeof document !== 'undefined' && document.fullscreenEnabled;
const chromeVisible = ref(true);
const live = computed(() => status.value === t('lessonLive') && !error.value);
let room: Room | null = null;
let hideChromeTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let reactionId = 0;
let lastReactionAt = 0;
let disposed = false;
const detachedAudio: HTMLMediaElement[] = [];

const myIdentity = computed(() => props.userId);
const myHandRaised = computed(() => raisedHands.value.has(myIdentity.value));
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
    teacher: participant.identity === props.presenterId,
    micOn: participant.isMicrophoneEnabled,
    speaking: participant.isSpeaking,
  });
  const others = [...room.remoteParticipants.values()]
    .map(participant => describe(participant, false))
    .sort((a, b) => Number(b.teacher) - Number(a.teacher) || a.name.localeCompare(b.name));
  participants.value = [describe(room.localParticipant, true), ...others];
}

function attach(track: RemoteTrack) {
  if (disposed) return;
  if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare && video.value) {
    track.attach(video.value);
    status.value = t('lessonLive');
    return;
  }
  if (track.kind === Track.Kind.Audio) {
    const element = track.attach() as HTMLAudioElement;
    element.autoplay = true;
    element.muted = !soundOn.value;
    document.body.appendChild(element);
    detachedAudio.push(element);
  }
}

async function send(message: LessonMessage, destinationIdentities?: string[]) {
  try {
    await room?.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true, topic: 'lesson', destinationIdentities });
  } catch { /* A dropped reaction or hand update is not worth interrupting the lesson for. */ }
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
function setHand(identity: string, raised: boolean) {
  const next = new Set(raisedHands.value);
  if (raised) next.add(identity); else next.delete(identity);
  raisedHands.value = next;
}
function toggleHand() {
  if (!room?.state || room.state !== 'connected') return;
  const raised = !myHandRaised.value;
  setHand(myIdentity.value, raised);
  void send({ type: 'hand', raised });
  sheet.value = null;
}
function lowerHandOf(identity: string) {
  setHand(identity, false);
  void send({ type: 'lower-hand', identity });
}
function onData(payload: Uint8Array, sender?: RemoteParticipant, _kind?: unknown, topic?: string) {
  if (disposed || topic !== 'lesson' || !sender) return;
  let message: LessonMessage;
  try { message = JSON.parse(decoder.decode(payload)); } catch { return; }
  if (!message || typeof message !== 'object') return;
  const name = sender.name || sender.identity;
  if (message.type === 'reaction' && REACTIONS.includes(message.emoji)) addReaction(message.emoji, name);
  else if (message.type === 'hand') {
    setHand(sender.identity, Boolean(message.raised));
    if (message.raised) showToast(t('handRaised', { name }));
  } else if (message.type === 'lower-hand' && sender.identity === props.presenterId && typeof message.identity === 'string') {
    setHand(message.identity, false);
  }
}

function applySound() { detachedAudio.forEach(element => { element.muted = !soundOn.value; }); }
async function toggleSound() {
  if (audioBlocked.value) { await enableAudio(); return; }
  soundOn.value = !soundOn.value;
  applySound();
}
async function enableAudio() {
  try { await room?.startAudio(); audioBlocked.value = false; soundOn.value = true; applySound(); } catch { error.value = t('voicePlaybackBlocked'); }
}
async function joinMic() {
  if (!room) return;
  try {
    soundOn.value = true;
    applySound();
    if (audioBlocked.value) await enableAudio();
    await room.localParticipant.setMicrophoneEnabled(true);
    micJoined.value = true;
    micMuted.value = false;
  } catch { error.value = t('voiceSetupFailed'); }
}
async function toggleMute() {
  if (!room || !micJoined.value) return;
  try {
    const newMuted = !micMuted.value;
    await room.localParticipant.setMicrophoneEnabled(!newMuted);
    micMuted.value = newMuted;
  } catch { error.value = t('voiceSetupFailed'); }
}
async function toggleAudioConnection() {
  sheet.value = null;
  if (micJoined.value || soundOn.value) {
    try { await room?.localParticipant.setMicrophoneEnabled(false); } catch { /* already off */ }
    micJoined.value = false;
    soundOn.value = false;
  } else {
    await joinMic();
  }
  applySound();
}
async function toggleFullscreen() {
  sheet.value = null;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await overlay.value?.requestFullscreen();
  } catch { /* Some mobile browsers only allow video elements to go full screen. */ }
}
function onFullscreenChange() { fullscreen.value = Boolean(document.fullscreenElement); }

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
    room.on(RoomEvent.TrackSubscribed, (track) => attach(track as RemoteTrack));
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      const elements = track.detach();
      for (const element of elements) {
        const index = detachedAudio.indexOf(element);
        if (index !== -1) detachedAudio.splice(index, 1);
        if (element !== video.value) element.remove();
      }
      if (!disposed && track.source === Track.Source.ScreenShare) status.value = t('waitingForTeacherScreen');
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!disposed) audioBlocked.value = !connectingRoom.canPlaybackAudio; });
    room.on(RoomEvent.Disconnected, () => { if (!disposed && !error.value) status.value = t('lessonDisconnected'); });
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      // Late joiners never saw the original hand message, so repeat it to them.
      if (myHandRaised.value) void send({ type: 'hand', raised: true }, [participant.identity]);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => { setHand(participant.identity, false); });
    for (const event of [
      RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged,
      RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged,
    ] as const) room.on(event, refreshParticipants);
    await connectingRoom.connect(credentials.url, credentials.token);
    if (disposed) { connectingRoom.disconnect(); return; }
    refreshParticipants();
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track);
    }
    // The teacher may already be sharing, in which case attach() has just marked the lesson live.
    if (status.value !== t('lessonLive')) status.value = t('waitingForTeacherScreen');
  } catch (cause) {
    if (disposed) return;
    error.value = cause instanceof Error ? cause.message : t('lessonJoinFailed'); status.value = '';
  }
}
function cleanup() {
  if (disposed) return;
  disposed = true;
  clearTimeout(hideChromeTimer);
  clearTimeout(toastTimer);
  clearInterval(clockTimer);
  getSocket()?.off('new_message', onChatMessage);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
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
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
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
    @keydown="onKeydown"
  >
    <header class="lesson-header">
      <div class="lesson-title">
        <span class="lesson-title-icon"><Radio :size="18" /></span>
        <div>
          <span class="lesson-eyebrow"><span class="live-dot" />{{ t('liveNow') }}<bdi v-if="elapsed" class="lesson-clock">{{ elapsed }}</bdi></span>
          <strong>{{ t('liveLesson') }}</strong>
          <p v-if="status">{{ status }}</p>
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
      <video ref="video" class="lesson-screen" autoplay playsinline />
      <div v-if="error" class="lesson-state-card error" role="alert">
        <span class="lesson-state-icon"><X :size="22" /></span>
        <strong>{{ t('lessonJoinFailed') }}</strong>
        <p dir="auto">{{ error }}</p>
      </div>
      <div v-else-if="status !== t('lessonLive')" class="lesson-state-card" role="status">
        <span class="lesson-state-icon"><Radio :size="22" /></span>
        <strong>{{ t('lessonWaitingTitle') }}</strong>
        <p>{{ status || t('lessonWaitingBody') }}</p>
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
      <button v-if="!micJoined" class="lesson-control" type="button" @click="joinMic">
        <Headphones :size="22" />
        <span>{{ t('joinAudio') }}</span>
      </button>
      <button
        v-else
        class="lesson-control"
        :class="{ active: !micMuted, muted: micMuted }"
        type="button"
        :aria-pressed="micMuted"
        @click="toggleMute"
      >
        <Mic v-if="!micMuted" :size="22" />
        <MicOff v-else :size="22" />
        <span>{{ micMuted ? t('unmute') : t('mute') }}</span>
      </button>
      <button class="lesson-control" type="button" :aria-pressed="sheet === 'chat'" @click="openSheet('chat')">
        <span class="lesson-control-icon">
          <MessageSquare :size="22" />
          <span v-if="unreadChat" class="lesson-badge">{{ unreadChat > 9 ? '9+' : unreadChat }}</span>
        </span>
        <span>{{ t('lessonChat') }}</span>
      </button>
      <button class="lesson-control" type="button" :aria-pressed="sheet === 'participants'" @click="openSheet('participants')">
        <span class="lesson-control-icon">
          <Users :size="22" />
          <span v-if="participants.length" class="lesson-count">{{ participants.length }}</span>
          <span v-if="raisedHands.size" class="lesson-badge hand">✋</span>
        </span>
        <span>{{ t('participants') }}</span>
      </button>
      <button class="lesson-control" type="button" :aria-pressed="sheet === 'more'" @click="openSheet('more')">
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
        <ul class="lesson-people">
          <li v-for="person in participants" :key="person.identity" :class="{ speaking: person.speaking }">
            <Avatar :name="person.name" :color="avatarColor(person.identity)" />
            <span class="lesson-person-name">
              <bdi>{{ person.name }}</bdi>
              <small v-if="person.local">{{ t('youLabel') }}</small>
              <small v-else-if="person.teacher">{{ t('hostLabel') }}</small>
            </span>
            <button
              v-if="raisedHands.has(person.identity) && (presenter || person.local)"
              class="lesson-person-hand"
              type="button"
              :title="t('lowerHand')"
              :aria-label="t('lowerHand')"
              @click="person.local ? toggleHand() : lowerHandOf(person.identity)"
            >✋</button>
            <span v-else-if="raisedHands.has(person.identity)" class="lesson-person-hand">✋</span>
            <Mic v-if="person.micOn" :size="20" class="lesson-person-mic" :class="{ on: person.speaking }" />
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
          <button type="button" @click="toggleAudioConnection">
            <Headphones :size="24" />{{ micJoined || soundOn ? t('disconnectAudio') : t('joinAudio') }}
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
