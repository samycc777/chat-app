<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch, watchEffect } from 'vue';
import { LoaderCircle, Menu, Volume2, WifiOff } from 'lucide-vue-next';
import type { Socket } from 'socket.io-client';
import type { Channel, Member, Message, OnlineUser, ReadState, User, VoiceCall } from './types';
import { api, ApiError, session } from './api';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { useI18n } from './i18n';
import Auth from './components/Auth.vue';
import ChatView from './components/ChatView.vue';
import MemberList from './components/MemberList.vue';
import SearchPanel from './components/SearchPanel.vue';
import { mentionsUser } from './mentions';
import ServerSidebar from './components/ServerSidebar.vue';

// LiveKit makes up most of the app's code, so the call screen loads only when someone joins a voice
// channel. A page left open across a deploy asks for files the new version no longer has, so it
// reloads once to pick up the new one.
const loadCallView = () => import('./components/CallView.vue')
  .then(module => { sessionStorage.removeItem('reloaded-for-update'); return module; })
  .catch(error => {
    if (!sessionStorage.getItem('reloaded-for-update')) {
      sessionStorage.setItem('reloaded-for-update', '1');
      window.location.reload();
    }
    throw error;
  });
const CallView = defineAsyncComponent(loadCallView);

const { t, translateError } = useI18n();
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Private browsing. */ } };
const token = ref(session.token);
const currentUser = ref<User | null>(null);
const restoring = ref(false);
const restoreFailed = ref(false);
const connection = ref<'connecting' | 'connected' | 'reconnecting'>('connecting');
const onlineUsers = ref(new Map<string, OnlineUser>());
// Everyone who has joined, for the member list and for mentions.
const members = ref(new Map<string, Member>());
const reads = ref(new Map<string, ReadState>());
const searchOpen = ref(false);
// A message to show in its channel, from search or the pinned list; the counter repeats a jump.
const jump = ref<{ channelId: string; messageId: string; count: number } | null>(null);
let jumps = 0;
const channels = ref<Channel[]>([]);
const calls = ref<VoiceCall[]>([]);
const selectedId = ref<string | null>(stored('lastChannel'));
const callChannelId = ref<string | null>(null);
const callState = ref({ micOn: false, cameraOn: false, sharing: false, speaking: [] as string[] });
const callError = ref('');
const callView = ref<{ toggleMicrophone: () => void; leave: () => void } | null>(null);
const sidebarOpen = ref(false);
const membersOpen = ref(window.innerWidth >= 1000);
const serverName = ref('');
// Discord is dark by default, and so is this app until someone picks the light theme.
const theme = ref<'light' | 'dark'>(stored('theme') === 'light' ? 'light' : 'dark');
watch(theme, value => store('theme', value));
// Message text sizes in pixels; Arabic is set a little larger still, for its vowel marks.
const TEXT_SIZES = [14, 16, 18, 21];
const storedTextSize = stored('text-size');
const textSize = ref(storedTextSize !== null && TEXT_SIZES[Number(storedTextSize)] ? Number(storedTextSize) : 1);
watch(textSize, value => store('text-size', String(value)));

// The chosen channel, or the first text channel when it was deleted or nothing was chosen yet.
const selectedChannel = computed(() => channels.value.find(channel => channel.id === selectedId.value)
  ?? channels.value.find(channel => channel.kind === 'text') ?? null);
const callChannel = computed(() => channels.value.find(channel => channel.id === callChannelId.value) ?? null);
const handsInCall = computed(() => calls.value.find(call => call.channelId === callChannelId.value)?.hands ?? []);
const selectedCall = computed(() => calls.value.find(call => call.channelId === selectedChannel.value?.id) ?? null);
let lastTextChannelId: string | null = null;
watch(selectedChannel, channel => {
  if (channel?.kind === 'text') lastTextChannelId = channel.id;
  if (channel) store('lastChannel', channel.id);
});

// A background tab's title counts unseen messages and shows when you are in a call.
const unseen = ref(0);
function onVisibilityChange() { if (!document.hidden) unseen.value = 0; }
watchEffect(() => {
  const name = serverName.value || t('appName');
  document.title = `${unseen.value ? `(${unseen.value}) ` : ''}${callChannelId.value ? '🔊 ' : ''}${name}`;
});

