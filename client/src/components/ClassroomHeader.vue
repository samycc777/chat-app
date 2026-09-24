<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { ALargeSmall, BookOpenText, Languages, LogOut, MonitorUp, Moon, Radio, Sun } from 'lucide-vue-next';
import type { OnlineUser, User } from '../types';
import { useI18n } from '../i18n';
import PeopleMenu from './PeopleMenu.vue';

defineProps<{
  currentUser: User;
  people: OnlineUser[];
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

      <PeopleMenu :people="people" :current-user-id="currentUser.id" :is-teacher="isTeacher" />

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

<style scoped>
.classroom-mark {
  display: grid;
  place-items: center;
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-weight: 800;
}

.classroom-header {
  min-height: 68px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--bg-primary) 94%, transparent);
}

.classroom-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
}

.classroom-mark {
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  border-radius: 15px;
  font-size: 20px;
}

.classroom-identity-copy {
  min-width: 0;
}

.classroom-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.classroom-title-line h1 {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 17px;
  font-weight: 700;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.classroom-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-accent);
  font-size: 11px;
  font-weight: 700;
}

.classroom-live-badge {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
}

.classroom-header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
}

.header-action.compact-action {
  min-width: 42px;
}

.lesson-action {
  color: var(--text-accent);
  background: var(--accent-soft);
}

.lesson-action.active {
  color: var(--text-on-accent);
  background: var(--text-accent);
}

/* Display menu: text size and light or dark theme. */
.display-menu {
  position: relative;
}

.segmented {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  background: var(--bg-secondary);
}

.segmented button.selected {
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: 0 1px 4px var(--shadow-color);
}

.display-preview {
  margin: 10px 2px 14px;
  text-align: center;
}

.leave-action:hover {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 24%, var(--border-color));
  background: var(--danger-soft);
}

@media (max-width: 980px) {
  .header-action-label {
    display: none;
  }
}

@media (max-width: 768px) {
  .classroom-header {
    min-height: 60px;
    gap: 8px;
    padding: max(7px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 7px max(10px, env(safe-area-inset-left));
  }

  .classroom-identity {
    gap: 9px;
  }

  .classroom-mark {
    width: 40px;
    height: 40px;
    flex-basis: 40px;
    border-radius: 13px;
    font-size: 18px;
  }

  .classroom-title-line h1 {
    font-size: 15px;
  }

  .classroom-live-badge {
    padding: 2px 6px;
    font-size: 9px;
  }

  .classroom-header-actions {
    gap: 3px;
  }
}

@media (max-width: 460px) {
  .classroom-live-badge {
    display: none;
  }

  .classroom-header-actions {
    gap: 2px;
  }
}

@media (max-width: 360px) {
  .classroom-header {
    padding-inline: 7px;
  }

  .classroom-mark {
    width: 36px;
    height: 36px;
    flex-basis: 36px;
    border-radius: 12px;
  }

  .classroom-title-line h1 {
    max-width: 72px;
  }
}

@media (orientation: landscape) and (max-height: 520px) {
  .classroom-header {
    min-height: 52px;
  }

  .classroom-mark {
    width: 36px;
    height: 36px;
    flex-basis: 36px;
  }
}
</style>
