<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Mic, MicOff, Radio, Volume2, X } from 'lucide-vue-next';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { api } from '../api';
import { useI18n } from '../i18n';

const props = defineProps<{ conversationId: string; presenter: boolean }>();
const emit = defineEmits<{ leave: []; end: [] }>();
const { t } = useI18n();
const video = ref<HTMLVideoElement>();
const status = ref(t('joiningLesson'));
const error = ref('');
const micJoined = ref(false);
const micMuted = ref(false);
const audioBlocked = ref(false);
const chromeVisible = ref(true);
const live = computed(() => status.value === t('lessonLive') && !error.value);
let room: Room | null = null;
let hideChromeTimer: ReturnType<typeof setTimeout> | undefined;
const detachedAudio: HTMLMediaElement[] = [];

// Like a video call, the header and controls float over the teacher's screen and fade out while it is live.
function showChrome() {
  chromeVisible.value = true;
  clearTimeout(hideChromeTimer);
  if (live.value) hideChromeTimer = setTimeout(() => { chromeVisible.value = false; }, 4000);
}
function onStageTap(event: PointerEvent) {
  if (event.pointerType !== 'mouse' && chromeVisible.value && live.value) {
    clearTimeout(hideChromeTimer);
    chromeVisible.value = false;
  } else showChrome();
}
function onPointerMove(event: PointerEvent) { if (event.pointerType === 'mouse') showChrome(); }
watch(live, showChrome);

function attach(track: RemoteTrack) {
  if (track.kind === Track.Kind.Video && track.source === Track.Source.ScreenShare && video.value) {
    track.attach(video.value);
    status.value = t('lessonLive');
    return;
  }
  if (track.kind === Track.Kind.Audio) {
    const element = track.attach() as HTMLAudioElement;
    element.autoplay = true;
    document.body.appendChild(element);
    detachedAudio.push(element);
  }
}

async function enableAudio() {
  try { await room?.startAudio(); audioBlocked.value = false; } catch { error.value = t('voicePlaybackBlocked'); }
}
async function joinMic() {
  if (!room) return;
  try {
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
async function connect() {
  try {
    const credentials = await api.getLiveKitToken(props.conversationId);
    room = new Room();
    room.on(RoomEvent.TrackSubscribed, (track) => attach(track as RemoteTrack));
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.source !== Track.Source.ScreenShare) return;
      track.detach();
      status.value = t('waitingForTeacherScreen');
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => { audioBlocked.value = !room!.canPlaybackAudio; });
    room.on(RoomEvent.Disconnected, () => { if (!error.value) status.value = t('lessonDisconnected'); });
    await room.connect(credentials.url, credentials.token);
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track);
    }
    // The teacher may already be sharing, in which case attach() has just marked the lesson live.
    if (status.value !== t('lessonLive')) status.value = t('waitingForTeacherScreen');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('lessonJoinFailed'); status.value = '';
  }
}
function leave() { clearTimeout(hideChromeTimer); room?.disconnect(); room = null; detachedAudio.splice(0).forEach(element => element.remove()); emit('leave'); }
function finish() { if (props.presenter) emit('end'); else leave(); }
onMounted(() => { void connect(); });
onBeforeUnmount(leave);
</script>

<template>
  <section
    class="lesson-overlay"
    :class="{ 'chrome-hidden': !chromeVisible }"
    :aria-label="t('liveLesson')"
    @pointermove="onPointerMove"
    @focusin="showChrome"
  >
    <header class="lesson-header">
      <div class="lesson-title">
        <span class="lesson-title-icon"><Radio :size="20" /></span>
        <div>
          <span class="lesson-eyebrow"><span class="live-dot" />{{ t('liveNow') }}</span>
          <strong>{{ t('liveLesson') }}</strong>
          <p v-if="status">{{ status }}</p>
        </div>
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

    <footer class="lesson-controls" @pointerdown="showChrome">
      <button v-if="audioBlocked" class="lesson-control" type="button" @click="enableAudio">
        <Volume2 :size="19" />
        <span>{{ t('enableAudio') }}</span>
      </button>
      <button v-if="!micJoined" class="lesson-control" type="button" @click="joinMic">
        <MicOff :size="19" />
        <span>{{ t('joinVoice') }}</span>
      </button>
      <button
        v-else
        class="lesson-control"
        :class="{ active: !micMuted, muted: micMuted }"
        type="button"
        :aria-pressed="!micMuted"
        @click="toggleMute"
      >
        <Mic v-if="!micMuted" :size="19" />
        <MicOff v-else :size="19" />
        <span>{{ micMuted ? t('muted') : t('voiceOn') }}</span>
      </button>
      <button class="lesson-control danger" type="button" @click="finish">
        <X :size="19" />
        <span>{{ presenter ? t('end') : t('leave') }}</span>
      </button>
    </footer>
  </section>
</template>
