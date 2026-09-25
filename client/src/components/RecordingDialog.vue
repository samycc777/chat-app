<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { format } from 'date-fns';
import { Hash, LoaderCircle, Send, Trash2 } from 'lucide-vue-next';
import { api, ApiError } from '../api';
import { useI18n } from '../i18n';
import { recordingState, resetRecordingState } from '../recordingState';
import type { Channel } from '../types';

// Shown to the person who recorded a call once they stop, even if they have left the call: they
// choose the text channel it is posted in, or delete it. Until they choose, it stays on the server,
// and is posted in the first text channel by itself if they never do.
const props = defineProps<{ channels: Channel[] }>();
const { t, dateLocale, translateError } = useI18n();
const textChannels = computed(() => props.channels.filter(channel => channel.kind === 'text'));
const target = ref('');
const busy = ref(false);
const confirmingDelete = ref(false);
const error = ref('');
const stoppedNote = computed(() => recordingState.stoppedBecause || null);
const open = computed(() => recordingState.phase === 'saving' || recordingState.phase === 'ready');

watch(open, isOpen => {
  if (!isOpen) return;
  target.value = textChannels.value[0]?.id ?? '';
  confirmingDelete.value = false;
  error.value = '';
}, { immediate: true });
// A channel deleted while the dialog is open is replaced by the first one left.
watch(textChannels, list => { if (!list.some(channel => channel.id === target.value)) target.value = list[0]?.id ?? ''; });

const length = computed(() => {
  const seconds = Math.max(1, Math.round(recordingState.durationMs / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const clock = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return hours ? `${hours}:${clock}` : clock;
});

async function post() {
  if (busy.value || recordingState.phase !== 'ready' || !target.value) return;
  busy.value = true;
  error.value = '';
  try {
    const date = format(recordingState.startedAt || Date.now(), 'd MMM yyyy', { locale: dateLocale.value });
    const name = t('recordingFileName', { channel: recordingState.channelName, date });
    await api.finishRecording(recordingState.id, target.value, recordingState.durationMs, name);
    resetRecordingState();
  } catch (cause) {
    error.value = cause instanceof ApiError ? translateError(cause.message) : t('recordingPostFailed');
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.discardRecording(recordingState.id);
    resetRecordingState();
  } catch (cause) {
    // Already gone from the server is as good as deleted.
    if (cause instanceof ApiError && cause.status === 404) resetRecordingState();
    else error.value = t('recordingDeleteFailed');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="recording-backdrop">
    <form class="recording-dialog" role="dialog" aria-modal="true" :aria-label="t('recordingDialogTitle')" @submit.prevent="post">
      <template v-if="recordingState.lost">
        <strong class="recording-title">{{ t('recordingLostTitle') }}</strong>
        <p class="recording-text">{{ t('recordingLostBody') }}</p>
        <div class="recording-actions">
          <span class="recording-spacer" />
          <button class="recording-btn primary" type="button" :disabled="recordingState.phase !== 'ready'" @click="resetRecordingState">{{ t('close') }}</button>
        </div>
      </template>
      <template v-else>
        <strong class="recording-title">{{ t('recordingDialogTitle') }}</strong>
        <p v-if="stoppedNote" class="recording-text">{{ t(stoppedNote) }}</p>
        <p class="recording-text"><bdi>{{ recordingState.channelName }}</bdi> · <bdi>{{ length }}</bdi></p>
        <p v-if="recordingState.phase === 'saving'" class="recording-saving" role="status">
          <LoaderCircle class="spin" :size="16" aria-hidden="true" />
          {{ recordingState.uploadTrouble ? t('recordingWaitingForInternet') : t('recordingSaving') }}
        </p>

        <template v-if="confirmingDelete">
          <p class="recording-text">{{ t('recordingDeleteConfirm') }}</p>
          <p v-if="error" class="recording-error" role="alert">{{ error }}</p>
          <div class="recording-actions">
            <span class="recording-spacer" />
            <button class="recording-btn" type="button" :disabled="busy" @click="confirmingDelete = false">{{ t('recordingKeep') }}</button>
            <button class="recording-btn danger" type="button" :disabled="busy" @click="remove"><Trash2 :size="15" />{{ t('delete') }}</button>
          </div>
        </template>
        <template v-else>
          <label class="recording-field">
            <span>{{ t('recordingPostIn') }}</span>
            <span class="recording-select">
              <Hash :size="16" aria-hidden="true" />
              <select v-model="target" :disabled="busy">
                <option v-for="channel in textChannels" :key="channel.id" :value="channel.id">{{ channel.name }}</option>
              </select>
            </span>
          </label>
          <p v-if="error" class="recording-error" role="alert">{{ error }}</p>
          <div class="recording-actions">
            <button class="recording-btn danger-text" type="button" :disabled="busy" @click="confirmingDelete = true"><Trash2 :size="15" />{{ t('recordingDelete') }}</button>
            <span class="recording-spacer" />
            <button class="recording-btn primary" type="submit" :disabled="busy || recordingState.phase !== 'ready' || !target">
              <Send :size="15" />{{ t('recordingPost') }}
            </button>
          </div>
        </template>
      </template>
    </form>
  </div>
</template>

<style scoped>
.recording-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.6);
}

.recording-dialog {
  width: min(440px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border-radius: 10px;
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.recording-title {
  font-size: 18px;
}

.recording-text {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.recording-saving {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 14px;
}

.recording-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.recording-select {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--bg-tertiary);
}

.recording-select select {
  min-width: 0;
  min-height: 42px;
  flex: 1;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 16px;
  font-weight: 500;
  text-transform: none;
}

.recording-error {
  color: var(--danger);
  font-size: 13px;
}

.recording-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.recording-spacer {
  flex: 1;
}

.recording-btn {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
}

.recording-btn:disabled {
  opacity: 0.55;
}

.recording-btn.primary {
  color: #ffffff;
  background: var(--text-accent);
}

.recording-btn.danger {
  color: #ffffff;
  background: #da373c;
}

.recording-btn.danger-text {
  padding-inline: 4px;
  color: var(--danger);
}
</style>
