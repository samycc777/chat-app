<script setup lang="ts">
import { Languages, LogOut, MonitorUp, Moon, Radio, Sun } from 'lucide-vue-next';
import type { User } from '../types';
import { useI18n } from '../i18n';

defineProps<{
  currentUser: User;
  theme: 'light' | 'dark';
  lessonActive: boolean;
}>();

const emit = defineEmits<{
  'toggle-theme': [];
  leave: [];
  lesson: [];
}>();

const { t, lang, setLang } = useI18n();
</script>

<template>
  <header class="classroom-header">
    <div class="classroom-identity">
      <span class="classroom-mark" aria-hidden="true">C</span>
      <div class="classroom-identity-copy">
        <div class="classroom-title-line">
          <h1>{{ t('classroom') }}</h1>
          <span v-if="lessonActive" class="classroom-live-badge">
            <span class="live-dot" />{{ t('liveNow') }}
          </span>
        </div>
        <p><bdi>{{ t('signedInAs', { name: currentUser.displayName }) }}</bdi></p>
      </div>
    </div>

    <div class="classroom-header-actions">
      <button
        class="header-action lesson-action"
        :class="{ active: lessonActive }"
        type="button"
        :title="lessonActive ? t('joinLesson') : t('openLesson')"
        @click="emit('lesson')"
      >
        <Radio v-if="lessonActive" :size="18" />
        <MonitorUp v-else :size="18" />
        <span class="header-action-label">{{ lessonActive ? t('joinLesson') : t('openLesson') }}</span>
      </button>

      <button
        class="header-action compact-action"
        type="button"
        :title="t('language')"
        :aria-label="t('language')"
        @click="setLang(lang === 'en' ? 'ar' : 'en')"
      >
        <Languages :size="18" />
        <span class="header-action-label">{{ lang === 'en' ? 'العربية' : 'English' }}</span>
      </button>

      <button
        class="header-action compact-action"
        type="button"
        :title="t('toggleTheme')"
        :aria-label="t('toggleTheme')"
        @click="emit('toggle-theme')"
      >
        <Sun v-if="theme === 'dark'" :size="18" />
        <Moon v-else :size="18" />
      </button>

      <button
        class="header-action compact-action leave-action"
        type="button"
        :title="t('leaveClass')"
        :aria-label="t('leaveClass')"
        @click="emit('leave')"
      >
        <LogOut :size="18" />
        <span class="header-action-label leave-label">{{ t('leaveClass') }}</span>
      </button>
    </div>
  </header>
</template>
