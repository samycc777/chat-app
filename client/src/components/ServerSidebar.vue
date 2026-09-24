<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  ALargeSmall, Hash, Languages, LogOut, Mic, MicOff, Moon, PhoneOff, Plus, Settings, Sun, Trash2, UserPlus, Volume2, X, Pencil,
} from 'lucide-vue-next';
import type { Channel, User, VoiceCall } from '../types';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

const props = defineProps<{
  serverName: string;
  channels: Channel[];
  calls: VoiceCall[];
  currentChannelId: string | null;
  callChannelId: string | null;
  callState: { micOn: boolean; speaking: string[] };
  currentUser: User;
  theme: 'light' | 'dark';
  textSize: number;
}>();
const emit = defineEmits<{
  select: [channel: Channel];
  'toggle-mic': [];
  'leave-call': [];
  'set-theme': [theme: 'light' | 'dark'];
  'set-text-size': [size: number];
  'sign-out': [];
}>();
const { t, lang, setLang, translateError } = useI18n();
const SIZE_LABELS = ['textSizeSmall', 'textSizeMedium', 'textSizeLarge', 'textSizeHuge'] as const;

const textChannels = computed(() => props.channels.filter(channel => channel.kind === 'text'));
const voiceChannels = computed(() => props.channels.filter(channel => channel.kind === 'voice'));
const callChannel = computed(() => props.channels.find(channel => channel.id === props.callChannelId) ?? null);
const membersOf = (channelId: string) => props.calls.find(call => call.channelId === channelId)?.members ?? [];

// One small dialog serves creating, renaming and deleting channels, so there is only one pattern to learn.
type Dialog = { mode: 'create'; kind: Channel['kind'] } | { mode: 'edit'; channel: Channel } | { mode: 'delete'; channel: Channel };
const dialog = ref<Dialog | null>(null);
const dialogName = ref('');
const dialogError = ref('');
const dialogInput = ref<HTMLInputElement>();
const settingsOpen = ref(false);
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function openDialog(next: Dialog) {
  dialog.value = next;
  dialogError.value = '';
  dialogName.value = next.mode === 'create' ? '' : next.channel.name;
  void nextTick(() => dialogInput.value?.focus());
}
function reply(result: { error?: string }) {
  if (result?.error) { dialogError.value = translateError(result.error); return; }
  dialog.value = null;
}
function submitDialog() {
  const current = dialog.value;
  if (!current) return;
  const socket = getSocket();
  if (current.mode === 'create') {
    socket?.emit('create_channel', { name: dialogName.value, kind: current.kind }, (result: { error?: string; channel?: Channel }) => {
      reply(result);
      if (result?.channel) emit('select', result.channel);
    });
  } else if (current.mode === 'edit') {
    socket?.emit('rename_channel', { channelId: current.channel.id, name: dialogName.value }, reply);
  } else {
    socket?.emit('delete_channel', { channelId: current.channel.id }, reply);
  }
}

