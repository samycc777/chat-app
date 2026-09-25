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
  Mic,
  Users,
  MessageCircle,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Reply,
  Search,
  Send,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-vue-next';
import type { Channel, Member, Message, OnlineUser, Reaction, User } from '../types';
import { api } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import { decodeMentions, encodeMentions, mentionsUser, messageParts, readableText } from '../mentions';
import ArabicKeyboard from './ArabicKeyboard.vue';
import Attachment from './Attachment.vue';
import Avatar from './Avatar.vue';
import VoiceNote from './VoiceNote.vue';

const props = defineProps<{
  channel: Channel;
  currentUser: User;
  onlineUsers: Map<string, OnlineUser>;
  members: Map<string, Member>;
  membersOpen: boolean;
  searchOpen: boolean;
  /** How far this person had read the channel, for the "new messages" line; null until known. */
  lastReadSeq: number | null;
  unreadElsewhere: boolean;
  /** A message to show, from search or the pinned list. */
  jump: { messageId: string; count: number } | null;
}>();

const emit = defineEmits<{ menu: []; members: []; search: []; 'open-message': [message: Message]; jumped: [] }>();
const { t, lang, dateLocale, translateError } = useI18n();

// The same short set as the server's, none with faces.
const REACTIONS = ['👍', '❤️', '✅', '🤲', '👏', '🌟'];

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
const reactionPicker = ref<{ x: number; y: number; message: Message } | null>(null);
const arabicKeyboard = ref(localStorage.getItem('arabic-keyboard') === '1');
watch(arabicKeyboard, (open) => localStorage.setItem('arabic-keyboard', open ? '1' : '0'));

const nameOf = (userId: string) => props.members.get(userId)?.displayName ?? props.onlineUsers.get(userId)?.displayName;

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
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
let lastTypingSent = 0;
const typingExpiry = new Map<string, ReturnType<typeof setTimeout>>();
let atBottom = true;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressStart: { x: number; y: number } | null = null;
const hasEarlier = ref(false);
const loadingEarlier = ref(false);
// After opening an old message, the newest messages are not loaded until you scroll down to them.
const hasLater = ref(false);
const loadingLater = ref(false);
const newBelow = ref(0);
const highlighted = ref<string | null>(null);
// The server sends history in pages of this many messages.
const PAGE_SIZE = 50;
let loadedChannel = '';
let loadToken = 0;

const typingNames = computed(() => [...typingUsers.value.values()].filter(Boolean));

// Discord's red "new" line sits above the first message that arrived since you last read the channel.
const dividerSeq = ref<number | null>(null);
// The line is placed from how far you had read when the channel opened, which the server may send
// a moment after the channel appears; later reads leave it where it is.
let dividerPending = true;
function placeDivider() {
  if (!dividerPending || props.lastReadSeq === null) return;
  dividerSeq.value = props.lastReadSeq;
  dividerPending = false;
}
const firstUnreadId = computed(() => {
  if (dividerSeq.value === null) return null;
  return messages.value.find((message) => (message.seq ?? 0) > dividerSeq.value! && message.senderId !== props.currentUser.id)?.id ?? null;
});

function scrollBottom() {
  if (!atBottom) return;
  nextTick(() =>
    container.value?.lastElementChild?.scrollIntoView({ behavior: 'smooth' }),
  );
}

function showElement(messageId: string) {
  const element = container.value?.querySelector(`[data-message-id="${messageId}"]`);
  element?.scrollIntoView({ block: 'center' });
  return Boolean(element);
}

// The server remembers how far each person has read, so every device shows the same unread channels.
let markedSeq = 0;
function markRead() {
  if (document.hidden || hasLater.value || loadingMessages.value) return;
  const seq = messages.value.reduce((highest, message) => Math.max(highest, message.seq ?? 0), 0);
  if (!seq || seq <= markedSeq) return;
  markedSeq = seq;
  getSocket()?.emit('mark_read', { channelId: props.channel.id, seq });
}
function onVisible() { if (!document.hidden) markRead(); }

