<script setup lang="ts">
import { computed } from 'vue';
import { Download, Eraser, Hand, Mic, MicOff, Minimize, Moon, Pencil, ScreenShare, Sun, ZoomOut } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { boardVersion, erase, hasDrawings, penOn } from '../board';
import { useCall } from '../call/context';
import { canSavePicture } from '../call/layout';

// Full screen: one video over the whole app, with a bar above it and another below, and the name of
// whoever is talking (see call/fullScreen.ts).
const { t } = useI18n();
const call = useCall();
const { micOn } = call.state;
const { setMicrophone } = call.microphone;
const { savePicture } = call.layout;
const { myHandRaised, myHandTurn, handButtonLabel } = call.tiles;
const { toggleHand } = call;
const { fullTile, fullTileView, fullZoomed, fullSpeaker, darkScreen, toggleDarkScreen, exitFullScreen } = call.fullScreen;
// Whether anything is drawn on the screen shown full screen, so the eraser has something to erase.
const fullDrawn = computed(() => { void boardVersion.value; return Boolean(fullTile.value && hasDrawings(fullTile.value.key)); });
</script>

<template>
  <div v-if="fullTile" class="call-full">
    <div id="call-spot-full" class="call-full-spot" />
    <Transition name="call-full-speaker">
      <span v-if="fullSpeaker" class="call-full-speaker" aria-hidden="true"><bdi>{{ fullSpeaker }}</bdi></span>
    </Transition>
    <div class="call-full-bar top">
      <span class="call-full-name">
        <ScreenShare v-if="fullTile.kind === 'screen'" :size="16" aria-hidden="true" />
        <bdi>{{ fullTile.kind === 'screen' ? t('screenOf', { name: fullTile.name }) : fullTile.name }}</bdi>
      </span>
      <span class="call-full-actions">
        <button v-if="fullTile.kind === 'screen'" class="call-full-btn" type="button" :aria-pressed="darkScreen" @click="toggleDarkScreen()">
          <Sun v-if="darkScreen" :size="18" /><Moon v-else :size="18" />{{ darkScreen ? t('lightScreen') : t('darkScreen') }}
        </button>
        <button class="call-full-btn" type="button" @click="exitFullScreen"><Minimize :size="18" />{{ t('exitFullscreen') }}</button>
      </span>
    </div>
    <div class="call-full-bar bottom">
      <!-- A student can answer the teacher without leaving full screen. -->
      <button class="call-control" :class="{ off: !micOn }" type="button" :aria-pressed="micOn" :title="micOn ? t('mute') : t('unmute')" :aria-label="micOn ? t('mute') : t('unmute')" @click="setMicrophone(!micOn)">
        <Mic v-if="micOn" :size="22" /><MicOff v-else :size="22" />
      </button>
      <!-- And raise a hand without leaving it either. -->
      <button class="call-control" :class="{ on: myHandRaised }" type="button" :aria-pressed="myHandRaised" :title="handButtonLabel" :aria-label="handButtonLabel" @click="toggleHand">
        <Hand :size="22" /><span v-if="myHandTurn" class="call-hand-turn">{{ myHandTurn }}</span>
      </button>
      <button v-if="fullZoomed" class="call-full-btn" type="button" @click="fullTileView?.resetZoom()"><ZoomOut :size="18" />{{ t('zoomOut') }}</button>
      <!-- The blackboard's pen, eraser and save, beside the microphone (see board.ts). -->
      <template v-if="fullTile.kind === 'screen' && !fullTile.local">
        <button v-if="penOn && fullDrawn" class="call-full-btn" type="button" :title="t('eraseBoard')" :aria-label="t('eraseBoard')" @click="erase(fullTile.key)"><Eraser :size="18" /></button>
        <button class="call-full-btn" :class="{ on: penOn }" type="button" :aria-pressed="penOn" @click="penOn = !penOn"><Pencil :size="18" />{{ penOn ? t('stopDrawing') : t('draw') }}</button>
        <button v-if="canSavePicture" class="call-full-btn" type="button" :title="t('savePicture')" :aria-label="t('savePicture')" @click="savePicture(fullTile)"><Download :size="18" /></button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Full screen: one video over the whole app, with bars that fade away and come back with a tap. */
.call-full-spot {
  min-width: 0;
  min-height: 0;
  display: grid;
}

.call-full {
  position: fixed;
  inset: 0;
  z-index: 5;
  display: grid;
  background: #000000;
}

.call-full-bar {
  position: absolute;
  inset-inline: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left));
  pointer-events: none;
}

.call-full-bar > * {
  pointer-events: auto;
}

.call-full-speaker {
  max-width: 40%;
  position: absolute;
  bottom: max(10px, env(safe-area-inset-bottom));
  inset-inline-start: max(10px, env(safe-area-inset-left));
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  padding: 2px 8px;
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.3);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
  pointer-events: none;
}

/* Above the bottom bar. */
.call-full .call-full-speaker {
  bottom: calc(max(14px, env(safe-area-inset-bottom)) + 64px);
}

.call-full-speaker::before {
  content: '';
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: var(--speaking);
}

.call-full-speaker-enter-active,
.call-full-speaker-leave-active {
  transition: opacity 300ms ease;
}

.call-full-speaker-enter-from,
.call-full-speaker-leave-to {
  opacity: 0;
}

.call-full-btn.on {
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.call-full-bar.top {
  top: 0;
  justify-content: space-between;
  padding-top: max(12px, env(safe-area-inset-top));
  background: linear-gradient(rgba(0, 0, 0, 0.55), transparent);
}

.call-full-bar.bottom {
  bottom: 0;
  justify-content: center;
  padding-bottom: max(14px, env(safe-area-inset-bottom));
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.55));
}

.call-full-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.call-full-name {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  padding: 6px 10px;
  border-radius: var(--radius);
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.call-full-name bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.call-full-btn {
  min-height: 42px;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 999px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 14px;
  font-weight: 600;
}

.call-full-btn:hover {
  background: rgba(0, 0, 0, 0.8);
}
</style>
