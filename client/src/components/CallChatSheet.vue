<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import { SendHorizontal } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { callChat } from '../callChat';
import { useCall } from '../call/context';
import CallSheet from './CallSheet.vue';

// The call's chat: messages above, and who they go to and what they say below (see call/chat.ts).
const { t } = useI18n();
const call = useCall();
const userId = call.props.userId;
const { chatTo, chatDraft, chatSending, chatPeople, sendChat } = call.chat;
const chatList = ref<HTMLElement>();
const chatTime = (sentAt: number) => new Date(sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The newest message is at the bottom, so that is where the chat opens and stays.
function scrollChatToEnd() {
  void nextTick(() => { if (chatList.value) chatList.value.scrollTop = chatList.value.scrollHeight; });
}
onMounted(scrollChatToEnd);
watch(() => callChat.value.length, scrollChatToEnd);
</script>

<template>
  <CallSheet side class="call-chat" :label="t('chat')" :title="t('chat')">
    <ol ref="chatList" class="call-chat-list" role="log" aria-live="polite" aria-relevant="additions">
      <li v-if="!callChat.length" class="call-chat-empty">{{ t('chatEmpty') }}</li>
      <li v-for="message in callChat" :key="message.id" class="call-chat-message" :class="{ private: message.to, mine: message.from.id === userId }">
        <div class="call-chat-meta">
          <bdi class="call-chat-name">{{ message.from.id === userId ? t('youLabel') : message.from.displayName }}</bdi>
          <span>{{ chatTime(message.sentAt) }}</span>
        </div>
        <button
          v-if="message.to"
          class="call-chat-private"
          type="button"
          @click="chatTo = message.from.id === userId ? message.to.id : message.from.id"
        >
          <bdi>{{ message.from.id === userId ? t('chatPrivateTo', { name: message.to.displayName }) : t('chatPrivateFrom', { name: message.from.displayName }) }}</bdi>
        </button>
        <p dir="auto">{{ message.text }}</p>
      </li>
    </ol>
    <form class="call-chat-form" @submit.prevent="sendChat">
      <label class="call-chat-to">
        <span>{{ t('chatTo') }}</span>
        <select v-model="chatTo" :class="{ private: chatTo }">
          <option :value="null">{{ t('chatEveryone') }}</option>
          <option v-for="person in chatPeople" :key="person.identity" :value="person.identity">{{ person.name }}</option>
        </select>
      </label>
      <div class="call-chat-compose">
        <input v-model="chatDraft" type="text" dir="auto" maxlength="2000" :placeholder="t('chatPlaceholder')" :aria-label="t('chatPlaceholder')" enterkeyhint="send">
        <button class="call-chat-send" type="submit" :disabled="!chatDraft.trim() || chatSending" :title="t('sendMessage')" :aria-label="t('sendMessage')">
          <SendHorizontal :size="20" />
        </button>
      </div>
    </form>
  </CallSheet>
</template>

<style scoped>
.call-sheet.call-chat {
  overflow: hidden;
}

.call-chat-list {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 12px 0;
  list-style: none;
}

.call-chat-empty {
  margin: auto 0;
  color: var(--call-text-muted);
  font-size: 14px;
  line-height: 1.55;
  text-align: center;
}

.call-chat-message {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.call-chat-message.private {
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--accent-soft);
}

.call-chat-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}

.call-chat-name {
  color: var(--call-text);
  font-size: 14px;
  font-weight: 700;
}

.call-chat-message.mine .call-chat-name {
  color: var(--text-secondary);
}

.call-chat-private {
  align-self: flex-start;
  color: var(--call-link);
  font-size: 12px;
  font-weight: 700;
}

.call-chat-message p {
  color: var(--call-text-soft);
  font-size: 15px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.call-chat-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--call-line);
}

.call-chat-to {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--call-text-muted);
  font-size: 13px;
  font-weight: 700;
}

.call-chat-to select {
  min-width: 0;
  flex: 1;
  height: 34px;
  padding: 0 8px;
  border: 1px solid var(--call-line-strong);
  border-radius: 2px;
  color: var(--call-text);
  background: var(--call-input);
  font-size: 14px;
}

.call-chat-to select.private {
  border-color: var(--text-accent);
}

.call-chat-compose {
  display: flex;
  gap: 8px;
}

.call-chat-compose input {
  min-width: 0;
  flex: 1;
  height: 44px;
  padding: 0 12px;
  border: 1px solid var(--call-line-strong);
  border-radius: 4px;
  color: var(--call-text);
  background: var(--call-input);
  /* 16px keeps iPhones from zooming in on the box. */
  font-size: 16px;
}

.call-chat-send {
  width: 44px;
  height: 44px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.call-chat-send:disabled {
  opacity: 0.45;
}

[dir='rtl'] .call-chat-send svg {
  transform: scaleX(-1);
}
</style>
