<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch, watchEffect } from 'vue';
import { WifiOff } from 'lucide-vue-next';
import type { Socket } from 'socket.io-client';
import type { Channel, JoinResult, OnlineUser, User, VoiceCall } from './types';
import { api, session } from './api';
import { rememberForHomeScreen } from './homeScreen';
import { connectSocket, disconnectSocket, getSocket } from './socket';
import { startNotifications } from './notifications';
import { clearCallChat, listenForCallChat } from './callChat';
import { useI18n } from './i18n';
import Auth from './components/Auth.vue';
import CallLobby from './components/CallLobby.vue';
import CreateRoom from './components/CreateRoom.vue';

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
// Joining a call used to wait for the call screen and the noise filter to download, which on slow
// internet took several seconds. They are fetched quietly while the person is still choosing their
// microphone and camera, so joining reads them from the device. A failed download here is simply
// tried again on joining.
let preloaded = false;
function preloadCall() {
  if (preloaded) return;
  preloaded = true;
  loadCallView()
    .then(() => import('./cleanVoice'))
    .then(module => module.preloadCleanVoice())
    .catch(() => {});
}

// The app is three screens: your name, then who is in the call with your microphone and camera
// choices, then the call. Every opening starts at the name, filled in from last time. The address
// /new is apart from them: it makes a new room, and its link then leads to those three screens.
const creatingRoom = window.location.pathname === '/new';
const { t, translateError } = useI18n();
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
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

function joined(result: JoinResult) {
  currentUser.value = result.user;
  if (result.room) serverName.value = result.room.name || '';
  const socket = connectSocket(result.token);
  listen(socket);
  void startNotifications(socket);
  rememberForHomeScreen(result.user.displayName);
  preloadCall();
}

onMounted(() => {
  // Auth.vue has already kept the invite from the link, so the name shown is that invite's room's.
  api.getServerInfo(stored('inviteKey') || undefined).then(info => { serverName.value = info.name || ''; openInvite.value = info.invite || ''; }).catch(() => {});
});

function joinCall(choice: { mic: boolean; camera: boolean }) {
  const channel = voiceChannel.value;
  const socket = getSocket();
  if (!channel || !socket || joining.value) return;
  callError.value = '';
  joining.value = true;
  // The call opens once the server knows and the call screen has loaded, so "Joining the call…"
  // shows the whole time instead of an empty screen. A server that never answers, as on a
  // connection that has quietly died, gives the button back.
  const told = new Promise<{ error?: string }>((resolve, reject) => {
    socket.timeout(30_000).emit('voice_join', { channelId: channel.id }, (timedOut: Error | null, result: { error?: string }) => {
      if (timedOut) reject(timedOut); else resolve(result);
    });
  });
  void Promise.all([told, loadCallView()]).then(([result]) => {
    if (!joining.value) return;
    joining.value = false;
    if (result?.error) { callError.value = translateError(result.error); return; }
    inCall.value = choice;
  }, () => {
    if (joining.value) { joining.value = false; callError.value = t('callConnectFailed'); }
  });
}
// Moving from one screen to the next, coloured bands slash across the screen, as anime cuts between
// scenes. They run on their own over the new screen and never block a tap.
const screen = computed(() => creatingRoom ? 'new' : !currentUser.value ? 'name' : inCall.value ? 'call' : 'lobby');
const wipe = ref(0);
let wipeTimer: ReturnType<typeof setTimeout> | undefined;
watch(screen, () => {
  wipe.value++;
  clearTimeout(wipeTimer);
  wipeTimer = setTimeout(() => { wipe.value = 0; }, 1000);
});

function leftCall() {
  getSocket()?.emit('voice_leave');
  inCall.value = null;
  clearCallChat();
}
function backToName() {
  disconnectSocket(); session.token = null;
  currentUser.value = null; inCall.value = null; joining.value = false; channels.value = []; calls.value = [];
  onlineUsers.value = new Map(); connection.value = 'connecting'; callError.value = '';
  clearCallChat();
}
</script>
<template>
  <div class="app-shell">
    <CreateRoom v-if="creatingRoom" />
    <Auth v-else-if="!currentUser" :server-name="serverName" :open-invite="openInvite" @auth="joined" />
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
    <div v-if="wipe" :key="wipe" class="scene-wipe" :class="screen" aria-hidden="true"><span /><span /><span /></div>
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
  background: var(--call-bg);
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

.scene-wipe {
  position: fixed;
  inset: 0;
  z-index: 50;
  overflow: hidden;
  pointer-events: none;
}

/* Three slanted bands, the widest first, each a moment after the one before. They start and end
   well beyond the screen's edges, because the slant reaches further out on a tall phone. */
.scene-wipe span {
  width: 150vw;
  position: absolute;
  inset-block: -20%;
  left: 0;
  transform: skewX(-12deg);
  translate: calc(-100% - 60vh) 0;
  animation: scene-slash 760ms cubic-bezier(0.6, 0, 0.25, 1) forwards;
}

.scene-wipe span:nth-child(1) {
  background: var(--accent-strong);
}

.scene-wipe span:nth-child(2) {
  width: 110vw;
  background: var(--text-accent);
  animation-delay: 70ms;
}

.scene-wipe span:nth-child(3) {
  width: 10vw;
  background: #ffffff;
  opacity: 0.8;
  animation-delay: 150ms;
}

/* Joining the call ends with lines rushing out from the middle, as at the start of an anime fight. */
.scene-wipe.call::after {
  content: '';
  position: absolute;
  inset: -50%;
  background: repeating-conic-gradient(from 0deg, color-mix(in srgb, var(--text-accent) 70%, transparent) 0deg 1.2deg, transparent 1.2deg 9deg);
  mask: radial-gradient(circle, transparent 18%, #000000 40%);
  opacity: 0;
  animation: scene-lines 640ms ease-out 300ms forwards;
}

[dir='rtl'] .scene-wipe {
  scale: -1 1;
}

@keyframes scene-slash {
  to { translate: calc(100vw + 60vh) 0; }
}

@keyframes scene-lines {
  0% { opacity: 0; scale: 0.7; }
  25% { opacity: 1; }
  100% { opacity: 0; scale: 1.25; }
}
</style>