function listen(socket: Socket, user: User) {
  socket.on('connect', () => {
    connection.value = 'connected';
    // The server forgets who was in a call when a connection drops, so a call in progress is
    // announced again; the call screen itself reconnects to LiveKit on its own.
    if (callChannelId.value) socket.emit('voice_join', { channelId: callChannelId.value });
  });
  socket.on('disconnect', reason => {
    if (reason === 'io client disconnect') return;
    connection.value = 'reconnecting';
    // socket.io retries network drops by itself, but not a connection the server closed. Retry that
    // too: a session that is no longer valid is then refused and handled by connect_error.
    if (reason === 'io server disconnect') setTimeout(() => { if (getSocket() === socket) socket.connect(); }, 2000);
  });
  socket.on('connect_error', error => {
    // An expired session goes back to the join screen, which signs straight back in with the saved invite.
    if (error.message === 'Invalid session' || error.message === 'No token') endSession();
    else if (connection.value === 'connected') connection.value = 'reconnecting';
  });
  socket.on('presence_state', ({ users }: { users: OnlineUser[] }) => {
    onlineUsers.value = new Map(users.map(person => [person.id, person]));
  });
  socket.on('presence', (data: { userId: string; online: boolean; user?: OnlineUser; lastSeen?: number }) => {
    const next = new Map(onlineUsers.value);
    if (data.online && data.user) next.set(data.userId, data.user);
    else next.delete(data.userId);
    onlineUsers.value = next;
    const known = new Map(members.value);
    const member = data.user ?? known.get(data.userId);
    if (member) known.set(data.userId, { ...known.get(data.userId), ...member, lastSeen: data.lastSeen ?? Date.now() });
    members.value = known;
  });
  socket.on('members', ({ users }: { users: Member[] }) => {
    members.value = new Map(users.map(member => [member.id, member]));
  });
  socket.on('read_state', ({ channels: list }: { channels: ReadState[] }) => {
    const next = new Map(reads.value);
    for (const state of list) next.set(state.channelId, state);
    reads.value = next;
  });
  socket.on('channels', ({ channels: list }: { channels: Channel[] }) => {
    channels.value = list;
    // A voice channel deleted while you were in it takes its call with it.
    if (callChannelId.value && !list.some(channel => channel.id === callChannelId.value)) callChannelId.value = null;
  });
  socket.on('voice_state', ({ calls: list }: { calls: VoiceCall[] }) => { calls.value = list; });
  socket.on('new_message', (message: Message) => {
    if (message.senderId === user.id) return;
    if (document.hidden) unseen.value++;
    // The channel being read marks itself read; every other channel counts the message as new.
    if (message.conversationId === selectedChannel.value?.id && !document.hidden) return;
    const state = reads.value.get(message.conversationId) ?? { channelId: message.conversationId, lastReadSeq: 0, unread: 0, mentions: 0 };
    reads.value = new Map(reads.value).set(message.conversationId, {
      ...state, unread: state.unread + 1, mentions: state.mentions + Number(mentionsUser(message.content, user.id)),
    });
  });
}

function enterServer(sessionToken: string, user: User) {
  currentUser.value = user;
  listen(connectSocket(sessionToken), user);
}

function joined(result: { token: string; user: User }) {
  token.value = result.token;
  enterServer(result.token, result.user);
}

// Only an ended session goes back to the join screen; a network problem offers a retry.
async function restoreSession() {
  if (!token.value) return;
  restoring.value = true;
  restoreFailed.value = false;
  try {
    enterServer(token.value, await api.getMe());
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) endSession();
    else restoreFailed.value = true;
  } finally {
    restoring.value = false;
  }
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange);
  api.getServerInfo().then(info => { serverName.value = info.name || ''; }).catch(() => {});
  void restoreSession();
});

const nameOf = (userId: string) => members.value.get(userId)?.displayName ?? onlineUsers.value.get(userId)?.displayName;

// Search results and pins open their channel at that message.
function openMessage(message: Message) {
  const channel = channels.value.find(entry => entry.id === message.conversationId);
  if (!channel) return;
  jump.value = { channelId: channel.id, messageId: message.id, count: ++jumps };
  select(channel);
  if (window.innerWidth <= 768) searchOpen.value = false;
}
// Channels other than the open one with something new, shown as a dot on the phone's menu button.
const unreadElsewhere = computed(() => [...reads.value.values()]
  .some(state => state.unread > 0 && state.channelId !== selectedChannel.value?.id && channels.value.some(channel => channel.id === state.channelId)));

