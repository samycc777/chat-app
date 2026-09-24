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
  ArrowDown,
  Copy,
  Hash,
  Menu,
  Users,
  MessageCircle,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  Send,
  Trash2,
  X,
} from 'lucide-vue-next';
import type { Channel, Message, OnlineUser, User } from '../types';
import { api } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import ArabicKeyboard from './ArabicKeyboard.vue';
import Attachment from './Attachment.vue';
import Avatar from './Avatar.vue';

const props = defineProps<{
  channel: Channel;
  currentUser: User;
  onlineUsers: Map<string, OnlineUser>;
  membersOpen: boolean;
}>();

const emit = defineEmits<{ menu: []; members: [] }>();
const { t, lang, dateLocale, translateError } = useI18n();

const messages = ref<Message[]>([]);
const input = ref('');
const replyTo = ref<Message | null>(null);
const editingMsg = ref<Message | null>(null);
const typingUsers = ref(new Map<string, string>());
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
const arabicKeyboard = ref(localStorage.getItem('arabic-keyboard') === '1');
watch(arabicKeyboard, (open) => localStorage.setItem('arabic-keyboard', open ? '1' : '0'));

// Mostly-Arabic messages are set larger, with room between lines for vowel marks; a Latin message
// quoting a few Arabic words keeps its size and only gets the taller lines.
const ARABIC_LETTERS = /\p{Script=Arabic}/gu;
const LATIN_LETTERS = /\p{Script=Latin}/gu;
function scriptClass(text: string | null | undefined) {
  const arabic = text?.match(ARABIC_LETTERS)?.length ?? 0;
  if (!arabic) return '';
  return arabic >= (text?.match(LATIN_LETTERS)?.length ?? 0) ? 'arabic' : 'mixed';
}

let typingTimer: ReturnType<typeof setTimeout> | undefined;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let lastTypingSent = 0;
const typingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
let atBottom = true;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressStart: { x: number; y: number } | null = null;
const hasEarlier = ref(false);
const loadingEarlier = ref(false);
const newBelow = ref(0);
// The server sends history in pages of this many messages.
const PAGE_SIZE = 50;

const typingNames = computed(() => [...typingUsers.value.values()].filter(Boolean));

function scrollBottom() {
  if (!atBottom) return;
  nextTick(() =>
    container.value?.lastElementChild?.scrollIntoView({ behavior: 'smooth' }),
  );
}

async function loadMessages(id: string) {
  loadingMessages.value = true;
  loadError.value = '';
  messages.value = [];
  try {
    messages.value = await api.getMessages(id);
    hasEarlier.value = messages.value.length >= PAGE_SIZE;
    await nextTick();
    container.value?.lastElementChild?.scrollIntoView();
  } catch {
    loadError.value = t('messagesLoadFailed');
  } finally {
    loadingMessages.value = false;
  }
}

// Messages sent while this device was offline are fetched once it reconnects.
async function catchUp() {
  if (loadingMessages.value) return;
  if (loadError.value) { void loadMessages(props.channel.id); return; }
  try {
    const latest: Message[] = await api.getMessages(props.channel.id);
    const merged = new Map(messages.value.map((message) => [message.id, message]));
    for (const message of latest) merged.set(message.id, message);
    messages.value = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0));
    scrollBottom();
  } catch {
    // The next reconnection tries again.
  }
}

// Older history is loaded a page at a time, keeping the messages on screen where they were.
async function loadEarlier() {
  const oldest = messages.value[0];
  const element = container.value;
  if (!oldest || !element || loadingEarlier.value) return;
  loadingEarlier.value = true;
  const distanceFromBottom = element.scrollHeight - element.scrollTop;
  try {
    const earlier: Message[] = await api.getMessages(props.channel.id, oldest);
    hasEarlier.value = earlier.length >= PAGE_SIZE;
    const known = new Set(messages.value.map((message) => message.id));
    messages.value = [...earlier.filter((message) => !known.has(message.id)), ...messages.value];
    await nextTick();
    element.style.scrollBehavior = 'auto';
    element.scrollTop = element.scrollHeight - distanceFromBottom;
    element.style.scrollBehavior = '';
  } catch {
    setFeedback({ kind: 'error', message: t('messagesLoadFailed') }, 4000);
  } finally {
    loadingEarlier.value = false;
  }
}

