<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { format } from 'date-fns';
import { Hash, LoaderCircle, Search, X } from 'lucide-vue-next';
import type { Channel, Message } from '../types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { readableText } from '../mentions';

const props = defineProps<{ channels: Channel[]; nameOf: (userId: string) => string | undefined }>();
const emit = defineEmits<{ open: [message: Message]; close: [] }>();
const { t, dateLocale } = useI18n();
const query = ref('');
const results = ref<Message[]>([]);
const searching = ref(false);
const failed = ref(false);
const searched = ref('');
const input = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0;

// Searching starts a moment after typing stops, and only the newest search's results are shown.
watch(query, value => {
  clearTimeout(timer);
  const text = value.trim();
  if (text.length < 2) { results.value = []; searched.value = ''; return; }
  timer = setTimeout(async () => {
    const run = ++latest;
    searching.value = true;
    failed.value = false;
    try {
      const found: Message[] = await api.search(text);
      if (run === latest) { results.value = found; searched.value = text; }
    } catch {
      if (run === latest) failed.value = true;
    } finally {
      if (run === latest) searching.value = false;
    }
  }, 350);
});

const channelName = (id: string) => props.channels.find(channel => channel.id === id)?.name ?? '';
function preview(message: Message) {
  if (message.type === 'image') return `📷 ${t('photo')}`;
  if (message.mimeType?.startsWith('audio/')) return `🎤 ${t('voiceMessage')}`;
  if (message.type === 'file') return `📄 ${message.fileName ?? t('file')}`;
  return readableText(message.content, props.nameOf);
}

function onKey(event: KeyboardEvent) { if (event.key === 'Escape') emit('close'); }
onMounted(() => { void nextTick(() => input.value?.focus()); document.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { clearTimeout(timer); document.removeEventListener('keydown', onKey); });
</script>

<template>
  <aside class="search-panel" :aria-label="t('search')">
    <div class="search-head">
      <label class="search-box">
        <Search :size="16" aria-hidden="true" />
        <input ref="input" v-model="query" type="search" dir="auto" maxlength="100" :placeholder="t('searchMessages')" :aria-label="t('searchMessages')">
      </label>
      <button class="search-close" type="button" :aria-label="t('close')" @click="emit('close')"><X :size="18" /></button>
    </div>
    <div class="search-results" aria-live="polite">
      <p v-if="searching && !results.length" class="search-state"><LoaderCircle class="spin" :size="18" /></p>
      <p v-else-if="failed" class="search-state">{{ t('searchFailed') }}</p>
      <p v-else-if="query.trim().length < 2" class="search-state">{{ t('searchHint') }}</p>
      <p v-else-if="searched && !results.length" class="search-state">{{ t('noResults') }}</p>
      <button v-for="message in results" :key="message.id" class="search-result" type="button" @click="emit('open', message)">
        <span class="search-result-meta">
          <Hash :size="12" aria-hidden="true" /><bdi>{{ channelName(message.conversationId) }}</bdi>
          <span aria-hidden="true">·</span>
          <bdi class="search-result-sender" :style="{ color: message.sender.avatarColor }">{{ message.sender.displayName }}</bdi>
          <span class="search-result-date">{{ format(new Date(message.createdAt), 'PP', { locale: dateLocale }) }}</span>
        </span>
        <span class="search-result-text" dir="auto">{{ preview(message) }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.search-panel {
  width: 340px;
  min-height: 0;
  flex: 0 0 340px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.search-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: max(8px, env(safe-area-inset-top)) 8px 8px;
  border-bottom: 1px solid var(--border-color);
}

.search-box {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--bg-primary);
}

.search-box input {
  min-width: 0;
  flex: 1;
  height: 38px;
  color: var(--text-primary);
  background: transparent;
  /* Never below 16px, which stops iPhones from zooming into the box. */
  font-size: 16px;
}

.search-box input:focus-visible {
  outline: none;
}

.search-close {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-secondary);
}

.search-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.search-results {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.search-state {
  display: flex;
  justify-content: center;
  padding: 24px 12px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.search-result {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg-primary);
  text-align: start;
}

.search-result:hover {
  background: var(--bg-hover);
}

.search-result-meta {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  font-size: 12px;
}

.search-result-meta bdi {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-result-sender {
  font-weight: 700;
}

.search-result-date {
  flex: none;
  margin-inline-start: auto;
}

.search-result-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

/* On phones the search covers the whole screen. */
@media (max-width: 768px) {
  .search-panel {
    width: 100%;
    position: fixed;
    inset: 0;
    z-index: 60;
  }
}
</style>
