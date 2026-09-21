<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Mic, MicOff, Volume2, X } from 'lucide-vue-next';
import { ExternalE2EEKeyProvider, isE2EESupported, Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { api } from '../api';
import { useI18n } from '../i18n';

const props = defineProps<{ conversationId: string; presenter: boolean }>();
const emit = defineEmits<{ leave: []; end: [] }>();
const { t } = useI18n();
const video = ref<HTMLVideoElement>();
const status = ref(t('joiningLesson'));
const error = ref('');
const micEnabled = ref(false);
const audioBlocked = ref(false);
let room: Room | null = null;
const detachedAudio: HTMLMediaElement[] = [];

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
async function toggleMic() {
  if (!room) return;
  try {
    await room.localParticipant.setMicrophoneEnabled(!micEnabled.value);
    micEnabled.value = !micEnabled.value;
  } catch { error.value = t('voiceSetupFailed'); }
}
async function connect() {
  if (!isE2EESupported()) { error.value = t('e2eeUnsupported'); status.value = ''; return; }
  try {
    const credentials = await api.getLiveKitToken(props.conversationId);
    const keys = new ExternalE2EEKeyProvider();
    await keys.setKey(credentials.encryptionKey);
    room = new Room({ encryption: { keyProvider: keys, worker: new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' }) } });
    room.on(RoomEvent.TrackSubscribed, (track) => attach(track as RemoteTrack));
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => { audioBlocked.value = !room!.canPlaybackAudio; });
    room.on(RoomEvent.Disconnected, () => { if (!error.value) status.value = t('lessonDisconnected'); });
    await room.setE2EEEnabled(true);
    await room.connect(credentials.url, credentials.token);
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) if (publication.track) attach(publication.track);
    }
    status.value = t('waitingForTeacherScreen');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('lessonJoinFailed'); status.value = '';
  }
}
function leave() { room?.disconnect(); room = null; detachedAudio.splice(0).forEach(element => element.remove()); emit('leave'); }
function finish() { if (props.presenter) emit('end'); else leave(); }
onMounted(() => { void connect(); });
onBeforeUnmount(leave);
</script>

<template>
  <section class="lesson-overlay" aria-label="Live lesson">
    <header class="lesson-header"><div><strong>{{ t('liveLesson') }}</strong><p v-if="status">{{ status }}</p></div><div class="lesson-actions"><button v-if="audioBlocked" class="lesson-audio" @click="enableAudio"><Volume2 :size="18"/>{{ t('enableAudio') }}</button><button class="lesson-mic" :class="{ active: micEnabled }" @click="toggleMic"><Mic v-if="micEnabled" :size="18"/><MicOff v-else :size="18"/>{{ micEnabled ? t('voiceOn') : t('joinVoice') }}</button><button class="whiteboard-end-btn" @click="finish"><X :size="18"/><span>{{ presenter ? t('end') : t('leave') }}</span></button></div></header>
    <main class="lesson-stage"><p v-if="error" class="whiteboard-error">{{ error }}</p><video ref="video" class="lesson-screen" autoplay playsinline controls="false"/><p v-if="!error && status !== t('lessonLive')" class="lesson-waiting">{{ status }}</p></main>
  </section>
</template>
