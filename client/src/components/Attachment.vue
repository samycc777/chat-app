<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Download, ExternalLink, FileText, LoaderCircle, X } from 'lucide-vue-next';
import { api } from '../api';
import { useI18n } from '../i18n';

const props = defineProps<{ attachmentId: string; name: string; image?: boolean }>();
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