// Opening a voice channel joins its call, as it does in Discord; opening a text channel keeps the
// call going in the background.
function select(channel: Channel) {
  selectedId.value = channel.id;
  sidebarOpen.value = false;
  if (channel.kind !== 'voice' || channel.id === callChannelId.value) return;
  callError.value = '';
  // Loading the call screen starts now, while the server is still being told.
  loadCallView().catch(() => {});
  getSocket()?.emit('voice_join', { channelId: channel.id }, (result: { error?: string }) => {
    if (result?.error) { callError.value = translateError(result.error); return; }
    callChannelId.value = channel.id;
  });
}
function leftCall() {
  getSocket()?.emit('voice_leave');
  if (selectedChannel.value?.id === callChannelId.value) selectedId.value = lastTextChannelId;
  callChannelId.value = null;
  callState.value = { micOn: false, cameraOn: false, sharing: false, speaking: [] };
}
function endSession() {
  disconnectSocket(); session.token = null; token.value = null;
  currentUser.value = null; callChannelId.value = null; channels.value = []; calls.value = [];
  members.value = new Map(); reads.value = new Map(); searchOpen.value = false;
  onlineUsers.value = new Map(); connection.value = 'connecting'; restoreFailed.value = false;
}
function signOut() {
  // Signing out also forgets the name and invite, so the next person on this device starts fresh.
  try { localStorage.removeItem('displayName'); localStorage.removeItem('inviteKey'); } catch { /* Private browsing. */ }
  endSession();
}
</script>
<template>
  <div class="app-shell" :data-theme="theme" :style="{ '--message-text-size': `${TEXT_SIZES[textSize]}px` }">
  <div v-if="token && !currentUser && (restoring || restoreFailed)" class="boot-state" role="status">
    <template v-if="restoreFailed">
      <span class="boot-icon"><WifiOff :size="24" /></span>
      <p>{{ t('cannotReach') }}</p>
      <button class="auth-btn" type="button" @click="restoreSession">{{ t('retry') }}</button>
    </template>
    <LoaderCircle v-else class="boot-spinner" :size="30" :aria-label="t('pleaseWait')" />
  </div>
  <Auth v-else-if="!token || !currentUser" :theme="theme" :server-name="serverName" @auth="joined" @toggle-theme="theme = theme === 'light' ? 'dark' : 'light'" />
  <main v-else class="server-layout" :class="{ 'sidebar-open': sidebarOpen, 'members-open': membersOpen }">
    <ServerSidebar
      :server-name="serverName"
      :channels="channels"
      :calls="calls"
      :current-channel-id="selectedChannel?.id ?? null"
      :call-channel-id="callChannelId"
      :call-state="callState"
      :current-user="currentUser"
      :theme="theme"
      :text-size="textSize"
      :reads="reads"
      @select="select"
      @toggle-mic="callView?.toggleMicrophone()"
      @leave-call="callView?.leave()"
      @set-theme="theme = $event"
      @set-text-size="textSize = $event"
      @sign-out="signOut"
    />
    <div class="drawer-backdrop" @click="sidebarOpen = false; membersOpen = false" />
    <div class="main-pane">
      <div v-if="connection !== 'connected'" class="connection-banner" role="status">
        <WifiOff :size="15" />{{ connection === 'connecting' ? t('connecting') : t('reconnecting') }}
      </div>
      <ChatView
        v-if="selectedChannel?.kind === 'text'"
        :channel="selectedChannel"
        :current-user="currentUser"
        :online-users="onlineUsers"
        :members="members"
        :members-open="membersOpen"
        :search-open="searchOpen"
        :last-read-seq="reads.get(selectedChannel.id)?.lastReadSeq ?? null"
        :unread-elsewhere="unreadElsewhere"
        :jump="jump?.channelId === selectedChannel.id ? jump : null"
        @menu="sidebarOpen = true"
        @members="membersOpen = !membersOpen; searchOpen = false"
        @search="searchOpen = !searchOpen; membersOpen = false"
        @open-message="openMessage"
        @jumped="jump = null"
      />
      <!-- The call stays mounted while text channels are read, so its sound carries on. -->
      <CallView
        v-if="callChannel"
        ref="callView"
        :key="callChannel.id"
        :channel-id="callChannel.id"
        :channel-name="callChannel.name"
        :user-id="currentUser.id"
        :visible="selectedChannel?.id === callChannel.id"
        :people="onlineUsers"
        :hands="handsInCall"
        @state="callState = $event"
        @leave="leftCall"
        @menu="sidebarOpen = true"
      />
      <section v-if="selectedChannel?.kind === 'voice' && selectedChannel.id !== callChannel?.id" class="voice-lobby">
        <header class="voice-lobby-header">
          <button class="voice-lobby-menu" type="button" :aria-label="t('channels')" @click="sidebarOpen = true"><Menu :size="20" /></button>
          <Volume2 :size="20" /><h2><bdi>{{ selectedChannel.name }}</bdi></h2>
        </header>
        <div class="voice-lobby-body">
          <strong>{{ selectedCall?.members.length ? t('inThisChannel') : t('callEmpty') }}</strong>
          <p v-if="!selectedCall?.members.length">{{ t('callEmptyBody') }}</p>
          <p v-else class="voice-lobby-names"><bdi v-for="member in selectedCall.members" :key="member.id">{{ member.displayName }}</bdi></p>
          <p v-if="callError" class="voice-lobby-error" role="alert">{{ callError }}</p>
          <button class="auth-btn" type="button" @click="select(selectedChannel)">{{ t('joinCall') }}</button>
        </div>
      </section>
    </div>
    <SearchPanel v-if="searchOpen && selectedChannel?.kind === 'text'" :channels="channels" :name-of="nameOf" @open="openMessage" @close="searchOpen = false" />
    <MemberList v-else-if="membersOpen && selectedChannel?.kind === 'text'" :members="[...members.values()]" :online="onlineUsers" :current-user-id="currentUser.id" />
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
  background: var(--bg-chat);
}

