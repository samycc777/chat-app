<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from '../i18n';
import { calm, deviceReducesMotion, hideVideos, reduceEffects } from '../visualComfort';

const { t } = useI18n();
const hintId = useId();
</script>

<template>
  <fieldset class="visual-comfort">
    <legend>{{ t('visualComfort') }}</legend>
    <label>
      <input type="checkbox" :checked="calm" :disabled="deviceReducesMotion" @change="reduceEffects = ($event.target as HTMLInputElement).checked">
      <span>{{ t('reduceVisualEffects') }}<small v-if="deviceReducesMotion">{{ t('deviceReducesMotion') }}</small></span>
    </label>
    <label>
      <input v-model="hideVideos" type="checkbox" :aria-describedby="hintId">
      <span>{{ t('hideVideos') }}</span>
    </label>
    <p :id="hintId">{{ t('hideVideosHelp') }}</p>
  </fieldset>
</template>

<style scoped>
.visual-comfort {
  min-width: 0;
  margin: 16px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--call-text);
  text-align: start;
  font-size: 14px;
}
legend { padding: 0 5px; font-weight: 600; }
label { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; }
input { flex: 0 0 auto; width: 18px; height: 18px; accent-color: var(--text-accent); }
small, p { display: block; color: var(--call-text-muted); font-size: 12px; line-height: 1.6; }
p { margin: 4px 0 0; }
</style>
