<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { ALargeSmall, BookOpenText, Languages, LogOut, MonitorUp, Moon, Radio, Sun } from 'lucide-vue-next';
import type { User } from '../types';
import { useI18n } from '../i18n';

defineProps<{
  currentUser: User;
  className: string;
  theme: 'light' | 'dark';
  textSize: number;
  isTeacher: boolean;
  lessonActive: boolean;
}>();

const emit = defineEmits<{
  'set-theme': [theme: 'light' | 'dark'];
  'set-text-size': [size: number];
  leave: [];
  lesson: [];
}>();

const { t, lang, setLang } = useI18n();
const SIZE_LABELS = ['textSizeSmall', 'textSizeMedium', 'textSizeLarge', 'textSizeHuge'] as const;
const displayOpen = ref(false);
function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') displayOpen.value = false; }
watch(displayOpen, open => {
  if (open) document.addEventListener('keydown', closeOnEscape);
  else document.removeEventListener('keydown', closeOnEscape);
});
onBeforeUnmount(() => document.removeEventListener('keydown', closeOnEscape));
</script>

<template>
  <header class="classroom-header">
    <div class="classroom-identity">
      <span class="classroom-mark" aria-hidden="true"><BookOpenText :size="21" /></span>
      <div class="classroom-identity-copy">
        <div class="classroom-title-line">
          <h1><bdi>{{ className || t('classroom') }}</bdi></h1>
          <span v-if="lessonActive" class="classroom-live-badge">
            <span class="live-dot" />{{ t('liveNow') }}
          </span>
        </div>
        <p>
          <bdi>{{ t('signedInAs', { name: currentUser.displayName }) }}</bdi>
          <span v-if="isTeacher" class="role-badge">{{ t('teacherBadge') }}</span>
        </p>
      </div>
    </div>

    <div class="classroom-header-actions">
      <!-- Students only see this once the teacher has started a lesson. -->
      <button
        v-if="lessonActive || isTeacher"
        class="header-action lesson-action"
        :class="{ active: lessonActive }"
        type="button"
        :title="lessonActive ? t('joinLesson') : t('startLesson')"
        @click="emit('lesson')"
      >
        <Radio v-if="lessonActive" :size="18" />
        <MonitorUp v-else :size="18" />
        <span class="header-action-label">{{ lessonActive ? t('joinLesson') : t('startLesson') }}</span>
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

      <div class="display-menu">
        <button
          class="header-action compact-action"
          :class="{ open: displayOpen }"
          type="button"
          :title="t('display')"
          :aria-label="t('display')"
          :aria-expanded="displayOpen"
          @click="displayOpen = !displayOpen"
        >
          <ALargeSmall :size="18" />
        </button>
        <template v-if="displayOpen">
          <div class="popover-backdrop" @click="displayOpen = false" />
          <div class="display-popover" role="dialog" :aria-label="t('display')">
            <p class="display-label">{{ t('textSize') }}</p>
            <div class="segmented" role="radiogroup" :aria-label="t('textSize')">
              <button
                v-for="(label, index) in SIZE_LABELS"
                :key="label"
                type="button"
                role="radio"
                :aria-checked="textSize === index"
                :aria-label="t(label)"
                :title="t(label)"
                :class="{ selected: textSize === index }"
                @click="emit('set-text-size', index)"
              >
                <span :style="{ fontSize: `${12 + index * 3}px` }" aria-hidden="true">A</span>
              </button>
            </div>
            <p class="display-preview message-content arabic" lang="ar" dir="rtl">السَّلَامُ عَلَيْكُمْ</p>
            <p class="display-label">{{ t('theme') }}</p>
            <div class="segmented" role="radiogroup" :aria-label="t('theme')">
              <button type="button" role="radio" :aria-checked="theme === 'light'" :class="{ selected: theme === 'light' }" @click="emit('set-theme', 'light')">
                <Sun :size="15" />{{ t('themeLight') }}
              </button>
              <button type="button" role="radio" :aria-checked="theme === 'dark'" :class="{ selected: theme === 'dark' }" @click="emit('set-theme', 'dark')">
                <Moon :size="15" />{{ t('themeDark') }}
              </button>
            </div>
          </div>
        </template>
      </div>

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