// The invite link is this site's address with the key in it, so friends only need to open it.
async function copyInvite() {
  let key = '';
  try { key = localStorage.getItem('inviteKey') ?? ''; } catch { /* Private browsing. */ }
  const link = `${window.location.origin}/?invite=${encodeURIComponent(key)}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: props.serverName || t('appName'), url: link });
    else { await navigator.clipboard.writeText(link); showNotice(t('inviteCopied')); }
  } catch { /* The share sheet was closed. */ }
}
function showNotice(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.value = ''; }, 3000);
}

function closeOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  settingsOpen.value = false;
  dialog.value = null;
}
watch([settingsOpen, dialog], ([open, current]) => {
  if (open || current) document.addEventListener('keydown', closeOnEscape);
  else document.removeEventListener('keydown', closeOnEscape);
});
onBeforeUnmount(() => { document.removeEventListener('keydown', closeOnEscape); clearTimeout(noticeTimer); });
</script>

<template>
  <nav class="server-sidebar" :aria-label="t('channels')">
    <header class="server-header">
      <h1><bdi>{{ serverName || t('appName') }}</bdi></h1>
      <button class="sidebar-icon-btn" type="button" :title="t('inviteFriends')" :aria-label="t('inviteFriends')" @click="copyInvite"><UserPlus :size="18" /></button>
    </header>
    <p v-if="notice" class="sidebar-notice" role="status">{{ notice }}</p>

    <div class="channel-scroll">
      <div class="channel-group">
        <div class="channel-group-head">
          <span>{{ t('textChannels') }}</span>
          <button type="button" :title="t('addTextChannel')" :aria-label="t('addTextChannel')" @click="openDialog({ mode: 'create', kind: 'text' })"><Plus :size="16" /></button>
        </div>
        <div v-for="channel in textChannels" :key="channel.id" class="channel-row" :class="{ active: channel.id === currentChannelId }">
          <button class="channel-link" type="button" @click="emit('select', channel)">
            <Hash :size="18" class="channel-icon" /><bdi>{{ channel.name }}</bdi>
          </button>
          <button class="channel-edit" type="button" :title="t('channelOptions')" :aria-label="`${t('channelOptions')}: ${channel.name}`" @click="openDialog({ mode: 'edit', channel })"><Settings :size="14" /></button>
        </div>
      </div>

      <div class="channel-group">
        <div class="channel-group-head">
          <span>{{ t('voiceChannels') }}</span>
          <button type="button" :title="t('addVoiceChannel')" :aria-label="t('addVoiceChannel')" @click="openDialog({ mode: 'create', kind: 'voice' })"><Plus :size="16" /></button>
        </div>
        <template v-for="channel in voiceChannels" :key="channel.id">
          <div class="channel-row" :class="{ active: channel.id === currentChannelId, joined: channel.id === callChannelId }">
            <button class="channel-link" type="button" @click="emit('select', channel)">
              <Volume2 :size="18" class="channel-icon" /><bdi>{{ channel.name }}</bdi>
            </button>
            <button class="channel-edit" type="button" :title="t('channelOptions')" :aria-label="`${t('channelOptions')}: ${channel.name}`" @click="openDialog({ mode: 'edit', channel })"><Settings :size="14" /></button>
          </div>
          <ul v-if="membersOf(channel.id).length" class="voice-members">
            <li v-for="member in membersOf(channel.id)" :key="member.id" :class="{ speaking: channel.id === callChannelId && callState.speaking.includes(member.id) }">
              <Avatar :name="member.displayName" :color="member.avatarColor" size="tiny" />
              <bdi>{{ member.displayName }}</bdi>
            </li>
          </ul>
        </template>
      </div>
    </div>

    <!-- Like Discord, the call keeps going while you read other channels, with its controls down here. -->
    <div v-if="callChannel" class="voice-panel">
      <div class="voice-panel-copy">
        <strong>{{ t('voiceConnected') }}</strong>
        <button type="button" @click="emit('select', callChannel)"><bdi>{{ callChannel.name }}</bdi></button>
      </div>
      <button class="sidebar-icon-btn" :class="{ danger: !callState.micOn }" type="button" :title="callState.micOn ? t('mute') : t('unmute')" :aria-label="callState.micOn ? t('mute') : t('unmute')" @click="emit('toggle-mic')">
        <Mic v-if="callState.micOn" :size="18" /><MicOff v-else :size="18" />
      </button>
      <button class="sidebar-icon-btn" type="button" :title="t('disconnect')" :aria-label="t('disconnect')" @click="emit('leave-call')"><PhoneOff :size="18" /></button>
    </div>

    <div class="user-panel">
      <Avatar :name="currentUser.displayName" :color="currentUser.avatarColor" size="small" online />
      <span class="user-panel-name"><bdi>{{ currentUser.displayName }}</bdi></span>
      <div class="settings-menu">
        <button class="sidebar-icon-btn" type="button" :title="t('settings')" :aria-label="t('settings')" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen"><Settings :size="18" /></button>
        <template v-if="settingsOpen">
          <div class="popover-backdrop" @click="settingsOpen = false" />
          <div class="display-popover settings-popover" role="dialog" :aria-label="t('settings')">
            <p class="display-label"><ALargeSmall :size="14" /> {{ t('textSize') }}</p>
            <div class="segmented" role="radiogroup" :aria-label="t('textSize')">
              <button v-for="(label, index) in SIZE_LABELS" :key="label" type="button" role="radio" :aria-checked="textSize === index" :aria-label="t(label)" :title="t(label)" :class="{ selected: textSize === index }" @click="emit('set-text-size', index)">
                <span :style="{ fontSize: `${12 + index * 3}px` }" aria-hidden="true">A</span>
              </button>
            </div>
            <p class="display-label">{{ t('theme') }}</p>
            <div class="segmented" role="radiogroup" :aria-label="t('theme')">
              <button type="button" role="radio" :aria-checked="theme === 'dark'" :class="{ selected: theme === 'dark' }" @click="emit('set-theme', 'dark')"><Moon :size="15" />{{ t('themeDark') }}</button>
              <button type="button" role="radio" :aria-checked="theme === 'light'" :class="{ selected: theme === 'light' }" @click="emit('set-theme', 'light')"><Sun :size="15" />{{ t('themeLight') }}</button>
            </div>
            <button class="settings-row" type="button" @click="setLang(lang === 'en' ? 'ar' : 'en')"><Languages :size="17" />{{ lang === 'en' ? 'العربية' : 'English' }}</button>
            <button class="settings-row danger" type="button" @click="settingsOpen = false; emit('sign-out')"><LogOut :size="17" />{{ t('signOut') }}</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="dialog" class="dialog-backdrop" @click.self="dialog = null">
      <form class="channel-dialog" role="dialog" @submit.prevent="submitDialog">
        <div class="channel-dialog-head">
          <strong v-if="dialog.mode === 'create'">{{ dialog.kind === 'text' ? t('addTextChannel') : t('addVoiceChannel') }}</strong>
          <strong v-else-if="dialog.mode === 'edit'">{{ t('channelOptions') }}</strong>
          <strong v-else>{{ t('deleteChannel') }}</strong>
          <button class="sidebar-icon-btn" type="button" :aria-label="t('close')" @click="dialog = null"><X :size="18" /></button>
        </div>
        <template v-if="dialog.mode === 'delete'">
          <p class="channel-dialog-text">{{ dialog.channel.kind === 'text' ? t('deleteTextConfirm', { name: dialog.channel.name }) : t('deleteVoiceConfirm', { name: dialog.channel.name }) }}</p>
        </template>
        <label v-else class="channel-dialog-field">
          <span>{{ t('channelName') }}</span>
          <span class="channel-dialog-input">
            <Hash v-if="(dialog.mode === 'create' ? dialog.kind : dialog.channel.kind) === 'text'" :size="16" />
            <Volume2 v-else :size="16" />
            <input ref="dialogInput" v-model="dialogName" maxlength="40" required>
          </span>
        </label>
        <p v-if="dialogError" class="channel-dialog-error" role="alert">{{ dialogError }}</p>
        <div class="channel-dialog-actions">
          <button v-if="dialog.mode === 'edit'" class="dialog-btn danger-text" type="button" @click="openDialog({ mode: 'delete', channel: dialog.channel })"><Trash2 :size="15" />{{ t('deleteChannel') }}</button>
          <span class="dialog-spacer" />
          <button class="dialog-btn" type="button" @click="dialog = null">{{ t('cancel') }}</button>
          <button v-if="dialog.mode === 'delete'" class="dialog-btn danger" type="submit">{{ t('delete') }}</button>
          <button v-else class="dialog-btn primary" type="submit"><Pencil v-if="dialog.mode === 'edit'" :size="15" />{{ dialog.mode === 'create' ? t('create') : t('rename') }}</button>
        </div>
      </form>
    </div>
  </nav>
</template>

<style scoped>
.server-sidebar {
  width: 240px;
  min-height: 0;
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}

.server-header {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(6px, env(safe-area-inset-top)) 8px 6px 16px;
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
}

.server-header h1 {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 15px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-notice {
  margin: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  color: #ffffff;
  background: var(--text-accent);
  font-size: 12px;
}

.sidebar-icon-btn {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--text-secondary);
}

.sidebar-icon-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.sidebar-icon-btn.danger {
  color: var(--danger);
}

.channel-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 16px;
}

.channel-group + .channel-group {
  margin-top: 16px;
}

.channel-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 4px 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.channel-group-head button {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 4px;
}

.channel-group-head button:hover {
  color: var(--text-primary);
}

.channel-row {
  display: flex;
  align-items: center;
  margin-top: 2px;
  border-radius: 6px;
  color: var(--text-secondary);
}

.channel-row:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.channel-row.active {
  color: var(--text-primary);
  background: var(--bg-active);
}

.channel-row.joined .channel-icon {
  color: #23a55a;
}

.channel-link {
  min-width: 0;
  min-height: 34px;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  font-size: 15px;
  font-weight: 500;
  text-align: start;
}

.channel-link bdi {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-icon {
  flex: none;
  opacity: 0.8;
}

.channel-edit {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  margin-inline-end: 4px;
  border-radius: 4px;
  opacity: 0;
}

.channel-row:hover .channel-edit,
.channel-row.active .channel-edit,
.channel-edit:focus-visible {
  opacity: 1;
}

@media (hover: none) {
  .channel-edit {
    opacity: 0.7;
  }
}

.voice-members {
  margin: 2px 0 4px;
  padding-inline-start: 30px;
  list-style: none;
}

.voice-members li {
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 14px;
}

.voice-members li bdi {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-members li.speaking .avatar {
  box-shadow: 0 0 0 2px var(--bg-secondary), 0 0 0 4px #23a55a;
}

.voice-panel {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.voice-panel-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding-inline-start: 4px;
}

.voice-panel-copy strong {
  color: #23a55a;
  font-size: 13px;
}

.voice-panel-copy button {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-panel-copy button:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.user-panel {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px max(8px, env(safe-area-inset-bottom));
  background: var(--bg-tertiary);
}

.user-panel-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The settings box is anchored to the whole user panel rather than to the
   small button, and spans the sidebar's width. Anchored to the button, it was
   wider than the sidebar and ran off the screen, in Arabic past the right edge. */
.settings-popover {
  width: auto;
  top: auto;
  bottom: calc(100% + 8px);
  inset-inline: 8px;
}

.display-label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.segmented {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.segmented button.selected {
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: 0 1px 4px var(--shadow-color);
}

.settings-row {
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
}

.settings-row:hover {
  background: var(--bg-hover);
}

.settings-row.danger {
  color: var(--danger);
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.6);
}

.channel-dialog {
  width: min(440px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 10px;
  background: var(--bg-primary);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.channel-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 18px;
}

.channel-dialog-text {
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.channel-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.channel-dialog-input {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--bg-tertiary);
}

.channel-dialog-input input {
  min-height: 42px;
  flex: 1;
  color: var(--text-primary);
  background: transparent;
  font-size: 16px;
  text-transform: none;
}

.channel-dialog-error {
  color: var(--danger);
  font-size: 13px;
}

.channel-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.dialog-spacer {
  flex: 1;
}

.dialog-btn {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
}

.dialog-btn:hover {
  text-decoration: underline;
}

.dialog-btn.primary {
  color: #ffffff;
  background: var(--text-accent);
}

.dialog-btn.danger {
  color: #ffffff;
  background: #da373c;
}

.dialog-btn.primary:hover,
.dialog-btn.danger:hover {
  text-decoration: none;
  filter: brightness(0.92);
}

.dialog-btn.danger-text {
  padding-inline: 4px;
  color: var(--danger);
}
</style>