function jumpToLatest() {
  atBottom = true;
  newBelow.value = 0;
  container.value?.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
}

// An image that finishes loading makes the list taller; stay pinned to the latest message.
function keepAtBottom() {
  if (!atBottom || !container.value) return;
  container.value.style.scrollBehavior = 'auto';
  container.value.scrollTop = container.value.scrollHeight;
  container.value.style.scrollBehavior = '';
}

function onNewMessage(message: Message) {
  if (message.conversationId !== props.channel.id) return;
  if (messages.value.some((existing) => existing.id === message.id)) return;
  messages.value.push(message);
  if (!atBottom && message.senderId !== props.currentUser.id) newBelow.value++;
  scrollBottom();
}

// Turns web addresses in a message into links; trailing punctuation stays outside the link.
const LINK = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi;
function linkParts(text: string) {
  const parts: { text: string; href?: string }[] = [];
  let position = 0;
  for (const match of text.matchAll(LINK)) {
    const link = match[0].replace(/[.,:;!?\u060c\u061b\u061f)\]}'"]+$/u, '');
    const start = match.index ?? 0;
    if (start > position) parts.push({ text: text.slice(position, start) });
    parts.push({ text: link, href: link.toLowerCase().startsWith('www.') ? `https://${link}` : link });
    position = start + link.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position) });
  return parts;
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

// Typing notices repeat every few seconds while someone types, so one that stops arriving
// (for example because the typist went offline) expires on its own.
function onTyping(data: { conversationId: string; userId: string; displayName?: string }) {
  if (data.conversationId !== props.channel.id || data.userId === props.currentUser.id) return;
  typingUsers.value.set(data.userId, data.displayName || '');
  clearTimeout(typingExpiry.get(data.userId));
  typingExpiry.set(data.userId, setTimeout(() => onStopTyping(data), 6000));
}

function onStopTyping(data: { conversationId: string; userId: string }) {
  if (data.conversationId !== props.channel.id) return;
  clearTimeout(typingExpiry.get(data.userId));
  typingExpiry.delete(data.userId);
  typingUsers.value.delete(data.userId);
}

watch(
  () => props.channel.id,
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
  socket.on('connect', catchUp);
});

onBeforeUnmount(() => {
  const socket = getSocket();
  socket?.off('new_message', onNewMessage);
  socket?.off('message_edited', onEdited);
  socket?.off('message_deleted', onDeleted);
  socket?.off('user_typing', onTyping);
  socket?.off('user_stop_typing', onStopTyping);
  socket?.off('connect', catchUp);
  stopTyping();
  clearTimeout(feedbackTimer);
  typingExpiry.forEach((timer) => clearTimeout(timer));
});

function onScroll() {
  if (!container.value) return;
  atBottom =
    container.value.scrollHeight -
      container.value.scrollTop -
      container.value.clientHeight <
    100;
  if (atBottom) newBelow.value = 0;
}

