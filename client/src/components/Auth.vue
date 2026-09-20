<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api';
import { useI18n } from '../i18n';
const emit = defineEmits<{ auth: [result: { token: string; user: any; conversationId: string }]; 'toggle-theme': [] }>();
defineProps<{ theme: 'light' | 'dark' }>();
const { t, lang, setLang, translateError } = useI18n();
const savedName = ref(localStorage.getItem('displayName') || '');
const visitorId = ref(localStorage.getItem('visitorId') || crypto.randomUUID());
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
    <div class="auth-topline"><span class="auth-mark">C</span><div class="auth-utilities"><button class="auth-utility" type="button" :aria-label="t('toggleTheme')" @click="emit('toggle-theme')">{{ theme === 'light' ? '☾' : '☼' }}</button><button class="auth-language-trigger" type="button" @click="setLang(lang === 'en' ? 'ar' : 'en')">{{ lang === 'en' ? 'العربية' : 'English' }}</button></div></div>
    <div class="auth-eyebrow">{{ t('classroom') }}</div><h1>{{ t('welcomeClassroom') }}</h1><p>{{ t('enterClassCode') }}</p>
    <div v-if="error" class="auth-error" role="alert">{{ error }}</div>
    <div class="input-group"><label>{{ t('classCode') }}</label><input v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus :placeholder="t('classCodePlaceholder')"></div>
    <div v-if="needsName" class="input-group"><label>{{ t('displayName') }}</label><input v-model="displayName" :placeholder="t('yourName')" autocomplete="name" maxlength="60" required></div>
    <div v-else class="saved-name">{{ t('joiningAs', { name: savedName }) }} <button type="button" @click="changeName">{{ t('changeName') }}</button></div>
    <button class="auth-btn" type="submit" :disabled="loading">{{ loading ? t('pleaseWait') : t('joinClass') }}</button>
  </form></div>
</template>