async function loadMessages(id: string) {
  const token = ++loadToken;
  loadingMessages.value = true;
  loadError.value = '';
  messages.value = [];
  hasLater.value = false;
  newBelow.value = 0;
  try {
    const loaded: Message[] = await api.getMessages(id);
    if (token !== loadToken) return;
    messages.value = loaded;
    loadedChannel = id;
    hasEarlier.value = loaded.length >= PAGE_SIZE;
    loadingMessages.value = false;
    await nextTick();
    // Open at the first new message when there is one, as Discord does, or else at the latest.
    if (!firstUnreadId.value || !showElement(firstUnreadId.value)) container.value?.lastElementChild?.scrollIntoView();
    markRead();
  } catch {
    if (token === loadToken) loadError.value = t('messagesLoadFailed');
  } finally {
    if (token === loadToken) loadingMessages.value = false;
  }
}

// Opens the history at one message, for search results and pins, and briefly highlights it.
async function showMessage(messageId: string) {
  emit('jumped');
  if (loadedChannel === props.channel.id && messages.value.some((message) => message.id === messageId)) {
    await nextTick();
    showElement(messageId);
  } else {
    const token = ++loadToken;
    loadingMessages.value = true;
    loadError.value = '';
    try {
      const loaded: Message[] = await api.getMessages(props.channel.id, undefined, { around: messageId });
      if (token !== loadToken) return;
      const index = loaded.findIndex((message) => message.id === messageId);
      messages.value = loaded;
      loadedChannel = props.channel.id;
      hasEarlier.value = index >= PAGE_SIZE / 2;
      hasLater.value = loaded.length - index - 1 >= PAGE_SIZE / 2 - 1;
      loadingMessages.value = false;
      await nextTick();
      showElement(messageId);
      atBottom = false;
      markRead();
    } catch {
      if (token !== loadToken) return;
      loadingMessages.value = false;
      void loadMessages(props.channel.id);
      return;
    }
  }
  highlighted.value = messageId;
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => { highlighted.value = null; }, 2500);
}

// Messages sent while this device was offline are fetched once it reconnects.
async function catchUp() {
  if (loadingMessages.value || hasLater.value) return;
  if (loadError.value) { void loadMessages(props.channel.id); return; }
  try {
    const latest: Message[] = await api.getMessages(props.channel.id);
    const merged = new Map(messages.value.map((message) => [message.id, message]));
    for (const message of latest) merged.set(message.id, message);
    messages.value = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0));
    scrollBottom();
    markRead();
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

async function loadLater() {
  const newest = messages.value[messages.value.length - 1];
  if (!newest || loadingLater.value) return;
  loadingLater.value = true;
  try {
    const later: Message[] = await api.getMessages(props.channel.id, undefined, { after: newest });
    hasLater.value = later.length >= PAGE_SIZE;
    const known = new Set(messages.value.map((message) => message.id));
    messages.value = [...messages.value, ...later.filter((message) => !known.has(message.id))];
    markRead();
  } catch {
    setFeedback({ kind: 'error', message: t('messagesLoadFailed') }, 4000);
  } finally {
    loadingLater.value = false;
  }
}

function jumpToLatest() {
  atBottom = true;
  newBelow.value = 0;
  if (hasLater.value) { void loadMessages(props.channel.id); return; }
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
  // While an older part of the history is open, the new message waits below it.
  if (hasLater.value) { if (message.senderId !== props.currentUser.id) newBelow.value++; return; }
  messages.value.push(message);
  if (!atBottom && message.senderId !== props.currentUser.id) newBelow.value++;
  scrollBottom();
  markRead();
}

function updateMessage(messageId: string, change: Partial<Message>) {
  messages.value = messages.value.map((message) => message.id === messageId ? { ...message, ...change } : message);
}

function onEdited(data: { messageId: string; content: string; editedAt: number }) {
  updateMessage(data.messageId, { content: data.content, editedAt: data.editedAt });
}

function onDeleted(data: { messageId: string }) {
  updateMessage(data.messageId, { deleted: true, content: null, reactions: [], pinnedAt: null });
  pins.value = pins.value.filter((message) => message.id !== data.messageId);
}

function onReactions(data: { messageId: string; reactions: Reaction[] }) {
  updateMessage(data.messageId, { reactions: data.reactions });
}

