<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { MessageSquare, Users, Volume2, VolumeX } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { useCall } from '../call/context';

// The bar along the top of the call: its name, how long it has been going, the speaker, who is in
// it and the chat.
const { t } = useI18n();
const call = useCall();
const { participants, sheet } = call.state;
const { soundOn, audioBlocked, toggleSound } = call.sound;
const { chatUnread } = call.chat;
const { startedAt } = call.room;
const { openSheet } = call;
const channelName = computed(() => call.props.channelName);

const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const elapsed = computed(() => {
  if (!startedAt.value) return '';
  const seconds = Math.max(0, Math.floor((now.value - startedAt.value) / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(seconds / 3600);
  const clock = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return hours ? `${hours}:${clock}` : clock;
});
onMounted(() => { clockTimer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => clearInterval(clockTimer));
</script>

<template>
  <header class="call-header">
    <Volume2 :size="20" class="call-header-icon" aria-hidden="true" />
    <h2><bdi>{{ channelName }}</bdi></h2>
    <bdi v-if="elapsed" class="call-clock">{{ elapsed }}</bdi>
    <span class="call-header-spacer" />
    <button
      class="call-icon-btn"
      type="button"
      :title="soundOn && !audioBlocked ? t('callSoundOn') : t('callSoundOff')"
      :aria-label="soundOn && !audioBlocked ? t('callSoundOn') : t('callSoundOff')"
      @click="toggleSound"
    >
      <Volume2 v-if="soundOn && !audioBlocked" :size="20" />
      <VolumeX v-else :size="20" />
    </button>
    <button class="call-icon-btn" type="button" :title="t('participants')" :aria-label="t('participantsCount', { count: participants.length })" @click="openSheet('participants')">
      <Users :size="20" /><span class="call-count">{{ participants.length }}</span>
    </button>
    <button class="call-icon-btn" type="button" :aria-pressed="sheet === 'chat'" :title="t('chat')" :aria-label="chatUnread ? t('chatWithCount', { count: chatUnread }) : t('chat')" @click="openSheet('chat')">
      <MessageSquare :size="20" /><span v-if="chatUnread" class="call-chat-badge">{{ chatUnread > 99 ? '99+' : chatUnread }}</span>
    </button>
  </header>
</template>

<style scoped>
.call-header {
  min-height: 48px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(6px, env(safe-area-inset-top)) 12px 6px;
  background: var(--call-bar);
}

.call-header h2 {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.call-header-icon {
  flex: none;
  color: var(--text-secondary);
}

.call-header-spacer {
  flex: 1;
}

.call-clock {
  color: var(--text-secondary);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.call-count {
  font-size: 13px;
  font-weight: 700;
}

/* How many chat messages came in while the chat was closed. */
.call-chat-badge {
  min-width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--on-leave);
  background: var(--leave);
  font-size: 12px;
  font-weight: 800;
}
</style>
