<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { format, isSameDay, isToday, isYesterday } from 'date-fns';
import {
  MessageCircle,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  Send,
  Trash2,
  X,
} from 'lucide-vue-next';
import type { Conversation, Message, User } from '../types';
import { api } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import Attachment from './Attachment.vue';
import Avatar from './Avatar.vue';

const props = defineProps<{
  conversation: Conversation;
  currentUser: User;
  onlineUsers: Set<string>;
  isTeacher?: boolean;
  lessonActive?: boolean;
}>();

const emit = defineEmits<{ whiteboard: [] }>();
const { t, dateLocale, translateError } = useI18n();

const messages = ref<Message[]>([]);
const input = ref('');
const replyTo = ref<Message | null>(null);
const editingMsg = ref<Message | null>(null);
const typingUsers = ref(new Set<string>());
const loadingMessages = ref(true);
const loadError = ref('');
const feedback = ref<{
  kind: 'uploading' | 'success' | 'error';
  message: string;
  progress?: number;
} | null>(null);

const container = ref<HTMLElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const contextMenu = ref<{ x: number; y: number; message: Message } | null>(null);

let typingTimer: ReturnType<typeof setTimeout> | undefined;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let atBottom = true;

const typingNames = computed(() =>
  [...typingUsers.value]
    .map(
      (id) =>
        props.conversation.members.find((member) => member.id === id)
          ?.displayName,
    )
    .filter((name): name is string => Boolean(name)),
);

function scrollBottom() {
  if (!atBottom) return;
  nextTick(() =>
    container.value?.lastElementChild?.scrollIntoView({ behavior: 'smooth' }),
  );
}

function markRead() {
  getSocket()?.emit('mark_read', { conversationId: props.conversation.id });
}

async function loadMessages(id: string) {
  loadingMessages.value = true;
  loadError.value = '';
  messages.value = [];
  try {
    messages.value = await api.getMessages(id);
    await nextTick();
    container.value?.lastElementChild?.scrollIntoView();
    markRead();
  } catch {
    loadError.value = t('messagesLoadFailed');
  } finally {
    loadingMessages.value = false;
  }
}

function onNewMessage(message: Message) {
  if (message.conversationId !== props.conversation.id) return;
  messages.value.push(message);
  scrollBottom();
  markRead();
}

function onEdited(data: { messageId: string; content: string; editedAt: number }) {
  messages.value = messages.value.map((message) =>
    message.id === data.messageId
      ? { ...message, content: data.content, editedAt: data.editedAt }
      : message,
  );
}

function onDeleted(data: { messageId: string }) {
  messages.value = messages.value.map((message) =>
    message.id === data.messageId
      ? { ...message, deleted: true, content: null }
      : message,
  );
}

function onTyping(data: { conversationId: string; userId: string }) {
  if (
    data.conversationId === props.conversation.id &&
    data.userId !== props.currentUser.id
  ) {
    typingUsers.value.add(data.userId);
  }
}

function onStopTyping(data: { conversationId: string; userId: string }) {
  if (data.conversationId === props.conversation.id) {
    typingUsers.value.delete(data.userId);
  }
}

watch(
  () => props.conversation.id,
  (id) => void loadMessages(id),
  { immediate: true },
);

onMounted(() => {
  const socket = getSocket();
  if (!socket) return;
  socket.on('new_message', onNewMessage);
  socket.on('message_edited', onEdited);
  socket.on('message_deleted', onDeleted);
  socket.on('user_typing', onTyping);
  socket.on('user_stop_typing', onStopTyping);
});

onBeforeUnmount(() => {
  const socket = getSocket();
  socket?.off('new_message', onNewMessage);
  socket?.off('message_edited', onEdited);
  socket?.off('message_deleted', onDeleted);
  socket?.off('user_typing', onTyping);
  socket?.off('user_stop_typing', onStopTyping);
  clearTimeout(typingTimer);
  clearTimeout(feedbackTimer);
});

function onScroll() {
  if (!container.value) return;
  atBottom =
    container.value.scrollHeight -
      container.value.scrollTop -
      container.value.clientHeight <
    100;
}

