<script setup lang="ts">
import { Bell, Check } from 'lucide-vue-next';
import { busy, chooseLevel, enabledHere, failed, level, permission, support, turnOnHere } from '../notifications';
import type { NotifyLevel } from '../notifications';
import { useI18n } from '../i18n';

const { t } = useI18n();
const LEVELS: { value: NotifyLevel; label: 'notifyAll' | 'notifyMentions' | 'notifyOff' }[] = [
  { value: 'all', label: 'notifyAll' },
  { value: 'mentions', label: 'notifyMentions' },
  { value: 'off', label: 'notifyOff' },
];
const canTurnOn = () => support.value === 'web' || support.value === 'native';
</script>

<template>
  <!-- The choice is the person's and applies to all their devices; below it, this device's state. -->
  <section class="notify-settings">
    <p class="notify-label"><Bell :size="14" /> {{ t('notifications') }}</p>
    <div class="notify-levels" role="radiogroup" :aria-label="t('notifications')">
      <button v-for="option in LEVELS" :key="option.value" type="button" role="radio" :aria-checked="level === option.value" :class="{ selected: level === option.value }" @click="chooseLevel(option.value)">
        <span class="notify-radio" aria-hidden="true" />{{ t(option.label) }}
      </button>
    </div>
    <template v-if="level !== 'off'">
      <p v-if="canTurnOn() && permission === 'granted' && enabledHere" class="notify-state on"><Check :size="14" /> {{ t('notifyOnHere') }}</p>
      <p v-else-if="canTurnOn() && permission === 'denied'" class="notify-state">{{ support === 'native' ? t('notifyBlockedApp') : t('notifyBlockedBrowser') }}</p>
      <template v-else-if="canTurnOn()">
        <p v-if="failed" class="notify-state error" role="alert">{{ t('notifyFailed') }}</p>
        <button class="notify-turn-on" type="button" :disabled="busy" @click="turnOnHere">{{ t('notifyTurnOnHere') }}</button>
      </template>
      <p v-else-if="support === 'update-app'" class="notify-state">{{ t('notifyUpdateApp') }}</p>
      <p v-else-if="support === 'app-not-ready'" class="notify-state">{{ t('notifyAppNotReady') }}</p>
      <p v-else-if="support === 'iphone-home-screen'" class="notify-state">{{ t('notifyIphoneHint') }}</p>
      <p v-else-if="support === 'unsupported'" class="notify-state">{{ t('notifyUnsupported') }}</p>
    </template>
  </section>
</template>

<style scoped>
.notify-settings {
  margin-bottom: 12px;
}

.notify-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 2px 7px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.notify-levels {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.notify-levels button {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  text-align: start;
}

.notify-levels button:hover {
  color: var(--text-primary);
}

.notify-levels button.selected {
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: 0 1px 4px var(--shadow-color);
}

.notify-radio {
  width: 14px;
  height: 14px;
  flex: none;
  border: 2px solid currentColor;
  border-radius: 50%;
}

.notify-levels button.selected .notify-radio {
  border: 4px solid var(--text-accent);
}

.notify-state {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 8px 2px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.notify-state.on svg {
  flex: none;
  margin-top: 2px;
  color: #23a55a;
}

.notify-state.error {
  color: var(--danger);
}

.notify-turn-on {
  width: 100%;
  min-height: 36px;
  margin-top: 8px;
  padding: 0 10px;
  border-radius: 6px;
  color: #ffffff;
  background: var(--text-accent);
  font-size: 13px;
  font-weight: 700;
}

.notify-turn-on:hover {
  filter: brightness(0.92);
}
</style>