function autosize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 150)}px`;
}

// While the on-screen keyboard is open the phone's own keyboard stays closed (inputmode none), and
// the message box keeps focus so its caret shows where letters will go.
function toggleKeyboard() {
  arabicKeyboard.value = !arabicKeyboard.value;
  nextTick(() => textarea.value?.focus());
}

function caret() {
  const element = textarea.value;
  const focused = element !== null && document.activeElement === element;
  return {
    start: focused ? element.selectionStart : input.value.length,
    end: focused ? element.selectionEnd : input.value.length,
  };
}

function placeCaret(position: number) {
  nextTick(() => {
    textarea.value?.focus({ preventScroll: true });
    textarea.value?.setSelectionRange(position, position);
    autosize();
  });
}

function insertText(text: string) {
  const { start, end } = caret();
  updateInput(input.value.slice(0, start) + text + input.value.slice(end));
  placeCaret(start + text.length);
}

// Removes one character, so a vowel mark can be taken off without deleting its letter.
function deleteBackward() {
  let { start, end } = caret();
  if (start === end) {
    const previous = Array.from(input.value.slice(0, start)).pop();
    if (!previous) return;
    start -= previous.length;
  }
  updateInput(input.value.slice(0, start) + input.value.slice(end));
  placeCaret(start);
}

function stopTyping() {
  clearTimeout(typingTimer);
  if (!lastTypingSent) return;
  lastTypingSent = 0;
  getSocket()?.emit('stop_typing', { conversationId: props.channel.id });
}

// Classmates hear about typing at most every two seconds, which keeps fast typists far inside
// the server's event limit.
function updateInput(value: string) {
  input.value = value;
  const socket = getSocket();
  if (!socket) return;
  if (!value.trim()) { stopTyping(); return; }
  if (Date.now() - lastTypingSent > 2000) {
    lastTypingSent = Date.now();
    socket.emit('typing', { conversationId: props.channel.id });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 3000);
}

function send() {
  const content = input.value.trim();
  const socket = getSocket();
  if (!content || !socket) return;
  stopTyping();

  if (editingMsg.value) {
    socket.emit('edit_message', { messageId: editingMsg.value.id, content });
    editingMsg.value = null;
    input.value = '';
    nextTick(autosize);
    return;
  }

  socket.emit('send_message', {
    conversationId: props.channel.id,
    content,
    type: 'text',
    replyTo: replyTo.value?.id || null,
  }, (response?: { error?: string }) => {
    if (!response?.error) return;
    // Give the text back so a refused message does not have to be typed again.
    if (!input.value) input.value = content;
    setFeedback({ kind: 'error', message: translateError(response.error) });
  });
  input.value = '';
  replyTo.value = null;
  atBottom = true;
  nextTick(autosize);
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
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
    const result = await api.uploadFile(file, props.channel.id, (progress) => {
      feedback.value = { kind: 'uploading', message: t('uploading'), progress };
    });
    getSocket()?.emit(
      'send_message',
      {
        conversationId: props.channel.id,
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
  nextTick(autosize);
}

function deleteMessage(message: Message) {
  getSocket()?.emit('delete_message', { messageId: message.id });
  contextMenu.value = null;
}

function cancelComposition() {
  replyTo.value = null;
  editingMsg.value = null;
  input.value = '';
  nextTick(autosize);
}

function canEdit(message: Message) {
  return !message.deleted && message.type === 'text' && message.senderId === props.currentUser.id;
}

// Nobody moderates the server, so everyone can remove only their own messages.
function canDelete(message: Message) {
  return !message.deleted && message.senderId === props.currentUser.id;
}

function canCopy(message: Message) {
  return !message.deleted && message.type === 'text' && Boolean(message.content);
}

function openMenu(x: number, y: number, message: Message) {
  if (message.deleted) return;
  const width = 200;
  const height = 14 + 42 * (1 + Number(canCopy(message)) + Number(canEdit(message)) + Number(canDelete(message)));
  contextMenu.value = {
    x: Math.max(12, Math.min(x, window.innerWidth - width - 12)),
    y: Math.max(12, Math.min(y, window.innerHeight - height - 12)),
    message,
  };
}

function openContext(event: MouseEvent, message: Message) {
  event.preventDefault();
  openMenu(event.clientX, event.clientY, message);
}

// iPhones never send a right-click, so a long press opens the same menu on touch screens.
function pressStartOn(event: PointerEvent, message: Message) {
  if (event.pointerType !== 'touch') return;
  clearTimeout(pressTimer);
  pressStart = { x: event.clientX, y: event.clientY };
  pressTimer = setTimeout(() => {
    navigator.vibrate?.(12);
    openMenu(event.clientX, event.clientY, message);
  }, 500);
}

function pressMove(event: PointerEvent) {
  if (pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) pressEnd();
}

function pressEnd() {
  clearTimeout(pressTimer);
  pressStart = null;
}

async function copyMessage(message: Message) {
  contextMenu.value = null;
  try {
    await navigator.clipboard.writeText(message.content ?? '');
    setFeedback({ kind: 'success', message: t('copied') }, 2000);
  } catch {
    setFeedback({ kind: 'error', message: t('copyFailed') }, 3000);
  }
}

function dateLabel(timestamp: number) {
  const date = new Date(timestamp);
  return isToday(date)
    ? t('today')
    : isYesterday(date)
      ? t('yesterday')
      : format(date, lang.value === 'ar' ? 'EEEE d MMMM yyyy' : 'EEEE, MMMM d, yyyy', { locale: dateLocale.value });
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

// Like Discord, a group of messages is headed by its time, with the day for anything older than today.
function timeLabel(timestamp: number) {
  const date = new Date(timestamp);
  const time = format(date, 'HH:mm');
  if (isToday(date)) return time;
  return `${isYesterday(date) ? t('yesterday') : format(date, 'P', { locale: dateLocale.value })} ${time}`;
}
</script>

<template>
  <div class="chat-area">
    <header class="channel-header">
      <button class="channel-header-btn menu-btn" type="button" :aria-label="t('channels')" @click="emit('menu')"><Menu :size="20" /></button>
      <Hash :size="22" class="channel-header-hash" aria-hidden="true" />
      <h2><bdi>{{ channel.name }}</bdi></h2>
      <span class="channel-header-spacer" />
      <button class="channel-header-btn" :class="{ active: membersOpen }" type="button" :title="t('members')" :aria-label="t('members')" :aria-pressed="membersOpen" @click="emit('members')"><Users :size="20" /></button>
    </header>

    <div ref="container" class="messages-container" @scroll="onScroll">
      <div v-if="loadingMessages" class="conversation-state" role="status">
        <span class="state-icon loading"><RefreshCw :size="22" /></span>
        <p>{{ t('loadingMessages') }}</p>
      </div>

      <div v-else-if="loadError" class="conversation-state error" role="alert">
        <span class="state-icon"><MessageCircle :size="22" /></span>
        <p>{{ loadError }}</p>
        <button type="button" @click="loadMessages(channel.id)">
          <RefreshCw :size="15" />{{ t('retry') }}
        </button>
      </div>

      <div v-else-if="messages.length === 0" class="conversation-state empty">
        <span class="state-icon"><MessageCircle :size="22" /></span>
        <strong>{{ t('noMessagesYet', { name: channel.name }) }}</strong>
        <p>{{ t('startConversation') }}</p>
      </div>

      <template v-else>
      <div v-if="hasEarlier" class="load-earlier">
        <button type="button" :disabled="loadingEarlier" @click="loadEarlier">
          <RefreshCw v-if="loadingEarlier" class="spin" :size="14" />{{ t('earlierMessages') }}
        </button>
      </div>

      <template v-for="(message, index) in messages" :key="message.id">
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
          :class="{ 'starts-group': beginsGroup(index) }"
          @contextmenu="openContext($event, message)"
          @pointerdown="pressStartOn($event, message)"
          @pointermove="pressMove"
          @pointerup="pressEnd"
          @pointercancel="pressEnd"
        >
          <div class="message-avatar-slot">
            <Avatar
              v-if="beginsGroup(index)"
              :name="message.sender.displayName"
              :color="message.sender.avatarColor"
              :online="onlineUsers.has(message.senderId)"
            />
            <span v-else class="message-side-time"><bdi>{{ format(new Date(message.createdAt), 'HH:mm') }}</bdi></span>
          </div>

          <div class="message-body">
            <div v-if="beginsGroup(index)" class="message-sender">
              <bdi class="message-sender-name" :style="{ color: message.sender.avatarColor }">{{ message.sender.displayName }}</bdi>
              <span class="message-time"><bdi>{{ timeLabel(message.createdAt) }}</bdi></span>
            </div>

            <div v-if="message.replyTo" class="message-reply">
              <div class="reply-sender">
                <bdi>{{ message.replyTo.senderDisplayName }}</bdi>
              </div>
              <div class="reply-text" :class="[scriptClass(message.replyTo.content), { deleted: message.replyTo.deleted }]" dir="auto">
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
              @loaded="keepAtBottom"
            />
            <Attachment
              v-else-if="message.type === 'file' && message.attachmentId"
              :attachment-id="message.attachmentId"
              :name="message.fileName || t('file')"
            />
            <div v-else class="message-content" :class="scriptClass(message.content)" dir="auto"><template v-for="(part, partIndex) in linkParts(message.content ?? '')" :key="partIndex"><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer" dir="ltr">{{ part.text }}</a><template v-else>{{ part.text }}</template></template></div>

            <span v-if="message.editedAt" class="message-edited">({{ t('edited') }})</span>

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
      </template>
      <div v-if="messages.length" class="messages-end" />
    </div>

    <div class="chat-bottom">
      <button v-if="newBelow" class="new-messages-pill" type="button" @click="jumpToLatest">
        <ArrowDown :size="15" />{{ t('newMessages') }}
      </button>
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
        <button
          class="icon-btn keyboard-btn"
          :class="{ active: arabicKeyboard }"
          type="button"
          :title="t('arabicKeyboard')"
          :aria-label="t('arabicKeyboard')"
          :aria-pressed="arabicKeyboard"
          @click="toggleKeyboard"
        >
          <span aria-hidden="true">ع</span>
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
            :placeholder="t('typeAMessage', { name: channel.name })"
            :aria-label="t('typeAMessage', { name: channel.name })"
            rows="1"
            maxlength="8000"
            dir="auto"
            :inputmode="arabicKeyboard ? 'none' : undefined"
            @input="updateInput(($event.target as HTMLTextAreaElement).value); autosize()"
            @keydown="keydown"
          />
        </div>
        <button
          class="send-btn"
          type="button"
          :title="t('sendMessage')"
          :aria-label="t('sendMessage')"
          :disabled="!input.trim()"
          @click="send"
        >
          <Send :size="20" />
        </button>
      </div>
      <ArabicKeyboard v-if="arabicKeyboard" @insert="insertText" @backspace="deleteBackward" />
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
        <button v-if="canCopy(contextMenu.message)" type="button" @click="copyMessage(contextMenu.message)">
          <Copy :size="16" />{{ t('copy') }}
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

<style scoped>
/* Chat */
.chat-area {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-chat);
}

.channel-header {
  min-height: 48px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(6px, env(safe-area-inset-top)) 12px 6px 16px;
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
}

.channel-header h2 {
  min-width: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-header-hash {
  flex: none;
  color: var(--text-secondary);
}

.channel-header-spacer {
  flex: 1;
}

.channel-header-btn {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-secondary);
}

.channel-header-btn:hover,
.channel-header-btn.active {
  color: var(--text-primary);
}

.channel-header-btn.active {
  background: var(--bg-hover);
}

.menu-btn {
  display: none;
}







.messages-container {
  width: 100%;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 16px 0 24px;
  overscroll-behavior: contain;
  scroll-behavior: smooth;
}

.conversation-state {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--text-secondary);
  text-align: center;
}

.conversation-state strong {
  color: var(--text-primary);
  font-size: 16px;
}

.conversation-state p {
  max-width: 320px;
  font-size: 13px;
}

.state-icon {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  margin-bottom: 2px;
  border-radius: 15px;
  color: var(--text-accent);
  background: var(--accent-soft);
}

.conversation-state.error .state-icon {
  color: var(--danger);
  background: var(--danger-soft);
}

.date-separator {
  display: flex;
  justify-content: center;
  padding: 13px 0 17px;
}

.message-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 2px 48px 2px 16px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.message-row:hover {
  background: var(--bg-message-hover);
}

.message-row.starts-group {
  margin-top: 16px;
  padding-top: 4px;
}

.message-avatar-slot {
  width: 40px;
  min-width: 40px;
  display: flex;
  justify-content: center;
}

.message-avatar-slot .avatar {
  width: 40px;
  height: 40px;
  flex-basis: 40px;
}

/* Later messages of a group show their time beside them only while hovered, as Discord does. */
.message-side-time {
  padding-top: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  opacity: 0;
}

.message-row:hover .message-side-time {
  opacity: 1;
}

.message-body {
  min-width: 0;
  flex: 1;
}

.message-sender {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.message-sender-name {
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-time {
  flex: none;
  color: var(--text-secondary);
  font-size: 12px;
}

.message-reply {
  margin-bottom: 6px;
  padding: 6px 8px;
  overflow: hidden;
  border-inline-start: 3px solid var(--text-accent);
  border-radius: 7px;
  background: var(--reply-overlay);
}

.reply-sender {
  color: var(--text-accent);
  font-size: 11px;
  font-weight: 700;
}

.reply-text {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reply-text.deleted {
  font-style: italic;
}

.message-content.mixed {
  line-height: 1.8;
}

.reply-text.arabic {
  font-size: 14px;
}

.deleted-message {
  color: var(--text-secondary);
  font-size: 13px;
  font-style: italic;
}


.message-edited {
  color: var(--text-secondary);
  font-size: 11px;
}

.load-earlier {
  display: flex;
  justify-content: center;
  padding: 4px 0 10px;
}

@media (pointer: coarse) {
  .message-row {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
}

.message-actions {
  position: absolute;
  z-index: 2;
  inset-block-start: -14px;
  inset-inline-end: 16px;
  display: none;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 9px;
  background: var(--bg-primary);
  box-shadow: 0 5px 14px var(--shadow-color);
}

.message-row:hover .message-actions,
.message-row:focus-within .message-actions {
  display: flex;
}

.messages-end {
  height: 1px;
}

/* Composer and feedback */
.chat-bottom {
  position: relative;
  flex: 0 0 auto;
  border-top: 1px solid var(--border-color);
  background: var(--bg-primary);
}

.typing-indicator,
.chat-feedback,
.reply-preview,
.chat-input-area {
  width: 100%;
  max-width: 800px;
  margin-inline: auto;
}

.new-messages-pill {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  z-index: 3;
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border-radius: 999px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  box-shadow: 0 8px 22px var(--shadow-color);
  font-size: 12px;
  font-weight: 700;
  transform: translateX(-50%);
}

.typing-indicator {
  padding: 6px 18px 0;
  color: var(--text-accent);
  font-size: 11px;
}

.chat-feedback {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.chat-feedback.success {
  color: var(--text-accent);
}

.chat-feedback.error {
  color: var(--danger);
}

.feedback-copy {
  min-width: 0;
  flex: 1;
}

.upload-progress {
  width: 100%;
  height: 3px;
  margin-top: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-tertiary);
}

.reply-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px 0;
}

.reply-preview-content {
  min-width: 0;
  flex: 1;
  padding: 3px 10px;
  border-inline-start: 3px solid var(--text-accent);
}

.reply-preview-sender {
  color: var(--text-accent);
  font-size: 12px;
  font-weight: 700;
}

.reply-preview-text {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: var(--text-secondary);
  transition: color 160ms ease, background 160ms ease, transform 160ms ease;
}

.icon-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.chat-input-area {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 14px max(10px, env(safe-area-inset-bottom));
}

.attach-btn {
  color: var(--text-accent);
  background: var(--bg-secondary);
}

.message-input-wrap {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: flex-end;
  padding: 3px 13px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.message-input-wrap:focus-within {
  border-color: color-mix(in srgb, var(--text-accent) 70%, var(--border-color));
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.message-input-wrap textarea {
  width: 100%;
  min-height: 38px;
  max-height: 150px;
  padding: 8px 0;
  resize: none;
  color: var(--text-primary);
  background: transparent;
  /* Never below 16px, which stops iPhones from zooming into the box. */
  font-size: max(16px, var(--message-text-size, 16px));
  line-height: 1.75;
}

/* The surrounding box already shows focus. */
.message-input-wrap textarea:focus-visible {
  outline: none;
}

.message-input-wrap textarea::placeholder {
  color: var(--text-secondary);
  opacity: 0.82;
}

.keyboard-btn {
  color: var(--text-accent);
  background: var(--bg-secondary);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}

.keyboard-btn.active {
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.keyboard-btn.active:hover {
  color: var(--text-on-accent);
  background: var(--accent-strong);
}

/* On-screen Arabic keyboard, for anyone without one on their device. */
.chat-bottom:has(.arabic-keyboard) .chat-input-area {
  padding-bottom: 8px;
}

.send-btn {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  transition: transform 160ms ease, background 160ms ease, opacity 160ms ease;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-strong);
  transform: translateY(-1px);
}

.send-btn:disabled {
  opacity: 0.38;
}

/* Message context menu */
.context-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99;
}

.context-menu {
  min-width: 190px;
  position: fixed;
  z-index: 100;
  overflow: hidden;
  padding: 5px;
  border: 1px solid var(--border-color);
  border-radius: 13px;
  background: var(--bg-primary);
  box-shadow: 0 16px 42px var(--shadow-color);
}

.context-menu button.danger {
  color: var(--danger);
}

@media (max-width: 768px) {



  .menu-btn {
    display: grid;
  }

  .channel-header {
    padding-inline-start: 6px;
  }

  .messages-container {
    padding: 10px 0 20px;
  }

  .message-row {
    gap: 10px;
    padding-inline: 10px;
  }

  .message-avatar-slot,
  .message-avatar-slot .avatar {
    width: 36px;
    min-width: 36px;
    height: 36px;
  }

  .message-actions {
    display: none !important;
  }

  .chat-input-area {
    gap: 7px;
    padding: 8px 9px max(9px, env(safe-area-inset-bottom));
  }

  .typing-indicator,
  .chat-feedback,
  .reply-preview {
    padding-inline: 11px;
  }

  .icon-btn,
  .attach-btn {
    width: 42px;
    height: 42px;
    flex-basis: 42px;
  }

  .send-btn {
    width: 43px;
    height: 43px;
    flex-basis: 43px;
  }

  .message-input-wrap textarea {
    min-height: 36px;
    padding-block: 7px;
  }

  .context-menu {
    width: 100%;
    min-width: 0;
    top: auto !important;
    right: 0;
    bottom: 0;
    left: 0 !important;
    padding: 12px 14px max(16px, env(safe-area-inset-bottom));
    border-radius: 22px 22px 0 0;
    box-shadow: 0 -14px 44px var(--shadow-color);
  }

  .context-menu::before {
    content: '';
    display: block;
    width: 38px;
    height: 4px;
    margin: 0 auto 8px;
    border-radius: 999px;
    background: var(--text-secondary);
    opacity: 0.42;
  }
}

@media (max-width: 360px) {
  .chat-input-area {
    gap: 5px;
    padding-inline: 7px;
  }

  .attach-btn {
    width: 39px;
    flex-basis: 39px;
  }

  .send-btn {
    width: 41px;
    flex-basis: 41px;
  }
}

</style>