function updateInput(value: string) {
  input.value = value;
  const socket = getSocket();
  socket?.emit('typing', { conversationId: props.conversation.id });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(
    () => socket?.emit('stop_typing', { conversationId: props.conversation.id }),
    2000,
  );
}

function send() {
  const content = input.value.trim();
  const socket = getSocket();
  if ((!content && !editingMsg.value) || !socket) return;

  if (editingMsg.value) {
    socket.emit('edit_message', { messageId: editingMsg.value.id, content });
    editingMsg.value = null;
    input.value = '';
    return;
  }

  socket.emit('send_message', {
    conversationId: props.conversation.id,
    content,
    type: 'text',
    replyTo: replyTo.value?.id || null,
  });
  socket.emit('stop_typing', { conversationId: props.conversation.id });
  input.value = '';
  replyTo.value = null;
  atBottom = true;
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
  if (event.key === 'Escape') cancelComposition();
}

function setFeedback(
  value: typeof feedback.value,
  clearAfterMs?: number,
) {
  clearTimeout(feedbackTimer);
  feedback.value = value;
  if (clearAfterMs) {
    feedbackTimer = setTimeout(() => {
      feedback.value = null;
    }, clearAfterMs);
  }
}

async function upload(event: Event) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (!file) return;

  setFeedback({ kind: 'uploading', message: t('uploading'), progress: 0 });
  try {
    const result = await api.uploadFile(file, props.conversation.id, (progress) => {
      feedback.value = { kind: 'uploading', message: t('uploading'), progress };
    });
    getSocket()?.emit(
      'send_message',
      {
        conversationId: props.conversation.id,
        content: result.type === 'image' ? '' : result.name,
        type: result.type,
        attachmentId: result.attachmentId,
        fileName: result.name,
      },
      (response: { error?: string }) => {
        if (response?.error) {
          setFeedback({ kind: 'error', message: response.error });
        }
      },
    );
    atBottom = true;
    setFeedback(
      { kind: 'success', message: t('fileShared', { name: result.name }), progress: 100 },
      3000,
    );
  } catch (cause) {
    const message = cause instanceof Error ? translateError(cause.message) : t('uploadFailed');
    setFeedback({ kind: 'error', message });
  } finally {
    element.value = '';
  }
}

function startReply(message: Message) {
  replyTo.value = message;
  editingMsg.value = null;
  contextMenu.value = null;
  textarea.value?.focus();
}

function startEdit(message: Message) {
  editingMsg.value = message;
  input.value = message.content || '';
  replyTo.value = null;
  contextMenu.value = null;
  textarea.value?.focus();
}

function deleteMessage(message: Message) {
  getSocket()?.emit('delete_message', { messageId: message.id });
  contextMenu.value = null;
}

function cancelComposition() {
  replyTo.value = null;
  editingMsg.value = null;
  input.value = '';
}

function canEdit(message: Message) {
  return !message.deleted && message.type === 'text' && message.senderId === props.currentUser.id;
}

// The teacher can remove any message; everyone else only their own.
function canDelete(message: Message) {
  return !message.deleted && (message.senderId === props.currentUser.id || Boolean(props.isTeacher));
}

function openContext(event: MouseEvent, message: Message) {
  event.preventDefault();
  if (message.deleted) return;
  const width = 200;
  const height = 14 + 42 * (1 + Number(canEdit(message)) + Number(canDelete(message)));
  contextMenu.value = {
    x: Math.max(12, Math.min(event.clientX, window.innerWidth - width - 12)),
    y: Math.max(12, Math.min(event.clientY, window.innerHeight - height - 12)),
    message,
  };
}

function dateLabel(timestamp: number) {
  const date = new Date(timestamp);
  return isToday(date)
    ? t('today')
    : isYesterday(date)
      ? t('yesterday')
      : format(date, 'EEEE, MMMM d, yyyy', { locale: dateLocale.value });
}

function beginsGroup(index: number) {
  if (index === 0) return true;
  const message = messages.value[index];
  const previous = messages.value[index - 1];
  return (
    previous.senderId !== message.senderId ||
    !isSameDay(new Date(previous.createdAt), new Date(message.createdAt)) ||
    message.createdAt - previous.createdAt > 5 * 60_000
  );
}

