<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Moon, Sun } from 'lucide-vue-next';
import type { Conversation, User } from './types';
import { api } from './api';
import { useI18n } from './i18n';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import Auth from './components/Auth.vue';
import ChatView from './components/ChatView.vue';
import LessonView from './components/LessonView.vue';

const token = ref(sessionStorage.getItem('token'));
const currentUser = ref<User | null>(null);
const conversation = ref<Conversation | null>(null);
const onlineUsers = ref(new Set<string>());
const whiteboard = ref<{ conversationId: string; pdfUrl: string | null; presenterId: string } | null>(null);
const showWhiteboard = ref(false);
const theme = ref<'light' | 'dark'>(localStorage.getItem('classroom-theme') === 'dark' ? 'dark' : 'light');
const { t } = useI18n();
watch(theme, value => { localStorage.setItem('classroom-theme', value); });
function toggleTheme() { theme.value = theme.value === 'light' ? 'dark' : 'light'; }

function openRoom(user: User, conversationId: string) {
  currentUser.value = user;
  conversation.value = {
    id: conversationId, type: 'group', name: 'Classroom', createdAt: Date.now(),
    lastMessage: null, lastMessageSender: null, lastMessageType: null,
    lastMessageTime: null, unreadCount: 0, members: [user],
  };
}

function joined(result: { token: string; user: User; conversationId: string }) {
  token.value = result.token;
  openRoom(result.user, result.conversationId);
  const socket = connectSocket(result.token);
  socket.on('presence', (data: { userId: string; online: boolean }) => {
    const next = new Set(onlineUsers.value);
    if (data.online) next.add(data.userId);
    else next.delete(data.userId);
    onlineUsers.value = next;
  });
  socket.on('wb_started', (data: { conversationId: string; presenterId: string; pdfUrl: string | null }) => {
    whiteboard.value = data;
    showWhiteboard.value = data.presenterId === result.user.id;
  });
  socket.on('wb_ended', () => { whiteboard.value = null; showWhiteboard.value = false; });
  socket.emit('join_conversation', { conversationId: result.conversationId });
}
onMounted(async () => {
  if (!token.value) return;
  try {
    const user = await api.getMe();
    openRoom(user, 'classroom');
    const socket = connectSocket(token.value);
    socket.on('presence', (data: { userId: string; online: boolean }) => {
      const next = new Set(onlineUsers.value);
      if (data.online) next.add(data.userId);
      else next.delete(data.userId);
      onlineUsers.value = next;
    });
    socket.on('wb_started', (data: { conversationId: string; presenterId: string; pdfUrl: string | null }) => { whiteboard.value = data; showWhiteboard.value = data.presenterId === user.id; });
    socket.on('wb_ended', () => { whiteboard.value = null; showWhiteboard.value = false; });
  } catch { sessionStorage.removeItem('token'); token.value = null; }
});
function openWhiteboard() {
  if (!conversation.value || !currentUser.value) return;
  if (whiteboard.value) { showWhiteboard.value = true; return; }
  // The server's started/state response determines the actual presenter.
  const socket = connectSocket(token.value!);
  socket.emit('wb_start', { conversationId: conversation.value.id });
  socket.emit('wb_get_state', { conversationId: conversation.value.id });
}
function leaveLesson() { showWhiteboard.value = false; }
function endLesson() {
  if (conversation.value && currentUser.value && whiteboard.value?.presenterId === currentUser.value.id) getSocket()?.emit('wb_end', { conversationId: conversation.value.id });
  showWhiteboard.value = false;
}
function leaveClass() {
  disconnectSocket(); sessionStorage.removeItem('token'); token.value = null;
  currentUser.value = null; conversation.value = null; whiteboard.value = null; showWhiteboard.value = false;
}
</script>
<template>
  <div class="app-shell" :data-theme="theme">
  <Auth v-if="!token || !currentUser" @auth="joined" @toggle-theme="toggleTheme" :theme="theme" />
  <main v-else-if="conversation && currentUser" class="classroom-layout">
    <div class="classroom-bar"><span>{{ t('classroom') }} <span class="classroom-bar-dot">·</span> {{ currentUser.displayName }}</span><div class="classroom-bar-actions"><button class="theme-toggle" :title="t('toggleTheme')" :aria-label="t('toggleTheme')" @click="toggleTheme"><Sun v-if="theme === 'dark'" :size="18"/><Moon v-else :size="18"/></button><button class="leave-class-btn" @click="leaveClass">{{ t('leaveClass') }}</button></div></div>
    <ChatView :conversation="conversation" :current-user="currentUser" :online-users="onlineUsers" :lesson-active="Boolean(whiteboard)" @whiteboard="openWhiteboard" />
    <LessonView v-if="showWhiteboard && whiteboard" :conversation-id="whiteboard.conversationId" :presenter="whiteboard.presenterId === currentUser.id" @leave="leaveLesson" @end="endLesson" />
  </main>
  </div>
</template>
