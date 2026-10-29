<script setup lang="ts">
import { useI18n } from '../i18n';
import { useCall } from '../call/context';

// Asks the teacher, once, to let the app draw over his tablet's other apps (see call/tabletBoard.ts).
const { t } = useI18n();
const { answerTabletPrompt } = useCall().tablet;
</script>

<template>
  <div class="call-board-prompt" role="dialog" :aria-label="t('tabletBoardTitle')">
    <strong>{{ t('tabletBoardTitle') }}</strong>
    <p>{{ t('tabletBoardBody') }}</p>
    <div class="call-board-prompt-actions">
      <button class="call-board-prompt-later" type="button" @click="answerTabletPrompt(false)">{{ t('notNow') }}</button>
      <button class="call-board-prompt-allow" type="button" @click="answerTabletPrompt(true)">{{ t('allow') }}</button>
    </div>
  </div>
</template>

<style scoped>
/* Asks the person sharing their tablet's screen to let the app draw over other apps. */
.call-board-prompt {
  width: min(420px, calc(100% - 32px));
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 7;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  border-radius: var(--radius-large);
  color: var(--call-text);
  background: var(--call-sheet);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  translate: -50% -50%;
  animation: anime-rise 420ms var(--soft-spring) both;
}

.call-board-prompt strong {
  font-size: 17px;
}

.call-board-prompt p {
  color: var(--call-text-muted);
  font-size: 15px;
  line-height: 1.6;
}

.call-board-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
}

.call-board-prompt-actions button {
  min-height: 46px;
  padding: 0 18px;
  border-radius: var(--radius);
  font-size: 15px;
  font-weight: 700;
}

.call-board-prompt-later {
  color: var(--call-text);
  background: var(--call-surface);
}

.call-board-prompt-allow {
  color: var(--text-on-accent);
  background: var(--text-accent);
}
</style>
