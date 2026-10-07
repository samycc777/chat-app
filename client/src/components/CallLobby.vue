<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Mic, MicOff, Moon, Sun, Video, VideoOff } from 'lucide-vue-next';
import type { OnlineUser, User } from '../types';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import Avatar from './Avatar.vue';

const props = defineProps<{ user: User; members: OnlineUser[]; error: string; joining: boolean; canJoin: boolean }>();
const emit = defineEmits<{ join: [choice: { mic: boolean; camera: boolean }]; 'change-name': [] }>();
const { t } = useI18n();
const { theme, toggleTheme } = useTheme();

const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: boolean) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* Private browsing. */ } };
// The last choice is kept, so someone who always joins muted does not have to mute every time.
// A first visit joins with the microphone on and the camera off.
const micOn = ref(stored('joinWithMic') !== '0');
const cameraOn = ref(stored('joinWithCamera') === '1');
watch(micOn, value => store('joinWithMic', value));
watch(cameraOn, value => store('joinWithCamera', value));

// With the camera on, you see yourself before joining, as in Zoom. The preview lets go of the
// camera when it is turned off or when the call starts, so the call can open it again.
const preview = ref<HTMLVideoElement>();
const cameraProblem = ref('');
let stream: MediaStream | null = null;
let starting = 0;
async function startPreview() {
  const attempt = ++starting;
  cameraProblem.value = '';
  try {
    const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 360 } });
    if (attempt !== starting || !cameraOn.value) { next.getTracks().forEach(track => track.stop()); return; }
    stream = next;
    if (preview.value) preview.value.srcObject = next;
  } catch {
    if (attempt !== starting) return;
    cameraProblem.value = t('cameraBlocked');
    cameraOn.value = false;
  }
}
function stopPreview() {
  starting++;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
}
watch(cameraOn, on => { if (on) void startPreview(); else stopPreview(); }, { immediate: true });
onBeforeUnmount(stopPreview);

function join() {
  stopPreview();
  emit('join', { mic: micOn.value, camera: cameraOn.value });
}

// Whoever is here can bring others in: the invite link is the one this device joined with.
const inviteCopied = ref(false);
async function copyInvite() {
  const invite = (() => { try { return localStorage.getItem('inviteKey') || ''; } catch { return ''; } })();
  if (!invite) return;
  try { await navigator.clipboard.writeText(`${window.location.origin}/?invite=${encodeURIComponent(invite)}`); } catch { return; }
  inviteCopied.value = true;
  setTimeout(() => { inviteCopied.value = false; }, 4000);
}
</script>

<template>
  <section class="lobby lofi-sky">
    <div class="lobby-card">
      <div class="lobby-topline">
        <button class="lobby-theme" type="button" :title="theme === 'light' ? t('darkMode') : t('lightMode')" :aria-label="theme === 'light' ? t('darkMode') : t('lightMode')" @click="toggleTheme">
          <Moon v-if="theme === 'light'" :size="18" /><Sun v-else :size="18" />
        </button>
      </div>
      <div class="lobby-preview">
        <video v-show="cameraOn" ref="preview" autoplay playsinline muted />
        <Avatar v-if="!cameraOn" :name="user.displayName" :color="user.avatarColor" size="large" />
        <bdi class="lobby-me">{{ user.displayName }}</bdi>
      </div>

      <div class="lobby-toggles">
        <button class="lobby-toggle" :class="{ off: !micOn }" type="button" :aria-pressed="micOn" @click="micOn = !micOn">
          <Mic v-if="micOn" :size="24" /><MicOff v-else :size="24" />
          <span>{{ micOn ? t('micIsOn') : t('micIsOff') }}</span>
        </button>
        <button class="lobby-toggle" :class="{ off: !cameraOn }" type="button" :aria-pressed="cameraOn" @click="cameraOn = !cameraOn">
          <Video v-if="cameraOn" :size="24" /><VideoOff v-else :size="24" />
          <span>{{ cameraOn ? t('cameraIsOn') : t('cameraIsOff') }}</span>
        </button>
      </div>
      <p v-if="cameraProblem" class="lobby-error" role="alert">{{ cameraProblem }}</p>

      <div class="lobby-people">
        <strong>{{ members.length ? t('inThisChannel') : t('callEmpty') }}</strong>
        <p v-if="!members.length">{{ t('callEmptyBody') }}</p>
        <ul v-else>
          <li v-for="member in members" :key="member.id">
            <Avatar :name="member.displayName" :color="member.avatarColor" size="small" />
            <bdi>{{ member.displayName }}</bdi>
          </li>
        </ul>
      </div>

      <p v-if="error" class="lobby-error" role="alert">{{ error }}</p>
      <button class="auth-btn" type="button" :disabled="joining || !canJoin" @click="join">
        {{ joining ? t('joiningCall') : t('joinCall') }}
      </button>
      <button class="lobby-invite" type="button" @click="copyInvite">{{ t('copyInviteLink') }}</button>
      <p v-if="inviteCopied" class="lobby-copied" role="status">{{ t('inviteCopied') }}</p>
      <button class="lobby-change-name" type="button" @click="emit('change-name')">{{ t('changeName') }}</button>
    </div>
  </section>