function onPinned(data: { messageId: string; conversationId: string; pinnedAt: number | null }) {
  updateMessage(data.messageId, { pinnedAt: data.pinnedAt });
  if (pinsOpen.value && data.conversationId === props.channel.id) void loadPins();
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

function onScroll() {
  if (!container.value) return;
  const fromBottom = container.value.scrollHeight - container.value.scrollTop - container.value.clientHeight;
  atBottom = fromBottom < 100 && !hasLater.value;
  if (atBottom) newBelow.value = 0;
  if (hasLater.value && fromBottom < 300) void loadLater();
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
    findMention();
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

// Mentions: typing @ offers the server's members by name, and @everyone.
const chosenMentions = new Map<string, string>();
const mentionQuery = ref<{ start: number; text: string } | null>(null);
const mentionIndex = ref(0);
const mentionOptions = computed(() => {
  const query = mentionQuery.value?.text.toLowerCase();
  if (query === undefined) return [];
  const people = [...props.members.values()]
    .filter((member) => member.id !== props.currentUser.id && member.displayName.toLowerCase().includes(query))
    .sort((a, b) => Number(props.onlineUsers.has(b.id)) - Number(props.onlineUsers.has(a.id)) || a.displayName.localeCompare(b.displayName))
    .slice(0, 6)
    .map((member) => ({ id: member.id, name: member.displayName, color: member.avatarColor }));
  return 'everyone'.startsWith(query) ? [...people, { id: 'everyone', name: 'everyone', color: '' }] : people;
});

function findMention() {
  const element = textarea.value;
  const position = element && document.activeElement === element ? element.selectionStart : input.value.length;
  const match = /(?:^|\s)@([^\s@]{0,30})$/u.exec(input.value.slice(0, position));
  mentionQuery.value = match ? { start: position - match[1].length - 1, text: match[1] } : null;
  mentionIndex.value = 0;
}

function pickMention(option: { id: string; name: string }) {
  const query = mentionQuery.value;
  if (!query) return;
  const { end } = caret();
  const text = `@${option.name} `;
  if (option.id !== 'everyone') chosenMentions.set(option.name, option.id);
  updateInput(input.value.slice(0, query.start) + text + input.value.slice(end));
  mentionQuery.value = null;
  placeCaret(query.start + text.length);
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
  findMention();
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
  const typed = input.value.trim();
  const socket = getSocket();
  if (!typed || !socket) return;
  const content = encodeMentions(typed, chosenMentions);
  stopTyping();
  mentionQuery.value = null;

  if (editingMsg.value) {
    socket.emit('edit_message', { messageId: editingMsg.value.id, content });
    editingMsg.value = null;
    input.value = '';
    chosenMentions.clear();
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
    if (!input.value) input.value = typed;
    setFeedback({ kind: 'error', message: translateError(response.error) });
  });
  input.value = '';
  replyTo.value = null;
  chosenMentions.clear();
  dividerSeq.value = null;
  atBottom = true;
  if (hasLater.value) void loadMessages(props.channel.id);
  nextTick(autosize);
}

function keydown(event: KeyboardEvent) {
  if (mentionOptions.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = mentionOptions.value.length;
      mentionIndex.value = (mentionIndex.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
      event.preventDefault();
      pickMention(mentionOptions.value[mentionIndex.value]);
      return;
    }
    if (event.key === 'Escape') { mentionQuery.value = null; return; }
  }
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

async function shareFile(file: File, durationMs?: number) {
  setFeedback({ kind: 'uploading', message: t('uploading'), progress: 0 });
  try {
    const result = await api.uploadFile(file, props.channel.id, (progress) => {
      feedback.value = { kind: 'uploading', message: t('uploading'), progress };
    }, durationMs);
    getSocket()?.emit(
      'send_message',
      {
        conversationId: props.channel.id,
        content: result.type === 'image' ? '' : result.name,
        type: result.type,
        attachmentId: result.attachmentId,
        fileName: result.name,
        replyTo: replyTo.value?.id || null,
      },
      (response: { error?: string }) => {
        if (response?.error) {
          setFeedback({ kind: 'error', message: translateError(response.error) });
        }
      },
    );
    replyTo.value = null;
    dividerSeq.value = null;
    atBottom = true;
    setFeedback(
      durationMs ? null : { kind: 'success', message: t('fileShared', { name: result.name }), progress: 100 },
      3000,
    );
  } catch (cause) {
    const message = cause instanceof Error ? translateError(cause.message) : t('uploadFailed');
    setFeedback({ kind: 'error', message });
  }
}

async function upload(event: Event) {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (!file) return;
  await shareFile(file);
  element.value = '';
}

// Voice messages: tap the microphone, talk, then send or throw it away. Five minutes at most.
const MAX_VOICE_MS = 5 * 60_000;
const recording = ref<{ elapsed: number } | null>(null);
let recorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStartedAt = 0;
let recordingTimer: ReturnType<typeof setInterval> | undefined;

async function startRecording() {
  if (recording.value) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    setFeedback({ kind: 'error', message: t('voiceUnsupported') }, 5000);
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    setFeedback({ kind: 'error', message: t('microphoneBlocked') }, 5000);
    return;
  }
  // WebM with Opus where the browser has it, and MP4 on iPhones, which have no WebM recorder.
  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
  recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
  recordedChunks = [];
  recorder.addEventListener('dataavailable', (event) => { if (event.data.size) recordedChunks.push(event.data); });
  recorder.start(1000);
  recordingStartedAt = Date.now();
  recording.value = { elapsed: 0 };
  navigator.vibrate?.(12);
  recordingTimer = setInterval(() => {
    if (!recording.value) return;
    recording.value.elapsed = Date.now() - recordingStartedAt;
    if (recording.value.elapsed >= MAX_VOICE_MS) void finishRecording(true);
  }, 250);
}

async function finishRecording(send: boolean) {
  const active = recorder;
  if (!active) return;
  recorder = null;
  clearInterval(recordingTimer);
  const durationMs = Date.now() - recordingStartedAt;
  recording.value = null;
  const stopped = new Promise((resolve) => active.addEventListener('stop', resolve, { once: true }));
  if (active.state !== 'inactive') active.stop();
  await stopped;
  active.stream.getTracks().forEach((track) => track.stop());
  // A tap that ends straight away is a mistake, not a message.
  if (!send || durationMs < 700 || !recordedChunks.length) return;
  const type = (active.mimeType || recordedChunks[0].type || 'audio/webm').split(';')[0];
  const file = new File(recordedChunks, `voice-message.${type === 'audio/mp4' ? 'm4a' : 'webm'}`, { type });
  await shareFile(file, durationMs);
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

function startReply(message: Message) {
  replyTo.value = message;
  editingMsg.value = null;
  contextMenu.value = null;
  textarea.value?.focus();
}

function startEdit(message: Message) {
  editingMsg.value = message;
  const decoded = decodeMentions(message.content || '', nameOf);
  input.value = decoded.text;
  chosenMentions.clear();
  decoded.chosen.forEach((userId, name) => chosenMentions.set(name, userId));
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
  chosenMentions.clear();
  mentionQuery.value = null;
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

const isVoice = (message: Message) => Boolean(message.mimeType?.startsWith('audio/'));
const mentionsMe = (message: Message) => message.senderId !== props.currentUser.id && mentionsUser(message.content, props.currentUser.id);

// Replies carry only a summary of the message they answer, so a voice message is known by its name.
function replyText(reply: NonNullable<Message['replyTo']>) {
  if (reply.deleted) return t('messageDeleted');
  if (reply.type === 'image') return `📷 ${t('photo')}`;
  if (reply.type === 'file' && /^voice-message\.\w+$/.test(reply.content ?? '')) return `🎤 ${t('voiceMessage')}`;
  return readableText(reply.content, nameOf);
}
function previewText(message: Message) {
  if (message.type === 'image') return `📷 ${t('photo')}`;
  if (isVoice(message)) return `🎤 ${t('voiceMessage')}`;
  return readableText(message.content ?? message.fileName, nameOf);
}

// Reactions: anyone can add any of the few emoji, and tapping your own takes it back.
function toggleReaction(message: Message, emoji: string) {
  const mine = message.reactions?.find((reaction) => reaction.emoji === emoji)?.userIds.includes(props.currentUser.id) ?? false;
  getSocket()?.emit('react', { messageId: message.id, emoji, on: !mine });
  contextMenu.value = null;
  reactionPicker.value = null;
}
const reactedByMe = (reaction: Reaction) => reaction.userIds.includes(props.currentUser.id);
const reactionNames = (reaction: Reaction) => reaction.userIds.map((userId) => nameOf(userId) ?? '…').join(', ');

function openReactionPicker(event: MouseEvent, message: Message) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const width = 6 * 40 + 12;
  reactionPicker.value = {
    x: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)),
    y: Math.max(12, bounds.top - 52),
    message,
  };
}

