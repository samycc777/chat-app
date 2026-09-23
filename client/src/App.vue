<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from 'vue';
import { LoaderCircle, WifiOff } from 'lucide-vue-next';
import type { Socket } from 'socket.io-client';
import type { Conversation, OnlineUser, User } from './types';
import { api, ApiError } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { useI18n } from './i18n';
import Auth from './components/Auth.vue';
import ChatView from './components/ChatView.vue';
import ClassroomHeader from './components/ClassroomHeader.vue';
import LessonView from './components/LessonView.vue';

type Lesson = { conversationId: string; presenterId: string; startedAt?: number };

const { t } = useI18n();
const token = ref(sessionStorage.getItem('token'));
const currentUser = ref<User | null>(null);
const conversation = ref<Conversation | null>(null);
const restoring = ref(false);
const restoreFailed = ref(false);
const sessionNotice = ref('');
const connection = ref<'connecting' | 'connected' | 'reconnecting'>('connecting');
const onlineUsers = ref(new Map<string, OnlineUser>());
const whiteboard = ref<Lesson | null>(null);
const showWhiteboard = ref(false);
const className = ref('');
const isTeacher = computed(() => currentUser.value?.role === 'teacher');
const theme = ref<'light' | 'dark'>(localStorage.getItem('classroom-theme') === 'dark' ? 'dark' : 'light');
watch(theme, value => { localStorage.setItem('classroom-theme', value); });
watchEffect(() => { document.title = className.value || t('classroom'); });
function toggleTheme() { theme.value = theme.value === 'light' ? 'dark' : 'light'; }

function openRoom(user: User, conversationId: string) {
  currentUser.value = user;
  conversation.value = {
    id: conversationId, type: 'group', name: 'Classroom', createdAt: Date.now(),
    lastMessage: null, lastMessageSender: null, lastMessageType: null,
    lastMessageTime: null, unreadCount: 0, members: [user],
  };
}

function listen(socket: Socket, user: User) {
  socket.on('connect', () => { connection.value = 'connected'; });
  socket.on('disconnect', reason => {
    if (reason === 'io client disconnect') return;
    connection.value = 'reconnecting';
    // socket.io retries network drops by itself, but not a connection the server closed. Retry that
    // too: a session that is no longer valid is then refused and handled by connect_error.
    if (reason === 'io server disconnect') setTimeout(() => { if (getSocket() === socket) socket.connect(); }, 2000);
  });
  socket.on('connect_error', error => {
    if (error.message === 'Invalid classroom session' || error.message === 'No token') endSession(t('errSessionExpired'));
    else if (connection.value === 'connected') connection.value = 'reconnecting';
  });
  socket.on('presence_state', ({ users }: { users: OnlineUser[] }) => {
    onlineUsers.value = new Map(users.map(person => [person.id, person]));
  });
  socket.on('presence', (data: { userId: string; online: boolean; user?: OnlineUser }) => {
    const next = new Map(onlineUsers.value);
    if (data.online && data.user) next.set(data.userId, data.user);
    else next.delete(data.userId);
    onlineUsers.value = next;
  });
  // Sent on every (re)connection, so a lesson that ended while this device was offline is closed here too.
  socket.on('lesson_state', ({ lesson }: { lesson: Lesson | null }) => {
    whiteboard.value = lesson;
    if (!lesson) showWhiteboard.value = false;
  });
  socket.on('wb_started', (data: Lesson) => {
    whiteboard.value = data;
    showWhiteboard.value = data.presenterId === user.id;
  });
  socket.on('wb_ended', () => { whiteboard.value = null; showWhiteboard.value = false; });
}

function enterRoom(sessionToken: string, user: User) {
  openRoom(user, 'classroom');
  listen(connectSocket(sessionToken), user);
}

function joined(result: { token: string; user: User; conversationId: string }) {
  sessionNotice.value = '';
  token.value = result.token;
  enterRoom(result.token, result.user);
}

// Only an ended session sends the student back to the code screen; a network problem offers a retry.
async function restoreSession() {
  if (!token.value) return;
  restoring.value = true;
  restoreFailed.value = false;
  try {
    enterRoom(token.value, await api.getMe());
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) endSession(t('errSessionExpired'));
    else restoreFailed.value = true;
  } finally {
    restoring.value = false;
  }
}

onMounted(() => {
  api.getClassInfo().then(info => { className.value = info.name || ''; }).catch(() => {});
  void restoreSession();
});
function openWhiteboard() {
  if (!conversation.value || !currentUser.value) return;
  if (whiteboard.value) { showWhiteboard.value = true; return; }
  // Only the teacher starts lessons; the server's wb_started broadcast then opens it for them.
  if (isTeacher.value) getSocket()?.emit('wb_start', { conversationId: conversation.value.id });
}
function leaveLesson() { showWhiteboard.value = false; }
function endLesson() {
  if (conversation.value && isTeacher.value) getSocket()?.emit('wb_end', { conversationId: conversation.value.id });
  showWhiteboard.value = false;
}
function endSession(notice = '') {
  disconnectSocket(); sessionStorage.removeItem('token'); token.value = null;
  currentUser.value = null; conversation.value = null; whiteboard.value = null; showWhiteboard.value = false;
  onlineUsers.value = new Map(); connection.value = 'connecting'; restoreFailed.value = false;
  sessionNotice.value = notice;
}
</script>
<template>
  <div class="app-shell" :class="{ 'classroom-open': Boolean(token && currentUser) }" :data-theme="theme">
  <div v-if="token && !currentUser && (restoring || restoreFailed)" class="boot-state" role="status">
    <template v-if="restoreFailed">
      <span class="boot-icon"><WifiOff :size="24" /></span>
      <p>{{ t('cannotReachClass') }}</p>
      <button class="auth-btn" type="button" @click="restoreSession">{{ t('retry') }}</button>
    </template>
    <LoaderCircle v-else class="boot-spinner" :size="30" :aria-label="t('pleaseWait')" />
  </div>
  <Auth v-else-if="!token || !currentUser" :theme="theme" :class-name="className" :notice="sessionNotice" @auth="joined" @toggle-theme="toggleTheme" />
  <main v-else-if="conversation && currentUser" class="classroom-layout">
    <ClassroomHeader
      :current-user="currentUser"
      :class-name="className"
      :theme="theme"
      :is-teacher="isTeacher"
      :lesson-active="Boolean(whiteboard)"
      @lesson="openWhiteboard"
      @toggle-theme="toggleTheme"
      @leave="endSession()"
    />
    <div v-if="connection !== 'connected'" class="connection-banner" role="status">
      <WifiOff :size="15" />{{ connection === 'connecting' ? t('connecting') : t('reconnecting') }}
    </div>
    <ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :is-teacher="isTeacher" :lesson-active="Boolean(whiteboard)" @whiteboard="openWhiteboard" />
    <LessonView v-if="showWhiteboard && whiteboard" :conversation-id="whiteboard.conversationId" :user-id="currentUser.id" :is-teacher="isTeacher" :presenter="whiteboard.presenterId === currentUser.id" :presenter-id="whiteboard.presenterId" @leave="leaveLesson" @end="endLesson">
      <template #chat><ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :is-teacher="isTeacher" /></template>
    </LessonView>
  </main>
  </div>
</template>