/* Shown while a saved session is restored, or when the server cannot be reached. */
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
  border-radius: 50%;
  color: var(--danger);
  background: var(--danger-soft);
}

.boot-spinner {
  color: var(--text-accent);
  animation: spin 1s linear infinite;
}

/* The server: channel list, then the open channel, then who is online, as in Discord. */
.server-layout {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.main-pane {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-chat);
}

.drawer-backdrop {
  display: none;
}

/* Appears only after a short delay, so a brief network blip does not flash it. */
.connection-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: max(7px, env(safe-area-inset-top)) 14px 7px;
  color: #ffffff;
  background: var(--danger);
  font-size: 12px;
  font-weight: 700;
  animation: connection-banner-in 200ms ease-out 1.5s both;
}

@keyframes connection-banner-in {
  from { opacity: 0; }
}

.voice-lobby {
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  color: #f2f3f5;
  background: #000000;
}

.voice-lobby-header {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(6px, env(safe-area-inset-top)) 12px 6px;
  color: #949ba4;
  background: #111214;
}

.voice-lobby-header h2 {
  color: #f2f3f5;
  font-size: 16px;
}

.voice-lobby-menu {
  width: 36px;
  height: 36px;
  display: none;
  place-items: center;
}

.voice-lobby-body {
  max-width: 420px;
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
}

.voice-lobby-body strong {
  font-size: 22px;
}

.voice-lobby-body p {
  color: #b5bac1;
  font-size: 14px;
  line-height: 1.55;
}

.voice-lobby-names {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 12px;
}

.voice-lobby-error {
  color: #f23f43 !important;
}

.voice-lobby-body .auth-btn {
  width: auto;
  min-width: 180px;
}

/* On phones the channel list and the members slide in over the channel, as in Discord's app. */
@media (max-width: 768px) {
  .server-layout :deep(.server-sidebar) {
    width: min(320px, 86vw);
    position: fixed;
    inset-block: 0;
    inset-inline-start: 0;
    z-index: 60;
    transform: translateX(-100%);
    transition: transform 220ms ease;
  }

  [dir='rtl'] .server-layout :deep(.server-sidebar) {
    transform: translateX(100%);
  }

  .server-layout.sidebar-open :deep(.server-sidebar) {
    transform: none;
  }

  .server-layout :deep(.member-list) {
    width: min(280px, 80vw);
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    z-index: 60;
  }

  .server-layout.sidebar-open .drawer-backdrop,
  .server-layout.members-open:has(.member-list) .drawer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: block;
    background: rgba(0, 0, 0, 0.55);
  }

  .voice-lobby-menu {
    display: grid;
  }
}
</style>
