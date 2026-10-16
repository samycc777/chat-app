<script setup lang="ts">
import { X } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { useCall } from '../call/context';

// The frame of the call's panels: a sheet rising from the bottom on phones, or, for a `side` panel,
// one docked to the side on wide screens. A panel with a title has a head with a close button.
defineProps<{ label: string; title?: string; side?: boolean }>();
const { t } = useI18n();
const { closeSheet } = useCall();
</script>

<template>
  <section class="call-sheet" :class="{ side }" :aria-label="label">
    <span v-if="!side" class="call-sheet-handle" />
    <div v-if="title" class="call-sheet-head">
      <strong>{{ title }}</strong>
      <button class="call-icon-btn" type="button" :aria-label="t('close')" @click="closeSheet"><X :size="18" /></button>
    </div>
    <slot />
  </section>
</template>

<style scoped>
.call-sheet {
  width: min(480px, 100%);
  max-height: 85%;
  position: absolute;
  bottom: 0;
  inset-inline: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  overflow: auto;
  margin-inline: auto;
  padding: 10px 16px max(18px, env(safe-area-inset-bottom));
  border-radius: 6px 6px 0 0;
  background: var(--call-sheet);
  box-shadow: 0 -16px 50px rgba(0, 0, 0, 0.45);
  animation: call-sheet-in 380ms var(--soft-spring);
}

.call-sheet.side {
  height: 85%;
  padding-top: 12px;
}

@keyframes call-sheet-in {
  from { opacity: 0; translate: 0 60px; }
}

.call-sheet-handle {
  width: 38px;
  height: 4px;
  flex: 0 0 auto;
  margin: 0 auto 14px;
  border-radius: 999px;
  background: var(--call-handle);
}

.call-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--call-line);
}

@media (min-width: 900px) {
  .call-sheet.side {
    width: 340px;
    height: auto;
    max-height: none;
    top: 0;
    inset-inline-start: auto;
    margin: 0;
    border-radius: 0;
  }
}
</style>