// Pins: anyone can pin a message so it stays easy to find, such as homework or the lesson times.
const pinsOpen = ref(false);
const pins = ref<Message[]>([]);
const loadingPins = ref(false);
async function loadPins() {
  loadingPins.value = true;
  try {
    pins.value = await api.getPins(props.channel.id);
  } catch {
    setFeedback({ kind: 'error', message: t('messagesLoadFailed') }, 4000);
  } finally {
    loadingPins.value = false;
  }
}
function togglePins() {
  pinsOpen.value = !pinsOpen.value;
  if (pinsOpen.value) void loadPins();
}
function togglePin(message: Message) {
  contextMenu.value = null;
  getSocket()?.emit('pin_message', { messageId: message.id, pinned: !message.pinnedAt }, (result?: { error?: string }) => {
    if (result?.error === 'Too many pins') setFeedback({ kind: 'error', message: t('tooManyPins') }, 4000);
    else if (!result?.error && !message.pinnedAt) setFeedback({ kind: 'success', message: t('pinnedNotice') }, 2500);
  });
}
function openPin(message: Message) {
  pinsOpen.value = false;
  emit('open-message', message);
}

function openMenu(x: number, y: number, message: Message) {
  if (message.deleted) return;
  const width = 250;
  const height = 70 + 42 * (2 + Number(canCopy(message)) + Number(canEdit(message)) + Number(canDelete(message)));
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
    await navigator.clipboard.writeText(readableText(message.content, nameOf));
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
    message.id === firstUnreadId.value ||
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

// A jump arrives together with the channel it is in, so both are handled by one watcher.
watch(
  () => [props.channel.id, props.jump?.count] as const,
  ([id], previous) => {
    if (id !== previous?.[0]) {
      dividerSeq.value = null;
      dividerPending = true;
      placeDivider();
      markedSeq = 0;
      pinsOpen.value = false;
      chosenMentions.clear();
      void finishRecording(false);
    }
    if (props.jump) void showMessage(props.jump.messageId);
    else if (id !== previous?.[0]) void loadMessages(id);
  },
  { immediate: true },
);

watch(() => props.lastReadSeq, placeDivider);

onMounted(() => {
  const socket = getSocket();
  document.addEventListener('visibilitychange', onVisible);
  if (!socket) return;
  socket.on('new_message', onNewMessage);
  socket.on('message_edited', onEdited);
  socket.on('message_deleted', onDeleted);
  socket.on('reactions', onReactions);
  socket.on('message_pinned', onPinned);
  socket.on('user_typing', onTyping);
  socket.on('user_stop_typing', onStopTyping);
  socket.on('connect', catchUp);
});

onBeforeUnmount(() => {
  const socket = getSocket();
  document.removeEventListener('visibilitychange', onVisible);
  socket?.off('new_message', onNewMessage);
  socket?.off('message_edited', onEdited);
  socket?.off('message_deleted', onDeleted);
  socket?.off('reactions', onReactions);
  socket?.off('message_pinned', onPinned);
  socket?.off('user_typing', onTyping);
  socket?.off('user_stop_typing', onStopTyping);
  socket?.off('connect', catchUp);
  stopTyping();
  void finishRecording(false);
  clearTimeout(feedbackTimer);
  clearTimeout(highlightTimer);
  typingExpiry.forEach((timer) => clearTimeout(timer));
});
</script>

<template>
  <div class="chat-area">
    <header class="channel-header">
      <button class="channel-header-btn menu-btn" :class="{ 'has-unread': unreadElsewhere }" type="button" :aria-label="t('channels')" @click="emit('menu')"><Menu :size="20" /></button>
      <Hash :size="22" class="channel-header-hash" aria-hidden="true" />
      <h2><bdi>{{ channel.name }}</bdi></h2>
      <span class="channel-header-spacer" />
      <button class="channel-header-btn" :class="{ active: pinsOpen }" type="button" :title="t('pinnedMessages')" :aria-label="t('pinnedMessages')" :aria-expanded="pinsOpen" @click="togglePins"><Pin :size="19" /></button>
      <button class="channel-header-btn" :class="{ active: searchOpen }" type="button" :title="t('search')" :aria-label="t('search')" :aria-pressed="searchOpen" @click="emit('search')"><Search :size="19" /></button>
      <button class="channel-header-btn" :class="{ active: membersOpen }" type="button" :title="t('members')" :aria-label="t('members')" :aria-pressed="membersOpen" @click="emit('members')"><Users :size="20" /></button>
    </header>

    <template v-if="pinsOpen">
      <div class="popover-backdrop" @click="pinsOpen = false" />
      <div class="pins-popover" role="dialog" :aria-label="t('pinnedMessages')">
        <div class="pins-head">
          <strong>{{ t('pinnedMessages') }}</strong>
          <button type="button" :aria-label="t('close')" @click="pinsOpen = false"><X :size="18" /></button>
        </div>
        <p v-if="loadingPins && !pins.length" class="pins-state"><RefreshCw class="spin" :size="16" /></p>
        <p v-else-if="!pins.length" class="pins-state">{{ t('noPins') }}</p>
        <div v-for="pin in pins" :key="pin.id" class="pin-item">
          <button class="pin-open" type="button" @click="openPin(pin)">
            <span class="pin-meta">
              <bdi :style="{ color: pin.sender.avatarColor }">{{ pin.sender.displayName }}</bdi>
              <span>{{ timeLabel(pin.createdAt) }}</span>
            </span>
            <span class="pin-text" :class="scriptClass(pin.content)" dir="auto">{{ previewText(pin) }}</span>
          </button>
          <button class="pin-remove" type="button" :title="t('unpin')" :aria-label="t('unpin')" @click="togglePin(pin)"><PinOff :size="15" /></button>
        </div>
      </div>
    </template>

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

        <div v-if="message.id === firstUnreadId" class="unread-divider" role="separator"><span>{{ t('newLine') }}</span></div>

        <div
          class="message-row"
          :class="{ 'starts-group': beginsGroup(index), 'mentions-me': mentionsMe(message), highlighted: highlighted === message.id }"
          :data-message-id="message.id"
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
                {{ replyText(message.replyTo) }}
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
            <VoiceNote
              v-else-if="message.type === 'file' && message.attachmentId && isVoice(message)"
              :attachment-id="message.attachmentId"
              :duration-ms="message.durationMs"
            />
            <Attachment
              v-else-if="message.type === 'file' && message.attachmentId"
              :attachment-id="message.attachmentId"
              :name="message.fileName || t('file')"
              :mime-type="message.mimeType"
              :duration-ms="message.durationMs"
            />
            <div v-else class="message-content" :class="scriptClass(message.content)" dir="auto"><template v-for="(part, partIndex) in messageParts(message.content ?? '', nameOf)" :key="partIndex"><a v-if="part.href" :href="part.href" target="_blank" rel="noopener noreferrer" dir="ltr">{{ part.text }}</a><bdi v-else-if="part.mention" class="mention" :class="{ me: part.mention === currentUser.id.toLowerCase() || part.mention === 'everyone' }">{{ part.text }}</bdi><template v-else>{{ part.text }}</template></template></div>

            <span v-if="message.editedAt" class="message-edited">({{ t('edited') }})</span>
            <span v-if="message.pinnedAt" class="message-pinned"><Pin :size="11" />{{ t('pinned') }}</span>

            <div v-if="message.reactions?.length" class="reactions">
              <button
                v-for="reaction in message.reactions"
                :key="reaction.emoji"
                class="reaction"
                :class="{ mine: reactedByMe(reaction) }"
                type="button"
                :title="reactionNames(reaction)"
                :aria-label="`${reaction.emoji} ${reaction.userIds.length}: ${reactionNames(reaction)}`"
                :aria-pressed="reactedByMe(reaction)"
                @click="toggleReaction(message, reaction.emoji)"
              >
                <span aria-hidden="true">{{ reaction.emoji }}</span><span class="reaction-count">{{ reaction.userIds.length }}</span>
              </button>
            </div>

            <div v-if="!message.deleted" class="message-actions">
              <button type="button" :title="t('react')" :aria-label="t('react')" @click="openReactionPicker($event, message)">
                <ThumbsUp :size="14" />
              </button>
              <button
                type="button"
                :title="t('reply')"
                :aria-label="t('reply')"
                @click="startReply(message)"
              >
                <Reply :size="14" />
              </button>
              <button type="button" :title="message.pinnedAt ? t('unpin') : t('pin')" :aria-label="message.pinnedAt ? t('unpin') : t('pin')" @click="togglePin(message)">
                <PinOff v-if="message.pinnedAt" :size="14" /><Pin v-else :size="14" />
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
      <div v-if="hasLater" class="load-earlier">
        <button type="button" :disabled="loadingLater" @click="loadLater">
          <RefreshCw v-if="loadingLater" class="spin" :size="14" />{{ t('laterMessages') }}
        </button>
      </div>
      </template>
      <div v-if="messages.length" class="messages-end" />
    </div>

    <div class="chat-bottom">
      <button v-if="newBelow || hasLater" class="new-messages-pill" type="button" @click="jumpToLatest">
        <ArrowDown :size="15" />{{ newBelow ? t('newMessages') : t('backToLatest') }}
      </button>
      <ul v-if="mentionOptions.length" class="mention-picker" role="listbox" :aria-label="t('mentionSomeone')">
        <li v-for="(option, optionIndex) in mentionOptions" :key="option.id">
          <button type="button" role="option" :aria-selected="optionIndex === mentionIndex" :class="{ selected: optionIndex === mentionIndex }" @pointerdown.prevent @click="pickMention(option)">
            <Avatar v-if="option.color" :name="option.name" :color="option.color" size="tiny" />
            <span v-else class="mention-everyone" aria-hidden="true">@</span>
            <bdi>{{ option.id === 'everyone' ? '@everyone' : option.name }}</bdi>
            <small v-if="option.id === 'everyone'">{{ t('mentionEveryoneHint') }}</small>
          </button>
        </li>
      </ul>
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
            {{ editingMsg ? previewText(editingMsg) : replyTo ? previewText(replyTo) : '' }}
          </div>
        </div>
        <button class="icon-btn" type="button" :aria-label="t('dismiss')" @click="cancelComposition">
          <X :size="18" />
        </button>
      </div>

      <div v-if="recording" class="chat-input-area recording-bar">
        <button class="icon-btn" type="button" :title="t('discardVoice')" :aria-label="t('discardVoice')" @click="finishRecording(false)">
          <Trash2 :size="20" />
        </button>
        <div class="recording-status" role="status">
          <span class="recording-dot" aria-hidden="true" />
          <span class="recording-time">{{ clock(recording.elapsed) }}</span>
          <span class="recording-label">{{ t('recordingVoice') }}</span>
        </div>
        <button class="send-btn" type="button" :title="t('sendVoice')" :aria-label="t('sendVoice')" @click="finishRecording(true)">
          <Send :size="20" />
        </button>
      </div>
      <div v-else class="chat-input-area">
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
          accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,audio/*,video/*"
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
            @click="findMention"
            @blur="mentionQuery = null"
          />
        </div>
        <button
          v-if="input.trim() || editingMsg"
          class="send-btn"
          type="button"
          :title="t('sendMessage')"
          :aria-label="t('sendMessage')"
          :disabled="!input.trim()"
          @click="send"
        >
          <Send :size="20" />
        </button>
        <button
          v-else
          class="send-btn"
          type="button"
          :title="t('recordVoice')"
          :aria-label="t('recordVoice')"
          @click="startRecording"
        >
          <Mic :size="20" />
        </button>
      </div>
      <ArabicKeyboard v-if="arabicKeyboard && !recording" @insert="insertText" @backspace="deleteBackward" />
    </div>

    <template v-if="reactionPicker">
      <div class="context-menu-backdrop" @click="reactionPicker = null" />
      <div class="reaction-picker" :style="{ top: `${reactionPicker.y}px`, left: `${reactionPicker.x}px` }" role="menu">
        <button v-for="emoji in REACTIONS" :key="emoji" type="button" role="menuitem" @click="toggleReaction(reactionPicker.message, emoji)">{{ emoji }}</button>
      </div>
    </template>

    <template v-if="contextMenu">
      <div class="context-menu-backdrop" @click="contextMenu = null" />
      <div
        class="context-menu"
        :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
      >
        <div class="context-reactions">
          <button v-for="emoji in REACTIONS" :key="emoji" type="button" :aria-label="`${t('react')} ${emoji}`" @click="toggleReaction(contextMenu.message, emoji)">{{ emoji }}</button>
        </div>
        <button type="button" @click="startReply(contextMenu.message)">
          <Reply :size="16" />{{ t('reply') }}
        </button>
        <button type="button" @click="togglePin(contextMenu.message)">
          <template v-if="contextMenu.message.pinnedAt"><PinOff :size="16" />{{ t('unpin') }}</template>
          <template v-else><Pin :size="16" />{{ t('pin') }}</template>
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

/* A message that mentions you is tinted and marked at its edge, as in Discord. */
.message-row.mentions-me {
  background: var(--warning-soft);
  box-shadow: inset 2px 0 0 #f0b232;
}

[dir='rtl'] .message-row.mentions-me {
  box-shadow: inset -2px 0 0 #f0b232;
}

/* A message opened from search or the pinned list lights up for a moment. */
.message-row.highlighted {
  animation: message-highlight 2.5s ease-out;
}

@keyframes message-highlight {
  from, 30% { background: var(--accent-soft); }
}

.mention {
  padding: 0 2px;
  border-radius: 3px;
  color: var(--text-accent);
  background: var(--accent-soft);
  font-weight: 600;
}

.mention.me {
  color: #f0b232;
  background: var(--warning-soft);
}

.unread-divider {
  position: relative;
  display: flex;
  justify-content: flex-end;
  margin: 12px 16px 0;
  border-top: 1px solid var(--danger);
}

.unread-divider span {
  margin-top: -9px;
  padding: 0 5px;
  border-radius: 4px;
  color: #ffffff;
  background: var(--danger);
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  text-transform: uppercase;
}

.message-pinned {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-inline-start: 6px;
  color: var(--text-secondary);
  font-size: 11px;
}

.reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.reaction {
  min-height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-size: 15px;
}

.reaction:hover {
  border-color: var(--border-color);
}

.reaction.mine {
  border-color: var(--text-accent);
  color: var(--text-primary);
  background: var(--accent-soft);
}

.reaction-count {
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.reaction-picker {
  position: fixed;
  z-index: 100;
  display: flex;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-primary);
  box-shadow: 0 12px 32px var(--shadow-color);
}

.reaction-picker button,
.context-menu .context-reactions button {
  width: 38px;
  min-height: 38px;
  display: grid;
  place-items: center;
  padding: 0;
  border-radius: 9px;
  font-size: 21px;
}

.reaction-picker button:hover {
  background: var(--bg-hover);
}

.context-reactions {
  display: flex;
  justify-content: space-between;
  gap: 2px;
  padding: 2px 2px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-color);
}

