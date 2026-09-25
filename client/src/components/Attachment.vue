<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Download, ExternalLink, FileText, LoaderCircle, X } from 'lucide-vue-next';
import { api } from '../api';
import { useI18n } from '../i18n';

const props = defineProps<{
  attachmentId: string;
  name: string;
  image?: boolean;
  /** Sound and video play inside the chat once downloaded; other files open or save. */
  mimeType?: string | null;
  durationMs?: number | null;
}>();
const media = computed(() => props.mimeType?.startsWith('audio/') ? 'audio' : props.mimeType?.startsWith('video/') ? 'video' : null);
const emit = defineEmits<{ loaded: [] }>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const url = ref('');
const failed = ref(false);
const downloading = ref(false);
const progress = ref(0);
const viewing = ref(false);
let objectUrl = '';
let live = true;
let observer: IntersectionObserver | null = null;

async function fetchFile() {
  if (url.value || downloading.value) return;
  downloading.value = true;
  failed.value = false;
  progress.value = 0;
  try {
    const blob = await api.getAttachmentBlob(props.attachmentId, percent => { progress.value = percent; });
    objectUrl = URL.createObjectURL(blob);
    if (live) url.value = objectUrl;
    else URL.revokeObjectURL(objectUrl);
  } catch {
    failed.value = true;
  } finally {
    downloading.value = false;
  }
}

// Images download as they scroll near the screen and files only when tapped, so opening the chat
// on a phone never downloads every worksheet in the class's history.
onMounted(() => {
  if (!props.image || !root.value) return;
  observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer?.disconnect();
    void fetchFile();
  }, { rootMargin: '600px 0px' });
  observer.observe(root.value);
});

function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') viewing.value = false; }
watch(viewing, open => {
  if (open) document.addEventListener('keydown', closeOnEscape);
  else document.removeEventListener('keydown', closeOnEscape);
});

onBeforeUnmount(() => {
  live = false;
  observer?.disconnect();
  document.removeEventListener('keydown', closeOnEscape);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
});
</script>

<template>
  <div ref="root" class="attachment">
    <template v-if="image">
      <button v-if="url" class="message-image-button" type="button" :aria-label="t('openImage')" @click="viewing = true">
        <img class="message-image" :src="url" :alt="name" @load="emit('loaded')">
      </button>
      <div v-else class="message-image-placeholder">
        <button v-if="failed" type="button" @click="fetchFile">{{ t('retry') }}</button>
        <LoaderCircle v-else class="spin" :size="22" :aria-label="t('loadingImage')" />
      </div>
      <Teleport to="body">
        <div v-if="viewing" class="image-viewer" role="dialog" :aria-label="name" @click.self="viewing = false">
          <img :src="url" :alt="name">
          <div class="image-viewer-actions">
            <a class="image-viewer-button" :href="url" :download="name"><Download :size="18" />{{ t('save') }}</a>
            <button class="image-viewer-button" type="button" @click="viewing = false"><X :size="18" />{{ t('close') }}</button>
          </div>
        </div>
      </Teleport>
    </template>
    <div v-else-if="media && url" class="message-media">
      <audio v-if="media === 'audio'" :src="url" controls autoplay />
      <video v-else :src="url" controls autoplay playsinline />
    </div>
    <div v-else class="message-file">
      <span class="message-file-icon"><FileText :size="20" /></span>
      <span class="message-file-name" dir="auto">{{ name }}</span>
      <span v-if="url" class="message-file-actions">
        <a class="message-file-action" :href="url" target="_blank" rel="noopener">{{ t('open') }}<ExternalLink :size="14" /></a>
        <a class="message-file-action" :href="url" :download="name">{{ t('save') }}<Download :size="14" /></a>
      </span>
      <button v-else class="message-file-action" type="button" :disabled="downloading" @click="fetchFile">
        <template v-if="downloading">{{ progress }}%</template>
        <template v-else>{{ failed ? t('retry') : t('download') }}<Download :size="14" /></template>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Attachments: images load as they scroll into view, files when tapped. */
.message-media audio {
  width: min(330px, 100%);
}

.message-media video {
  display: block;
  width: min(480px, 100%);
  max-height: 360px;
  border-radius: 11px;
  background: #000000;
}

.message-image-button {
  display: block;
  padding: 0;
  border-radius: 11px;
  cursor: zoom-in;
}

.message-image {
  display: block;
  width: min(330px, 100%);
  max-height: 360px;
  border-radius: 11px;
  object-fit: cover;
}

.message-image-placeholder {
  width: min(330px, 62vw);
  aspect-ratio: 4 / 3;
  display: grid;
  place-items: center;
  border-radius: 11px;
  color: var(--text-secondary);
  background: var(--reply-overlay);
}

.message-image-placeholder button {
  min-height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  color: var(--text-accent);
  background: var(--accent-soft);
  font-size: 12px;
  font-weight: 700;
}

.message-file {
  min-width: min(280px, 64vw);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  color: var(--text-primary);
  background: var(--reply-overlay);
}

.message-file-icon {
  flex: 0 0 auto;
  display: grid;
  color: var(--text-accent);
}

.message-file-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-file-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 6px;
}

.message-file-action {
  min-height: 32px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border-radius: 9px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-decoration: none;
}

.message-file-action:disabled {
  opacity: 0.75;
}

.image-viewer {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  background: rgba(0, 0, 0, 0.9);
}

.image-viewer img {
  max-width: 100%;
  max-height: calc(100dvh - 120px);
  border-radius: 8px;
  object-fit: contain;
}

.image-viewer-actions {
  display: flex;
  gap: 10px;
}

.image-viewer-button {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 12px;
  color: #ffffff;
  background: rgba(255, 255, 255, 0.14);
  font-size: 14px;
  font-weight: 700;
  text-decoration: none;
}

.image-viewer-button:hover {
  background: rgba(255, 255, 255, 0.22);
}
</style>
