<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch, watchEffect } from 'vue';
import { WifiOff } from 'lucide-vue-next';
import type { Socket } from 'socket.io-client';
import type { Channel, OnlineUser, User, VoiceCall } from './types';
import { api, session } from './api';
import { rememberForHomeScreen } from './homeScreen';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { startNotifications } from './notifications';
import { clearCallChat, listenForCallChat } from './callChat';
import { useI18n } from './i18n';
import Auth from './components/Auth.vue';
import CallLobby from './components/CallLobby.vue';

// LiveKit makes up most of the app's code, so the call screen loads only when someone joins the
// call. A page left open across a deploy asks for files the new version no longer has, so it
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

// The app is three screens: your name, then who is in the call with your microphone and camera
// choices, then the call. Every opening starts at the name, filled in from last time.
const { t, translateError } = useI18n();
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Private browsing. */ } };
const currentUser = ref<User | null>(null);
const connection = ref<'connecting' | 'connected' | 'reconnecting'>('connecting');
const onlineUsers = ref(new Map<string, OnlineUser>());
const channels = ref<Channel[]>([]);
const calls = ref<VoiceCall[]>([]);
// What was chosen on the screen before the call; null while not in it.
const inCall = ref<{ mic: boolean; camera: boolean } | null>(null);
const joining = ref(false);
const callError = ref('');
const serverName = ref('');
// Given only when the site lets anyone join from its plain address (see Auth.vue).
const openInvite = ref('');
const theme = ref<'light' | 'dark'>(stored('theme') === 'light' ? 'light' : 'dark');
watch(theme, value => store('theme', value));

// The server can still hold several voice channels; the app only uses the first one.
const voiceChannel = computed(() => channels.value.find(channel => channel.kind === 'voice') ?? null);
const call = computed(() => calls.value.find(entry => entry.channelId === voiceChannel.value?.id) ?? null);

watchEffect(() => {
  document.title = `${inCall.value ? '🔊 ' : ''}${serverName.value || t('appName')}`;
});

function listen(socket: Socket) {
  socket.on('connect', () => {
    connection.value = 'connected';
    // The server forgets who was in a call when a connection drops, so a call in progress is
    // announced again; the call screen itself reconnects to LiveKit on its own.
    if (inCall.value && voiceChannel.value) socket.emit('voice_join', { channelId: voiceChannel.value.id, rejoin: true });
  });
  socket.on('disconnect', reason => {
    if (reason === 'io client disconnect') return;
    connection.value = 'reconnecting';
    // socket.io retries network drops by itself, but not a connection the server closed. Retry that
    // too: a session that is no longer valid is then refused and handled by connect_error.
    if (reason === 'io server disconnect') setTimeout(() => { if (getSocket() === socket) socket.connect(); }, 2000);
  });
  socket.on('connect_error', error => {
    // An ended session goes back to the name screen.
    if (error.message === 'Invalid session' || error.message === 'No token') backToName();
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
  socket.on('channels', ({ channels: list }: { channels: Channel[] }) => { channels.value = list; });
  socket.on('voice_state', ({ calls: list }: { calls: VoiceCall[] }) => { calls.value = list; });
  listenForCallChat(socket);
}

function joined(result: { token: string; user: User }) {
  currentUser.value = result.user;
  const socket = connectSocket(result.token);
  listen(socket);
  void startNotifications(socket);
  rememberForHomeScreen(result.user.displayName);
  // Loading the call screen starts now, so joining is quick.
  loadCallView().catch(() => {});
}

onMounted(() => {
  api.getServerInfo().then(info => { serverName.value = info.name || ''; openInvite.value = info.invite || ''; }).catch(() => {});
});

function joinCall(choice: { mic: boolean; camera: boolean }) {
  const channel = voiceChannel.value;
  if (!channel || joining.value) return;
  callError.value = '';
  joining.value = true;
  getSocket()?.emit('voice_join', { channelId: channel.id }, (result: { error?: string }) => {
    joining.value = false;
    if (result?.error) { callError.value = translateError(result.error); return; }
    inCall.value = choice;
  });
}
function leftCall() {
  getSocket()?.emit('voice_leave');
  inCall.value = null;
  clearCallChat();
}
function backToName() {
  disconnectSocket(); session.token = null;
  currentUser.value = null; inCall.value = null; channels.value = []; calls.value = [];
  onlineUsers.value = new Map(); connection.value = 'connecting'; callError.value = '';
  clearCallChat();
}
</script>
<template>
  <div class="app-shell" :data-theme="theme">
    <Auth v-if="!currentUser" :theme="theme" :server-name="serverName" :open-invite="openInvite" @auth="joined" @toggle-theme="theme = theme === 'light' ? 'dark' : 'light'" />
    <main v-else class="main-pane">
      <div v-if="connection !== 'connected'" class="connection-banner" role="status">
        <WifiOff :size="15" />{{ connection === 'connecting' ? t('connecting') : t('reconnecting') }}
      </div>
      <CallView
        v-if="inCall && voiceChannel"
        :key="voiceChannel.id"
        :channel-id="voiceChannel.id"
        :channel-name="serverName || t('appName')"
        :user-id="currentUser.id"
        :visible="true"
        :people="onlineUsers"
        :hands="call?.hands ?? []"
        :start-mic="inCall.mic"
        :start-camera="inCall.camera"
        @leave="leftCall"
      />
      <CallLobby
        v-else
        :user="currentUser"
        :members="call?.members ?? []"
        :error="callError"
        :joining="joining"
        :can-join="connection === 'connected' && Boolean(voiceChannel)"
        @join="joinCall"
        @change-name="backToName"
      />
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

.main-pane {
  width: 100%;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #000000;
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
</style>
