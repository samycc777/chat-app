<script setup lang="ts">
import { Camera, Maximize, Moon, Pencil, Sun, UserRound, Volume1, Volume2 } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { askToDrawOverApps } from '../nativeBoard';
import { useCall } from '../call/context';
import { canAdjustVolume, MIN_VOLUME } from '../call/sound';
import CallSheet from './CallSheet.vue';

// The "more" panel: the call's volume, full screen, the tablet's board, your photo and the theme.
const { t } = useI18n();
const { theme, toggleTheme } = useTheme();
const call = useCall();
const userId = call.props.userId;
const { volume } = call.sound;
const { fullScreenChoice } = call.layout;
const { enterFullScreen } = call.fullScreen;
const { offerTabletBoard } = call.tablet;
const { pictureOf } = call.tiles;
const { busy: photoBusy, choose: choosePhoto, remove: removePhoto } = call.photo;
const { closeSheet } = call;
</script>

<template>
  <CallSheet :label="t('more')">
    <label v-if="canAdjustVolume" class="call-volume">
      <Volume1 :size="20" aria-hidden="true" />
      <span>{{ t('callVolume') }}</span>
      <input v-model.number="volume" type="range" :min="MIN_VOLUME" max="1" step="0.05">
      <Volume2 :size="20" aria-hidden="true" />
    </label>
    <button v-if="fullScreenChoice" class="call-sheet-row" type="button" @click="enterFullScreen(fullScreenChoice.key)">
      <Maximize :size="20" />{{ t('fullscreen') }}
    </button>
    <button v-if="offerTabletBoard" class="call-sheet-row" type="button" @click="askToDrawOverApps(); closeSheet()">
      <Pencil :size="20" />{{ t('showDrawingsOnMyScreen') }}
    </button>
    <button class="call-sheet-row" type="button" :disabled="photoBusy" @click="choosePhoto">
      <Camera :size="20" />{{ photoBusy ? t('savingPhoto') : pictureOf(userId) ? t('changePhoto') : t('addPhoto') }}
    </button>
    <button v-if="pictureOf(userId)" class="call-sheet-row" type="button" :disabled="photoBusy" @click="removePhoto">
      <UserRound :size="20" />{{ t('removePhoto') }}
    </button>
    <button class="call-sheet-row" type="button" @click="toggleTheme">
      <Moon v-if="theme === 'light'" :size="20" /><Sun v-else :size="20" />{{ theme === 'light' ? t('darkMode') : t('lightMode') }}
    </button>
  </CallSheet>
</template>

<style scoped>
.call-sheet-row:hover {
  background: var(--call-hover);
}

.call-volume {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--call-line);
  font-size: 14px;
  font-weight: 600;
}

.call-volume svg {
  flex: none;
  color: var(--text-secondary);
}

.call-volume input {
  min-width: 0;
  height: 44px;
  flex: 1;
  accent-color: var(--text-accent);
}

.call-sheet-row:disabled {
  opacity: 0.45;
}

.call-sheet-row {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
  padding: 0 8px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 600;
}
</style>