/* Pinned messages open under the channel's header. */
.pins-popover {
  width: min(380px, calc(100vw - 24px));
  max-height: min(480px, 70dvh);
  position: absolute;
  top: calc(max(6px, env(safe-area-inset-top)) + 46px);
  inset-inline-end: 12px;
  z-index: 41;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  box-shadow: 0 16px 42px var(--shadow-color);
}

.pins-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 8px 8px;
  color: var(--text-primary);
}

.pins-head button {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-secondary);
}

.pins-state {
  display: flex;
  justify-content: center;
  padding: 18px 10px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.pin-item {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: var(--bg-primary);
}

.pin-open {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 10px;
  text-align: start;
}

.pin-meta {
  display: flex;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}

.pin-meta bdi {
  font-weight: 700;
}

.pin-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.pin-remove {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  margin: 4px;
  border-radius: 6px;
  color: var(--text-secondary);
}

.pin-remove:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* Typing @ lists people to mention, just above the message box. */
.mention-picker {
  width: min(360px, calc(100% - 28px));
  position: absolute;
  bottom: calc(100% + 6px);
  inset-inline-start: 14px;
  z-index: 4;
  padding: 5px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-primary);
  box-shadow: 0 10px 28px var(--shadow-color);
  list-style: none;
}

.mention-picker button {
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border-radius: 7px;
  color: var(--text-primary);
  font-size: 14px;
  text-align: start;
}

.mention-picker button.selected,
.mention-picker button:hover {
  background: var(--bg-hover);
}

.mention-picker small {
  margin-inline-start: auto;
  color: var(--text-secondary);
  font-size: 12px;
}

.mention-everyone {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-size: 12px;
  font-weight: 700;
}

.recording-bar {
  align-items: center;
}

.recording-status {
  min-width: 0;
  min-height: 44px;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-radius: 16px;
  color: var(--text-primary);
  background: var(--bg-secondary);
}

/* A slowly pulsing red dot shows the microphone is recording, without any sound. */
.recording-dot {
  width: 10px;
  height: 10px;
  flex: none;
  border-radius: 999px;
  background: var(--danger);
  animation: recording-pulse 1.2s ease-in-out infinite;
}

@keyframes recording-pulse {
  50% { opacity: 0.35; }
}

.recording-time {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.recording-label {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The menu button shows a dot when another channel has new messages. */
.menu-btn.has-unread {
  position: relative;
}

.menu-btn.has-unread::after {
  content: '';
  position: absolute;
  top: 7px;
  inset-inline-end: 6px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--bg-chat);
  border-radius: 999px;
  background: var(--danger);
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
