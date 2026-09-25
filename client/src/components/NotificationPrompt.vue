<script setup lang="ts">
import { Bell } from 'lucide-vue-next';
import { busy, dismissPrompt, showPrompt, turnOnHere } from '../notifications';
import { useI18n } from '../i18n';

const { t } = useI18n();
</script>

<template>
  <!-- Browsers only ask for permission after a tap, so the app asks its own question first, once. -->
  <div v-if="showPrompt" class="notify-prompt" role="region" :aria-label="t('notifications')">
    <Bell :size="18" class="notify-prompt-icon" aria-hidden="true" />
    <p>{{ t('notifyPrompt') }}</p>
    <div class="notify-prompt-actions">
      <button class="notify-prompt-btn" type="button" @click="dismissPrompt">{{ t('notifyNotNow') }}</button>
      <button class="notify-prompt-btn primary" type="button" :disabled="busy" @click="turnOnHere">{{ t('notifyTurnOn') }}</button>
    </div>
  </div>
</template>

<style scoped>
.notify-prompt {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 8px 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  background: var(--bg-secondary);
}

.notify-prompt-icon {
  flex: none;
  color: var(--text-accent);
}

.notify-prompt p {
  min-width: 0;
  flex: 1 1 200px;
  font-size: 14px;
  line-height: 1.4;
}

.notify-prompt-actions {
  display: flex;
  gap: 8px;
  margin-inline-start: auto;
}

.notify-prompt-btn {
  min-height: 34px;
  padding: 0 12px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 600;
}

.notify-prompt-btn:hover {
  color: var(--text-primary);
}

.notify-prompt-btn.primary {
  color: #ffffff;
  background: var(--text-accent);
}

.notify-prompt-btn.primary:hover {
  filter: brightness(0.92);
}
</style>