</template>

<style scoped>
/* In the call's own colours, so joining feels like stepping into it. */
.lobby {
  width: 100%;
  min-height: 100dvh;
  display: flex;
  overflow-y: auto;
  padding: max(20px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom));
  color: var(--call-text);
  background: var(--lofi-glow), var(--call-bg);
}

.lobby-card {
  width: 100%;
  max-width: 440px;
  margin: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.lobby-topline {
  display: flex;
  justify-content: flex-end;
  margin-bottom: -6px;
}

.lobby-theme {
  width: 42px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid var(--call-outline);
  border-radius: 12px;
  color: var(--call-text-muted);
}

.lobby-theme:hover {
  color: var(--call-text);
  background: var(--call-hover);
}

.lobby-preview {
  position: relative;
  aspect-ratio: 16 / 10;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: 24px;
  background: var(--call-surface);
}

.lobby-preview video {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  object-fit: cover;
  /* Like a mirror, which is what people expect of their own camera. */
  transform: scaleX(-1);
}

.lobby-me {
  position: absolute;
  bottom: 10px;
  inset-inline-start: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 13px;
  font-weight: 700;
}

.lobby-toggles {
  display: flex;
  justify-content: center;
  gap: 12px;
}

.lobby-toggle {
  flex: 1;
  min-height: 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 20px;
  color: var(--call-text);
  background: var(--call-surface);
  font-size: 14px;
  font-weight: 700;
  /* Squashes when pressed and springs back when let go. */
  transition: scale 380ms var(--spring);
}

.lobby-toggle:active {
  scale: 0.92;
  transition-duration: 70ms;
}

.lobby-toggle.off {
  color: #ffffff;
  background: var(--leave);
}

/* The icon bounces in each time the switch changes. */
.lobby-toggle svg {
  animation: anime-icon-on 420ms ease-out;
}

.lobby-toggle.off svg {
  animation-name: anime-icon-off;
}

.lobby-people strong {
  display: block;
  margin-bottom: 8px;
  font-size: 16px;
}

.lobby-people p {
  color: var(--call-text-muted);
  font-size: 14px;
  line-height: 1.55;
}

.lobby-people ul {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
}

.lobby-people li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
}

.lobby-error {
  color: var(--danger);
  font-size: 14px;
  line-height: 1.5;
}

.lobby-invite {
  min-height: 48px;
  border: 1px solid var(--call-outline);
  border-radius: 14px;
  color: var(--call-text);
  background: transparent;
  font-size: 15px;
  font-weight: 700;
}

.lobby-copied {
  color: var(--call-text-muted);
  font-size: 14px;
  text-align: center;
}

.lobby-change-name {
  align-self: center;
  color: var(--call-text-muted);
  font-size: 14px;
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* Each part of the screen rises in after the one above it. */
.lobby-card > * {
  animation: anime-rise 520ms var(--spring) both;
}

.lobby-card > :nth-child(1) { animation-delay: 150ms; }
.lobby-card > :nth-child(2) { animation-delay: 200ms; }
.lobby-card > :nth-child(3) { animation-delay: 260ms; }
.lobby-card > :nth-child(4) { animation-delay: 320ms; }
.lobby-card > :nth-child(5) { animation-delay: 380ms; }
.lobby-card > :nth-child(6) { animation-delay: 420ms; }
.lobby-card > :nth-child(7) { animation-delay: 460ms; }
.lobby-card > :nth-child(8) { animation-delay: 500ms; }
.lobby-card > :nth-child(9) { animation-delay: 540ms; }

/* Your picture floats gently while you get ready. */
.lobby-preview > :deep(.avatar) {
  animation: anime-float 1.8s ease-in-out infinite alternate;
}

/* Someone who joins the call pops into the list. */
.lobby-people li {
  animation: anime-pop 520ms ease-out both;
}
</style>
