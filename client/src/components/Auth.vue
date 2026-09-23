<script setup lang="ts">
import { computed, ref } from 'vue';
import { BookOpenText } from 'lucide-vue-next';
import { api } from '../api';
import { useI18n } from '../i18n';
const emit = defineEmits<{ auth: [result: { token: string; user: any; conversationId: string }]; 'toggle-theme': [] }>();
defineProps<{ theme: 'light' | 'dark'; className: string }>();
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

const savedName = ref(localStorage.getItem('displayName') || '');
const visitorId = ref(localStorage.getItem('visitorId') || randomId());
localStorage.setItem('visitorId', visitorId.value);
const displayName = ref(savedName.value), code = ref(''), error = ref(''), loading = ref(false);
const needsName = computed(() => !savedName.value);
async function submit() {
  error.value = ''; loading.value = true;
  try {
    const name = (needsName.value ? displayName.value : savedName.value).trim();
    const result = await api.joinClass(code.value, visitorId.value, name);
    localStorage.setItem('displayName', result.user.displayName);
    sessionStorage.setItem('token', result.token);
    emit('auth', result);
  } catch (cause) { error.value = translateError(cause instanceof Error ? cause.message : ''); }
  finally { loading.value = false; }
}
function changeName() { savedName.value = ''; displayName.value = ''; localStorage.removeItem('displayName'); }
</script>
<template>
  <div class="auth-container"><form class="auth-card" @submit.prevent="submit">
    <div class="auth-topline"><span class="auth-mark" aria-hidden="true"><BookOpenText :size="22" /></span><div class="auth-utilities"><button class="auth-utility" type="button" :aria-label="t('toggleTheme')" @click="emit('toggle-theme')">{{ theme === 'light' ? '☾' : '☼' }}</button><button class="auth-language-trigger" type="button" @click="setLang(lang === 'en' ? 'ar' : 'en')">{{ lang === 'en' ? 'العربية' : 'English' }}</button></div></div>
    <div class="auth-eyebrow"><bdi>{{ className || t('classroom') }}</bdi></div><h1>{{ t('welcomeClassroom') }}</h1><p>{{ t('enterClassCode') }}</p>
    <div v-if="error" class="auth-error" role="alert">{{ error }}</div>
    <div class="input-group"><label for="class-code">{{ t('classCode') }}</label><input id="class-code" v-model="code" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="64" required autofocus :placeholder="t('classCodePlaceholder')"></div>
    <div v-if="needsName" class="input-group"><label for="display-name">{{ t('displayName') }}</label><input id="display-name" v-model="displayName" :placeholder="t('yourName')" autocomplete="name" maxlength="60" required></div>
    <div v-else class="saved-name">{{ t('joiningAs', { name: savedName }) }} <button type="button" @click="changeName">{{ t('changeName') }}</button></div>
    <button class="auth-btn" type="submit" :disabled="loading">{{ loading ? t('pleaseWait') : t('joinClass') }}</button>
  </form></div>
</template>