function endsGroup(index: number) {
  if (index === messages.value.length - 1) return true;
  const message = messages.value[index];
  const next = messages.value[index + 1];
  return (
    next.senderId !== message.senderId ||
    !isSameDay(new Date(next.createdAt), new Date(message.createdAt)) ||
    next.createdAt - message.createdAt > 5 * 60_000
  );
}
</script>

<template>
  <div class="chat-area">
    <div v-if="lessonActive" class="lesson-banner" role="status">
      <div class="lesson-banner-icon"><span class="live-dot" /></div>
      <div class="lesson-banner-copy">
        <strong>{{ t('liveLesson') }}</strong>
        <span>{{ t('lessonInProgress') }}</span>
      </div>
      <button class="lesson-join-btn" type="button" @click="emit('whiteboard')">
        {{ t('joinLesson') }}
      </button>
    </div>

    <div ref="container" class="messages-container" @scroll="onScroll">
      <div v-if="loadingMessages" class="conversation-state" role="status">
        <span class="state-icon loading"><RefreshCw :size="22" /></span>
        <p>{{ t('loadingMessages') }}</p>
      </div>

      <div v-else-if="loadError" class="conversation-state error" role="alert">
        <span class="state-icon"><MessageCircle :size="22" /></span>
        <p>{{ loadError }}</p>
        <button type="button" @click="loadMessages(conversation.id)">
          <RefreshCw :size="15" />{{ t('retry') }}
        </button>
      </div>

      <div v-else-if="messages.length === 0" class="conversation-state empty">
        <span class="state-icon"><MessageCircle :size="22" /></span>
        <strong>{{ t('noMessagesYet') }}</strong>
        <p>{{ t('startConversation') }}</p>
      </div>

      <template v-else v-for="(message, index) in messages" :key="message.id">
        <div
          v-if="
            index === 0 ||
            !isSameDay(
              new Date(message.createdAt),
              new Date(messages[index - 1].createdAt),
            )
          "
          class="date-separator"
        >
          <span><bdi>{{ dateLabel(message.createdAt) }}</bdi></span>
        </div>

        <div
          class="message-row"
          :class="[
            message.senderId === currentUser.id ? 'out' : 'in',
            { 'starts-group': beginsGroup(index), 'ends-group': endsGroup(index) },
          ]"
        >
          <div v-if="message.senderId !== currentUser.id" class="message-avatar-slot">
            <Avatar
              v-if="endsGroup(index)"
              :name="message.sender.displayName"
              :color="message.sender.avatarColor"
              :online="onlineUsers.has(message.senderId)"
              size="small"
            />
          </div>

          <div
            class="message-bubble"
            :class="message.senderId === currentUser.id ? 'out' : 'in'"
            @contextmenu="openContext($event, message)"
          >
            <div
              v-if="message.senderId !== currentUser.id && beginsGroup(index)"
              class="message-sender"
            >
              <bdi>{{ message.sender.displayName }}</bdi>
              <span v-if="message.sender.role === 'teacher'" class="role-badge">{{ t('teacherBadge') }}</span>
            </div>

            <div v-if="message.replyTo" class="message-reply">
              <div class="reply-sender">
                <bdi>{{ message.replyTo.senderDisplayName }}</bdi>
              </div>
              <div class="reply-text" :class="{ deleted: message.replyTo.deleted }" dir="auto">
                {{
                  message.replyTo.deleted
                    ? t('messageDeleted')
                    : message.replyTo.type === 'image'
                      ? `📷 ${t('photo')}`
                      : message.replyTo.content
                }}
              </div>
            </div>

            <div v-if="message.deleted" class="deleted-message" dir="auto">
              {{ t('messageDeleted') }}
            </div>
            <Attachment
              v-else-if="message.type === 'image' && message.attachmentId"
              :attachment-id="message.attachmentId"
              :name="message.fileName || t('sharedImage')"
              image
            />
            <Attachment
              v-else-if="message.type === 'file' && message.attachmentId"
              :attachment-id="message.attachmentId"
              :name="message.fileName || t('file')"
            />
            <div v-else class="message-content" dir="auto">{{ message.content }}</div>

            <div class="message-meta">
              <span v-if="message.editedAt" class="message-edited">{{ t('edited') }}</span>
              <span class="message-time"><bdi>{{ format(new Date(message.createdAt), 'HH:mm') }}</bdi></span>
            </div>

            <div v-if="!message.deleted" class="message-actions">
              <button
                type="button"
                :title="t('reply')"
                :aria-label="t('reply')"
                @click="startReply(message)"
              >
                <Reply :size="14" />
              </button>
              <button v-if="canEdit(message)" type="button" :title="t('edit')" :aria-label="t('edit')" @click="startEdit(message)">
                <Pencil :size="14" />
              </button>
              <button v-if="canDelete(message)" type="button" :title="t('delete')" :aria-label="t('delete')" @click="deleteMessage(message)">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
      </template>
      <div v-if="messages.length" class="messages-end" />
    </div>

    <div class="chat-bottom">
      <div v-if="typingNames.length" class="typing-indicator" aria-live="polite">
        {{
          typingNames.length === 1
            ? t('isTyping', { names: typingNames.join(', ') })
            : t('areTyping', { names: typingNames.join(', ') })
        }}
      </div>

      <div v-if="feedback" class="chat-feedback" :class="feedback.kind" aria-live="polite">
        <div class="feedback-copy">
          <span>{{ feedback.message }}</span>
          <div v-if="feedback.kind === 'uploading'" class="upload-progress" role="progressbar" :aria-valuenow="feedback.progress || 0" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: `${feedback.progress || 0}%` }" />
          </div>
        </div>
        <button type="button" :aria-label="t('dismiss')" @click="feedback = null"><X :size="17" /></button>
      </div>

      <div v-if="replyTo || editingMsg" class="reply-preview">
        <div class="reply-preview-content">
          <div class="reply-preview-sender">
            <bdi>{{ editingMsg ? t('editingMessage') : replyTo?.sender.displayName }}</bdi>
          </div>
          <div class="reply-preview-text" dir="auto">
            {{ editingMsg ? editingMsg.content : replyTo?.content }}
          </div>
        </div>
        <button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="cancelComposition">
          <X :size="18" />
        </button>
      </div>

      <div class="chat-input-area">
        <button
          class="icon-btn attach-btn"
          type="button"
          :title="t('attachFile')"
          :aria-label="t('attachFile')"
          @click="fileInput?.click()"
        >
          <Paperclip :size="20" />
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
          hidden
          @change="upload"
        />
        <div class="message-input-wrap">
          <textarea
            ref="textarea"
            :value="input"
            :placeholder="t('typeAMessage')"
            :aria-label="t('typeAMessage')"
            rows="1"
            dir="auto"
            @input="
              updateInput(($event.target as HTMLTextAreaElement).value);
              ($event.target as HTMLTextAreaElement).style.height = 'auto';
              ($event.target as HTMLTextAreaElement).style.height =
                Math.min(($event.target as HTMLTextAreaElement).scrollHeight, 150) + 'px';
            "
            @keydown="keydown"
          />
        </div>
        <button
          class="send-btn"
          type="button"
          :title="t('sendMessage')"
          :aria-label="t('sendMessage')"
          :disabled="!input.trim() && !editingMsg"
          @click="send"
        >
          <Send :size="20" />
        </button>
      </div>
    </div>

    <template v-if="contextMenu">
      <div class="context-menu-backdrop" @click="contextMenu = null" />
      <div
        class="context-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
      >
        <button type="button" @click="startReply(contextMenu.message)">
          <Reply :size="16" />{{ t('reply') }}
        </button>
        <button v-if="canEdit(contextMenu.message)" type="button" @click="startEdit(contextMenu.message)">
          <Pencil :size="16" />{{ t('edit') }}
        </button>
        <button v-if="canDelete(contextMenu.message)" class="danger" type="button" @click="deleteMessage(contextMenu.message)">
          <Trash2 :size="16" />{{ t('delete') }}
        </button>
      </div>
    </template>
  </div>
</template>
