<script lang="ts">
// Only one voice message plays at a time, as in WhatsApp, so the playing one is shared by all.
let current: { pause: () => void } | null = null;
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { LoaderCircle, Pause, Play } from 'lucide-vue-next';
import { api } from '../api';
import { useI18n } from '../i18n';

const props = defineProps<{ attachmentId: string; durationMs?: number | null }>();
const { t } = useI18n();
const playing = ref(false);
const loading = ref(false);
const failed = ref(false);
const position = ref(0);
const length = ref((props.durationMs ?? 0) / 1000);
let audio: HTMLAudioElement | null = null;
let objectUrl = '';

const player = { pause: () => audio?.pause() };

const progress = computed(() => length.value ? Math.min(100, (position.value / length.value) * 100) : 0);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// The file downloads on the first tap, so opening a chat never downloads every voice message in it.
async function load() {
  loading.value = true;
  failed.value = false;
  try {
    objectUrl = URL.createObjectURL(await api.getAttachmentBlob(props.attachmentId));
    audio = new Audio(objectUrl);
    audio.addEventListener('timeupdate', () => { position.value = audio?.currentTime ?? 0; });
    // Recorded WebM files often report no length, so the length measured while recording is kept.
    audio.addEventListener('loadedmetadata', () => { if (Number.isFinite(audio?.duration) && audio!.duration > 0) length.value = audio!.duration; });
    audio.addEventListener('play', () => { playing.value = true; });
    audio.addEventListener('pause', () => { playing.value = false; });
    audio.addEventListener('ended', () => { playing.value = false; position.value = 0; });
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

async function toggle() {
  if (!audio) await load();
  if (!audio) return;
  if (!audio.paused) { audio.pause(); return; }
  if (current && current !== player) current.pause();
  current = player;
  await audio.play().catch(() => { failed.value = true; });
}

function seek(event: PointerEvent) {
  if (!audio || !length.value) return;
  const bar = event.currentTarget as HTMLElement;
  const rect = bar.getBoundingClientRect();
  const rtl = getComputedStyle(bar).direction === 'rtl';
  const fraction = Math.min(1, Math.max(0, (rtl ? rect.right - event.clientX : event.clientX - rect.left) / rect.width));
  audio.currentTime = fraction * length.value;
  position.value = audio.currentTime;
}

onBeforeUnmount(() => {
  audio?.pause();
  if (current === player) current = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <div class="voice-note">
    <button class="voice-note-play" type="button" :aria-label="playing ? t('pause') : t('playVoiceMessage')" @click="toggle">
      <LoaderCircle v-if="loading" class="spin" :size="18" />
      <Pause v-else-if="playing" :size="18" />
      <Play v-else :size="18" />
    </button>
    <div class="voice-note-bar" @pointerdown="seek">
      <span :style="{ width: `${progress}%` }" />
    </div>
    <span class="voice-note-time">{{ failed ? t('retry') : clock(playing || position ? position : length) }}</span>
  </div>
</template>

<style scoped>
.voice-note {
  width: min(300px, 100%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px 7px 7px;
  border-radius: 999px;
  background: var(--reply-overlay);
}

.voice-note-play {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.voice-note-bar {
  height: 18px;
  flex: 1;
  display: flex;
  align-items: center;
  /* The track is a thin line drawn behind the played part. */
  background: linear-gradient(var(--border-color), var(--border-color)) center / 100% 3px no-repeat;
  cursor: pointer;
  touch-action: none;
}

.voice-note-bar span {
  height: 3px;
  border-radius: 999px;
  background: var(--text-accent);
}

.voice-note-time {
  min-width: 34px;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: end;
}
</style>
