<script setup lang="ts">
import { Delete } from 'lucide-vue-next';
import { useI18n, type TranslationKey } from '../i18n';

const emit = defineEmits<{ insert: [text: string]; backspace: [] }>();
const { t } = useI18n();

// Letters follow the alphabet students learn rather than a computer keyboard's layout.
const LETTER_ROWS = [
  ['ا', 'ب', 'ت', 'ث', 'ج', 'ح', 'خ'],
  ['د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص'],
  ['ض', 'ط', 'ظ', 'ع', 'غ', 'ف', 'ق'],
  ['ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'],
  ['ء', 'أ', 'إ', 'آ', 'ؤ', 'ئ', 'ى', 'ة'],
];
// Vowel marks are written as code points because the combining characters are invisible on their own.
const HARAKAT: { mark: string; name: TranslationKey }[] = [
  { mark: String.fromCodePoint(0x064e), name: 'harakaFatha' },
  { mark: String.fromCodePoint(0x064f), name: 'harakaDamma' },
  { mark: String.fromCodePoint(0x0650), name: 'harakaKasra' },
  { mark: String.fromCodePoint(0x0652), name: 'harakaSukun' },
  { mark: String.fromCodePoint(0x0651), name: 'harakaShadda' },
  { mark: String.fromCodePoint(0x064b), name: 'harakaFathatan' },
  { mark: String.fromCodePoint(0x064c), name: 'harakaDammatan' },
  { mark: String.fromCodePoint(0x064d), name: 'harakaKasratan' },
];
// A mark is shown on a tatweel, the joining stroke, so it is visible and sits where it will in a word.
const TATWEEL = String.fromCodePoint(0x0640);
const PUNCTUATION = ['،', '؟', '.', '!'];
</script>

<template>
  <!-- Pressing a key must not take focus from the message box, or its caret position would be lost. -->
  <div class="arabic-keyboard" dir="rtl" lang="ar" role="group" :aria-label="t('arabicKeyboard')" @pointerdown.prevent>
    <div class="keyboard-row harakat-row">
      <button
        v-for="haraka in HARAKAT"
        :key="haraka.name"
        class="key haraka-key"
        type="button"
        :title="t(haraka.name)"
        :aria-label="t(haraka.name)"
        @click="emit('insert', haraka.mark)"
      >{{ TATWEEL + haraka.mark }}</button>
    </div>
    <div v-for="(row, index) in LETTER_ROWS" :key="index" class="keyboard-row">
      <button v-for="letter in row" :key="letter" class="key" type="button" @click="emit('insert', letter)">{{ letter }}</button>
    </div>
    <div class="keyboard-row">
      <button v-for="mark in PUNCTUATION" :key="mark" class="key" type="button" @click="emit('insert', mark)">{{ mark }}</button>
      <button class="key space-key" type="button" @click="emit('insert', ' ')">{{ t('keyboardSpace') }}</button>
      <button class="key backspace-key" type="button" :title="t('keyboardBackspace')" :aria-label="t('keyboardBackspace')" @click="emit('backspace')">
        <Delete :size="20" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.arabic-keyboard {
  width: 100%;
  max-width: 560px;
  display: grid;
  gap: 6px;
  margin-inline: auto;
  padding: 2px 10px max(10px, env(safe-area-inset-bottom));
  -webkit-user-select: none;
  user-select: none;
  touch-action: manipulation;
}

.keyboard-row {
  display: flex;
  justify-content: center;
  gap: 5px;
}

.key {
  min-width: 0;
  max-width: 60px;
  min-height: 42px;
  flex: 1 1 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-primary);
  background: var(--bg-primary);
  box-shadow: 0 1px 0 var(--border-color);
  font-size: 21px;
  line-height: 1;
  transition: background 120ms ease, transform 80ms ease;
}

.key:hover {
  background: var(--bg-hover);
}

.key:active {
  background: var(--accent-soft);
  transform: translateY(1px);
}

.harakat-row .key {
  min-height: 44px;
  border-color: transparent;
  color: var(--text-accent);
  background: var(--accent-soft);
  box-shadow: none;
  font-size: 28px;
}

.space-key {
  max-width: none;
  flex-grow: 3;
  font-size: 14px;
}

/* The keyboard is right-to-left, so backspace points the way it deletes. */
.backspace-key svg {
  transform: scaleX(-1);
}
</style>
