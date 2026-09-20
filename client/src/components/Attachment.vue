<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { Download } from 'lucide-vue-next';
import { api } from '../api';
const props = defineProps<{ attachmentId: string; name: string; image?: boolean }>();
const url = ref(''), failed = ref(false); let live = true, objectUrl = '';
api.getAttachmentBlob(props.attachmentId).then(blob => { objectUrl = URL.createObjectURL(blob); if (live) url.value = objectUrl; }).catch(() => { failed.value = true; });
onBeforeUnmount(() => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); });
</script>
<template><span v-if="failed" class="message-content">{{ name }}</span><span v-else-if="!url" class="message-content">…</span><img v-else-if="image" class="message-image" :src="url" :alt="name" loading="lazy"><a v-else class="message-file" :href="url" :download="name"><Download :size="18"/><span>{{ name }}</span></a></template>
