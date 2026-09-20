<script setup lang="ts">
import { Phone, PhoneOff } from 'lucide-vue-next';
import type { User } from '../types';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';
defineProps<{ caller: User; callType: 'audio' | 'video' }>();
const emit = defineEmits<{ accept: []; reject: [] }>(); const { t } = useI18n();
</script>
<template><div class="incoming-call-banner"><Avatar :name="caller.displayName" :color="caller.avatarColor" size="small"/><div class="incoming-call-info"><div class="incoming-call-name">{{ caller.displayName }}</div><div class="incoming-call-type">{{ t('incomingCall', { type: t(callType) }) }}</div></div><div class="incoming-call-actions"><button class="call-action-btn accept" :title="t('accept')" @click="emit('accept')"><Phone :size="20"/></button><button class="call-action-btn reject" :title="t('reject')" @click="emit('reject')"><PhoneOff :size="20"/></button></div></div></template>
