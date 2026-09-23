<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from 'vue';
import type { Socket } from 'socket.io-client';
import type { Conversation, User } from './types';
import { api } from './api';
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
const onlineUsers = ref(new Set<string>());
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
  socket.on('presence', (data: { userId: string; online: boolean }) => {
    const next = new Set(onlineUsers.value);
    if (data.online) next.add(data.userId);
    else next.delete(data.userId);
    onlineUsers.value = next;
  });
  socket.on('wb_started', (data: Lesson) => {
    whiteboard.value = data;
    showWhiteboard.value = data.presenterId === user.id;
  });
  socket.on('wb_ended', () => { whiteboard.value = null; showWhiteboard.value = false; });
}

function joined(result: { token: string; user: User; conversationId: string }) {
  token.value = result.token;
  openRoom(result.user, result.conversationId);
  listen(connectSocket(result.token), result.user);
}
onMounted(async () => {
  api.getClassInfo().then(info => { className.value = info.name || ''; }).catch(() => {});
  if (!token.value) return;
  try {
    const user = await api.getMe();
    openRoom(user, 'classroom');
    listen(connectSocket(token.value), user);
  } catch { sessionStorage.removeItem('token'); token.value = null; }
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
function leaveClass() {
  disconnectSocket(); sessionStorage.removeItem('token'); token.value = null;
  currentUser.value = null; conversation.value = null; whiteboard.value = null; showWhiteboard.value = false;
}
</script>
<template>
  <div class="app-shell" :class="{ 'classroom-open': Boolean(token && currentUser) }" :data-theme="theme">
  <Auth v-if="!token || !currentUser" :theme="theme" :class-name="className" @auth="joined" @toggle-theme="toggleTheme" />
  <main v-else-if="conversation && currentUser" class="classroom-layout">
    <ClassroomHeader
      :current-user="currentUser"
      :class-name="className"
      :theme="theme"
      :is-teacher="isTeacher"
      :lesson-active="Boolean(whiteboard)"
      @lesson="openWhiteboard"
      @toggle-theme="toggleTheme"
      @leave="leaveClass"
    />
    <ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :is-teacher="isTeacher" :lesson-active="Boolean(whiteboard)" @whiteboard="openWhiteboard" />
    <LessonView v-if="showWhiteboard && whiteboard" :conversation-id="whiteboard.conversationId" :user-id="currentUser.id" :is-teacher="isTeacher" :presenter="whiteboard.presenterId === currentUser.id" :presenter-id="whiteboard.presenterId" @leave="leaveLesson" @end="endLesson">
      <template #chat><ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :is-teacher="isTeacher" /></template>
    </LessonView>
  </main>
  </div>
</template>
