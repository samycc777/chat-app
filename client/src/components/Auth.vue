<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
import { useI18n } from '../i18n';
const emit = defineEmits<{ auth: [token: string] }>();
const { t, lang, setLang, translateError } = useI18n();
const isLogin = ref(true), username = ref(''), displayName = ref(''), password = ref(''), error = ref(''), loading = ref(false);
const showLangMenu = ref(false);
async function submit() {
  error.value = ''; loading.value = true;
  try {
    const result = isLogin.value ? await api.login(username.value, password.value) : await api.register(username.value, displayName.value, password.value);
    localStorage.setItem('token', result.token); emit('auth', result.token);
  } catch (cause) { error.value = translateError(cause instanceof Error ? cause.message : ''); }
  finally { loading.value = false; }
}
</script>
<template>
  <div class="auth-container"><form class="auth-card" @submit.prevent="submit">
    <div class="auth-language lang-switcher">
      <button class="auth-language-trigger" type="button" :aria-expanded="showLangMenu" @click="showLangMenu = !showLangMenu">{{ lang === 'en' ? 'English' : 'العربية' }}</button>
      <template v-if="showLangMenu">
        <div class="lang-menu-backdrop" @click="showLangMenu = false" />
        <div class="lang-menu auth-lang-menu" role="menu">
          <button type="button" role="menuitem" :class="{ active: lang === 'en' }" @click="setLang('en'); showLangMenu = false">English</button>
          <button type="button" role="menuitem" :class="{ active: lang === 'ar' }" @click="setLang('ar'); showLangMenu = false">العربية</button>
        </div>
      </template>
    </div>
    <h1>{{ t('appName') }}</h1><p>{{ isLogin ? t('signInToContinue') : t('createYourAccount') }}</p>
    <div v-if="error" class="auth-error">{{ error }}</div>
    <div class="input-group"><label>{{ t('username') }}</label><input v-model="username" :placeholder="t('enterUsername')" autocomplete="username" required></div>
    <div v-if="!isLogin" class="input-group"><label>{{ t('displayName') }}</label><input v-model="displayName" :placeholder="t('yourName')" required></div>
    <div class="input-group"><label>{{ t('password') }}</label><input v-model="password" type="password" :placeholder="t('enterPassword')" :autocomplete="isLogin ? 'current-password' : 'new-password'" required></div>
    <button class="auth-btn" type="submit" :disabled="loading">{{ loading ? t('pleaseWait') : isLogin ? t('signIn') : t('createAccount') }}</button>
    <div class="auth-switch">{{ isLogin ? t('noAccount') : t('haveAccount') }}<span @click="isLogin = !isLogin; error = ''">{{ isLogin ? t('signUp') : t('signIn') }}</span></div>
  </form></div>
</template>
