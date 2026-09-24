<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, session } from '../api';
import { useI18n } from '../i18n';
import type { User } from '../types';
const emit = defineEmits<{ auth: [result: { token: string; user: User }]; 'toggle-theme': [] }>();
const props = defineProps<{ theme: 'light' | 'dark'; serverName: string; notice?: string }>();
const { t, lang, setLang, translateError } = useI18n();

// iOS Safari before 15.4 has no randomUUID, so build the same version 4 format from random bytes.
function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const stored = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const store = (key: string, value: string) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* Private browsing. */ } };

// Accepts a whole invite link or just the key inside it.
function keyFrom(text: string) {
  const trimmed = text.trim();
  try { return new URL(trimmed).searchParams.get('invite') ?? trimmed; } catch { return trimmed; }
}
// The key arrives in the invite link. It is remembered and taken out of the address bar, so it does
// not end up in a screenshot or a link copied from the address bar later.
const linkKey = new URLSearchParams(window.location.search).get('invite');
if (linkKey) {
  store('inviteKey', linkKey);
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState(null, '', url);
}

const savedName = ref(stored('displayName'));
const visitorId = stored('visitorId') || randomId();
store('visitorId', visitorId);
const inviteKey = ref(stored('inviteKey'));
const pastedLink = ref('');
const displayName = ref(savedName.value), error = ref(''), loading = ref(false);
const needsName = computed(() => !savedName.value);
async function submit() {
  error.value = ''; loading.value = true;
  const key = inviteKey.value || keyFrom(pastedLink.value);
  try {
    const name = (needsName.value ? displayName.value : savedName.value).trim();
    const result = await api.join(key, visitorId, name);
    store('inviteKey', key);
    store('displayName', result.user.displayName);
    session.token = result.token;
    emit('auth', result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    // A key that stopped working (because it was changed) is forgotten, so the new link can be pasted.
    if (message === 'Invalid invite link') { inviteKey.value = ''; store('inviteKey', ''); }
    error.value = translateError(message);
  } finally { loading.value = false; }
}
function changeName() { savedName.value = ''; displayName.value = ''; store('displayName', ''); }
// Someone who has been here before, on this device, goes straight back in.
onMounted(() => { if (inviteKey.value && savedName.value && !props.notice) void submit(); });
</script>
<template>
  <div class="auth-container"><form class="auth-card" @submit.prevent="submit">
    <div class="auth-topline"><span class="auth-mark" aria-hidden="true">{{ (serverName || t('appName')).slice(0, 1).toUpperCase() }}</span><div class="auth-utilities"><button class="auth-utility" type="button" :aria-label="t('toggleTheme')" @click="emit('toggle-theme')">{{ theme === 'light' ? '☾' : '☼' }}</button><button class="auth-language-trigger" type="button" @click="setLang(lang === 'en' ? 'ar' : 'en')">{{ lang === 'en' ? 'العربية' : 'English' }}</button></div></div>
    <div class="auth-eyebrow"><bdi>{{ serverName || t('appName') }}</bdi></div><h1>{{ t('welcomeTitle') }}</h1>
    <p>{{ inviteKey ? t('welcomeBody', { name: serverName || t('appName') }) : t('needInvite') }}</p>
    <div v-if="error" class="auth-error" role="alert">{{ error }}</div>
    <div v-else-if="notice" class="auth-notice" role="status">{{ notice }}</div>
    <div v-if="!inviteKey" class="input-group"><label for="invite-link">{{ t('inviteLink') }}</label><input id="invite-link" v-model="pastedLink" type="text" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="300" required :placeholder="t('inviteLinkPlaceholder')"></div>
    <div v-if="needsName" class="input-group"><label for="display-name">{{ t('displayName') }}</label><input id="display-name" v-model="displayName" :placeholder="t('yourName')" autocomplete="name" maxlength="60" required :autofocus="Boolean(inviteKey)"></div>
    <div v-else class="saved-name">{{ t('joiningAs', { name: savedName }) }} <button type="button" @click="changeName">{{ t('changeName') }}</button></div>
    <button class="auth-btn" type="submit" :disabled="loading">{{ loading ? t('pleaseWait') : t('join') }}</button>
  </form></div>
</template>

<style scoped>
/* Login */
.auth-container {
  width: 100%;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom));
}

.auth-card {
  width: 100%;
  max-width: 460px;
  padding: clamp(24px, 7vw, 42px);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  background: var(--bg-primary);
  box-shadow: 0 18px 60px var(--shadow-color);
}

.auth-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 34px;
}

.auth-mark {
  display: grid;
  place-items: center;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-weight: 800;
}

.auth-mark {
  width: 44px;
  height: 44px;
  border-radius: 15px;
  font-size: 21px;
}

.auth-utilities {
  display: flex;
  align-items: center;
  gap: 8px;
}

.auth-utility,
.auth-language-trigger {
  min-width: 42px;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
}

.auth-utility:hover,
.auth-language-trigger:hover {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--text-accent) 45%, var(--border-color));
  background: var(--bg-secondary);
}

.auth-eyebrow {
  color: var(--text-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.auth-card h1 {
  margin: 7px 0 8px;
  color: var(--text-primary);
  font-size: clamp(26px, 7vw, 34px);
  line-height: 1.2;
  letter-spacing: -0.025em;
  text-align: start;
}

.auth-card > p {
  margin-bottom: 28px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.65;
  text-align: start;
}

.input-group {
  margin-bottom: 16px;
}

.auth-card label {
  display: block;
  margin-bottom: 7px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
}

.auth-card input {
  width: 100%;
  min-height: 50px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 13px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-size: 16px;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.auth-card input:focus {
  border-color: var(--text-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.auth-card input::placeholder {
  color: var(--text-secondary);
  opacity: 0.72;
}

.auth-error {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  border-radius: 12px;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 13px;
}

.auth-notice {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--text-accent) 26%, transparent);
  border-radius: 12px;
  color: var(--text-primary);
  background: var(--accent-soft);
  font-size: 13px;
}

.saved-name {
  padding: 9px 0 4px;
  color: var(--text-secondary);
  font-size: 14px;
}

.saved-name button {
  color: var(--text-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}

[dir='rtl'] .auth-eyebrow {
  letter-spacing: 0;
}
</style>
