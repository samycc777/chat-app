<script setup lang="ts">
import { computed, ref } from 'vue';
import { Moon, Sun } from 'lucide-vue-next';
import { api } from '../api';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
const { t, lang, setLang, translateError } = useI18n();
const { theme, toggleTheme } = useTheme();

const stored = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Private browsing. */ } };

// Until paying for a room exists, the live site makes rooms only for someone who opens /new with
// the owner's creation key (?key=...). It is remembered on this device and taken out of the
// address bar, so it does not end up in a screenshot.
const params = new URLSearchParams(window.location.search);
const linkKey = params.get('key');
if (linkKey) {
  store('roomCreationKey', linkKey);
  const url = new URL(window.location.href);
  url.searchParams.delete('key');
  window.history.replaceState(null, '', url);
}

const name = ref(''), error = ref(''), loading = ref(false), copied = ref(false);
const invite = ref('');
const link = computed(() => `${window.location.origin}/?invite=${invite.value}`);

async function submit() {
  if (loading.value) return;
  error.value = ''; loading.value = true;
  try {
    const room = await api.createRoom(name.value.trim(), stored('roomCreationKey'));
    invite.value = room.invite;
  } catch (cause) {
    error.value = translateError(cause instanceof Error ? cause.message : '');
  } finally { loading.value = false; }
}

const linkField = ref<HTMLInputElement>();
async function copy() {
  try { await navigator.clipboard.writeText(link.value); } catch {
    // Without clipboard access, the link is selected so it can be copied by hand.
    linkField.value?.select();
    return;
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}
</script>
<template>
  <div class="create-container lofi-sky">
    <div class="create-card">
      <div class="create-topline">
        <span class="create-mark" aria-hidden="true">{{ t('appName').slice(0, 1) }}</span>
        <div class="create-utilities">
          <button class="create-utility create-theme" type="button" :title="theme === 'light' ? t('darkMode') : t('lightMode')" :aria-label="theme === 'light' ? t('darkMode') : t('lightMode')" @click="toggleTheme"><Moon v-if="theme === 'light'" :size="18" /><Sun v-else :size="18" /></button>
          <button class="create-utility" type="button" @click="setLang(lang === 'en' ? 'ar' : 'en')">{{ lang === 'en' ? 'العربية' : 'English' }}</button>
        </div>
      </div>

      <form v-if="!invite" @submit.prevent="submit">
        <h1>{{ t('newRoomTitle') }}</h1>
        <p>{{ t('newRoomBody') }}</p>
        <div v-if="error" class="create-error" role="alert">{{ error }}</div>
        <label for="room-name">{{ t('roomName') }}</label>
        <input id="room-name" v-model="name" :placeholder="t('roomNamePlaceholder')" maxlength="60" required>
        <button class="auth-btn" type="submit" :disabled="loading">{{ loading ? t('pleaseWait') : t('createRoom') }}</button>
      </form>

      <div v-else>
        <h1>{{ t('roomReadyTitle') }}</h1>
        <p>{{ t('roomReadyBody') }}</p>
        <label for="room-link">{{ t('inviteLink') }}</label>
        <div class="create-link">
          <input id="room-link" ref="linkField" :value="link" readonly dir="ltr" @focus="linkField?.select()">
          <button class="create-copy" type="button" @click="copy">{{ copied ? t('linkCopied') : t('copyLink') }}</button>
        </div>
        <a class="auth-btn create-open" :href="`/?invite=${invite}`">{{ t('openRoom') }}</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.create-container {
  width: 100%;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  background: var(--lofi-glow), var(--app-bg);
}

.create-card {
  width: 100%;
  max-width: 460px;
  padding: clamp(24px, 7vw, 42px);
  border: 1px solid var(--border-color);
  border-radius: 28px;
  background: var(--bg-primary);
  box-shadow: 0 18px 60px var(--shadow-color);
}

.create-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 30px;
}

.create-mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 15px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-size: 21px;
  font-weight: 800;
}

.create-utilities {
  display: flex;
  gap: 8px;
}

.create-utility {
  min-width: 42px;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--text-secondary);
  background: var(--bg-primary);
}

.create-theme {
  display: inline-grid;
  place-items: center;
}

.create-card h1 {
  margin-bottom: 8px;
  color: var(--text-primary);
  font-size: clamp(24px, 6.5vw, 32px);
  line-height: 1.2;
  text-align: start;
}

.create-card p {
  margin-bottom: 24px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.65;
  text-align: start;
}

.create-card label {
  display: block;
  margin-bottom: 7px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
}

.create-card input {
  width: 100%;
  min-width: 0;
  min-height: 50px;
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 13px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  font-size: 16px;
}

.create-card input:focus {
  border-color: var(--text-accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.create-link {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.create-link input {
  flex: 1;
  margin-bottom: 0;
  font-size: 14px;
}

.create-copy {
  flex: 0 0 auto;
  min-height: 50px;
  padding: 0 16px;
  border-radius: 13px;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-size: 14px;
  font-weight: 700;
}

.create-open {
  display: flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}

.create-error {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  border-radius: 12px;
  color: var(--danger);
  background: var(--danger-soft);
  font-size: 13px;
}
</style>
