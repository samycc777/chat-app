import { computed, ref, watch } from 'vue';
import { useI18n } from '../i18n';
import { onCallChatMessage, sendCallChat } from '../callChat';
import type { CallProps, CallState } from './context';

// The call's chat: to everyone, or privately to one person in the call (chatTo, their user ID).
// The messages themselves are kept in callChat.ts.
export function useCallChat(state: CallState, props: CallProps, showToast: (message: string, duration?: number) => void) {
  const { t } = useI18n();
  const { sheet, participants } = state;
  const chatTo = ref<string | null>(null);
  const chatDraft = ref('');
  const chatSending = ref(false);
  const chatUnread = ref(0);
  const chatPeople = computed(() => participants.value.filter(person => !person.local));
  const stopChatListener = onCallChatMessage(message => {
    if (message.from.id === props.userId || sheet.value === 'chat') return;
    chatUnread.value++;
    const text = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
    showToast(`${message.from.displayName}: ${text}`, 5000);
  });
  watch(sheet, open => { if (open === 'chat') chatUnread.value = 0; });
  // Someone who leaves the call can no longer be written to.
  watch(chatPeople, people => { if (chatTo.value && !people.some(person => person.identity === chatTo.value)) chatTo.value = null; });
  async function sendChat() {
    const text = chatDraft.value.trim();
    if (!text || chatSending.value) return;
    chatSending.value = true;
    const failure = await sendCallChat(text, chatTo.value);
    chatSending.value = false;
    if (failure) { showToast(t('chatSendFailed')); return; }
    chatDraft.value = '';
  }

  return { chatTo, chatDraft, chatSending, chatUnread, chatPeople, sendChat, dispose: stopChatListener };
}
export type CallChat = ReturnType<typeof useCallChat>;
