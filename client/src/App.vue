<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch, watchEffect } from 'vue';
import { LoaderCircle, WifiOff } from 'lucide-vue-next';
import type { Socket } from 'socket.io-client';
import type { Conversation, OnlineUser, User } from './types';
import { api, ApiError } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { useI18n } from './i18n';
import Auth from './components/Auth.vue';
import ChatView from './components/ChatView.vue';
import ClassroomHeader from './components/ClassroomHeader.vue';

// LiveKit makes up most of the app's code, so the lesson screen loads only when there is a lesson;
// it is fetched as soon as one starts, before anyone taps to join it. A page left open across a
// deploy asks for files the new version no longer has, so it reloads once to pick up the new one.
const loadLessonView = () => import('./components/LessonView.vue')
  .then(module => { sessionStorage.removeItem('reloaded-for-update'); return module; })
  .catch(error => {
    if (!sessionStorage.getItem('reloaded-for-update')) {
      sessionStorage.setItem('reloaded-for-update', '1');
      window.location.reload();
    }
    throw error;
  });
const LessonView = defineAsyncComponent(loadLessonView);

type Hand = { userId: string; displayName: string };
type Lesson = { conversationId: string; presenterId: string; startedAt?: number; hands?: Hand[] };

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
watch(whiteboard, lesson => { if (lesson) loadLessonView().catch(() => {}); });
const className = ref('');
const isTeacher = computed(() => currentUser.value?.role === 'teacher');
const theme = ref<'light' | 'dark'>(localStorage.getItem('classroom-theme') === 'dark' ? 'dark' : 'light');
watch(theme, value => { localStorage.setItem('classroom-theme', value); });
// Message text sizes in pixels; Arabic is set a little larger still, for its vowel marks.
const TEXT_SIZES = [14, 16, 18, 21];
const storedTextSize = localStorage.getItem('classroom-text-size');
const textSize = ref(storedTextSize !== null && TEXT_SIZES[Number(storedTextSize)] ? Number(storedTextSize) : 1);
watch(textSize, value => { localStorage.setItem('classroom-text-size', String(value)); });
// A background tab's title counts unseen messages and shows when a lesson is live.
const unseen = ref(0);
function onVisibilityChange() { if (!document.hidden) unseen.value = 0; }
watchEffect(() => {
  const name = className.value || t('classroom');
  document.title = `${unseen.value ? `(${unseen.value}) ` : ''}${whiteboard.value ? '🔴 ' : ''}${name}`;
});
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
    if (error.message === 'Removed from class') endSession(t('errRemovedFromClass'));
    else if (error.message === 'Invalid classroom session' || error.message === 'No token') endSession(t('errSessionExpired'));
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
  socket.on('new_message', (message: { senderId: string }) => {
    if (document.hidden && message.senderId !== user.id) unseen.value++;
  });
  socket.on('lesson_hands', ({ hands }: { hands: Hand[] }) => {
    if (whiteboard.value) whiteboard.value = { ...whiteboard.value, hands };
  });
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
    if (cause instanceof ApiError && cause.status === 403) endSession(t('errRemovedFromClass'));
    else if (cause instanceof ApiError && cause.status === 401) endSession(t('errSessionExpired'));
    else restoreFailed.value = true;
  } finally {
    restoring.value = false;
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange);
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
  <div class="app-shell" :class="{ 'classroom-open': Boolean(token && currentUser) }" :data-theme="theme" :style="{ '--message-text-size': `${TEXT_SIZES[textSize]}px` }">
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
      :people="[...onlineUsers.values()]"
      :class-name="className"
      :theme="theme"
      :text-size="textSize"
      :is-teacher="isTeacher"
      :lesson-active="Boolean(whiteboard)"
      @lesson="openWhiteboard"
      @set-theme="theme = $event"
      @set-text-size="textSize = $event"
      @leave="endSession()"
    />
    <div v-if="connection !== 'connected'" class="connection-banner" role="status">
      <WifiOff :size="15" />{{ connection === 'connecting' ? t('connecting') : t('reconnecting') }}
    </div>
    <ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :is-teacher="isTeacher" :lesson-active="Boolean(whiteboard)" @whiteboard="openWhiteboard" />
    <LessonView v-if="showWhiteboard && whiteboard" :conversation-id="whiteboard.conversationId" :user-id="currentUser.id" :is-teacher="isTeacher" :presenter="whiteboard.presenterId === currentUser.id" :presenter-id="whiteboard.presenterId" :hands="whiteboard.hands ?? []" @leave="leaveLesson" @end="endLesson">
      <template #chat><ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :is-teacher="isTeacher" /></template>
    </LessonView>
  </main>
  </div>
</template>

<style scoped>
.app-shell {
  width: 100%;
  min-width: 0;
  height: 100dvh;
  min-height: 0;
  display: flex;
  color: var(--text-primary);
  background:
    radial-gradient(circle at 14% 8%, color-mix(in srgb, var(--text-accent) 13%, transparent), transparent 38%),
    var(--bg-chat);
}

.app-shell.classroom-open {
  align-items: center;
  justify-content: center;
  padding: clamp(16px, 2.2vw, 28px);
}

/* Shown while a saved session is restored, or when the class cannot be reached. */
.boot-state {
  width: 100%;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  color: var(--text-secondary);
  text-align: center;
}

.boot-icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 17px;
  color: var(--danger);
  background: var(--danger-soft);
}

.boot-spinner {
  color: var(--text-accent);
  animation: spin 1s linear infinite;
}

/* Authenticated classroom shell */
.classroom-layout {
  width: min(1180px, 100%);
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 24px;
  background: var(--bg-primary);
  box-shadow: 0 24px 70px var(--shadow-color);
}

/* Appears only after a short delay, so a brief network blip does not flash it. */
.connection-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 7px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 22%, var(--border-color));
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 12px;
  font-weight: 700;
  animation: connection-banner-in 200ms ease-out 1.5s both;
}

@keyframes connection-banner-in {
  from { opacity: 0; }
}

@media (max-width: 768px) {
  .app-shell.classroom-open {
    padding: 0;
  }

  .classroom-layout {
    width: 100%;
    height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
</style>
