<script setup lang="ts">
import { Ellipsis, Hand, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from 'lucide-vue-next';
import { useI18n } from '../i18n';
import { useCall } from '../call/context';
import { canShareScreen } from '../call/screenShare';

// The row of round buttons along the bottom of the call.
const { t } = useI18n();
const call = useCall();
const { status, micOn, cameraOn, sharingScreen, sheet } = call.state;
const { micBlocked, setMicrophone } = call.microphone;
const { toggleScreenShare } = call.screenShare;
const { myHandRaised } = call.tiles;
const { toggleCamera, toggleHand, openSheet, leave } = call;

// A disabled button gives no hint why, so while the call is still connecting its name says so.
function whileConnecting(label: string) { return status.value === 'connected' ? label : `${label} (${t('connecting')})`; }
</script>

<template>
  <footer class="call-controls">
    <button class="call-control" :class="{ off: !micOn }" type="button" :aria-pressed="micOn" :title="whileConnecting(micOn ? t('mute') : t('unmute'))" :aria-label="whileConnecting(micOn ? t('mute') : t('unmute'))" :aria-describedby="micBlocked ? 'call-mic-hint' : undefined" :disabled="status !== 'connected'" @click="setMicrophone(!micOn)">
      <Mic v-if="micOn" :size="22" /><MicOff v-else :size="22" />
    </button>
    <button class="call-control" :class="{ on: cameraOn }" type="button" :aria-pressed="cameraOn" :title="whileConnecting(cameraOn ? t('cameraOff') : t('cameraOn'))" :aria-label="whileConnecting(cameraOn ? t('cameraOff') : t('cameraOn'))" :disabled="status !== 'connected'" @click="toggleCamera">
      <Video v-if="cameraOn" :size="22" /><VideoOff v-else :size="22" />
    </button>
    <button v-if="canShareScreen" class="call-control" :class="{ on: sharingScreen }" type="button" :aria-pressed="sharingScreen" :title="whileConnecting(sharingScreen ? t('stopSharing') : t('shareScreen'))" :aria-label="whileConnecting(sharingScreen ? t('stopSharing') : t('shareScreen'))" :disabled="status !== 'connected'" @click="toggleScreenShare">
      <ScreenShareOff v-if="sharingScreen" :size="22" /><ScreenShare v-else :size="22" />
    </button>
    <button class="call-control" :class="{ on: myHandRaised }" type="button" :aria-pressed="myHandRaised" :title="myHandRaised ? t('lowerHand') : t('raiseHand')" :aria-label="myHandRaised ? t('lowerHand') : t('raiseHand')" @click="toggleHand">
      <Hand :size="22" />
    </button>
    <button class="call-control" type="button" :aria-pressed="sheet === 'more'" :title="t('more')" :aria-label="t('more')" @click="openSheet('more')">
      <Ellipsis :size="22" />
    </button>
    <button class="call-control leave" type="button" :title="t('disconnect')" :aria-label="t('disconnect')" @click="leave">
      <PhoneOff :size="22" />
    </button>
  </footer>
</template>

<style scoped>
.call-controls {
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  gap: 10px;
  padding: 10px 12px max(12px, env(safe-area-inset-bottom));
  background: var(--call-bg);
}

/* On joining, the buttons spring up one after another. */
.call-controls > * {
  animation: anime-rise 480ms var(--spring) both;
}

.call-controls > :nth-child(1) { animation-delay: 250ms; }
.call-controls > :nth-child(2) { animation-delay: 290ms; }
.call-controls > :nth-child(3) { animation-delay: 330ms; }
.call-controls > :nth-child(4) { animation-delay: 370ms; }
.call-controls > :nth-child(5) { animation-delay: 410ms; }
.call-controls > :nth-child(6) { animation-delay: 450ms; }

@media (max-width: 768px) {
  .call-controls {
    gap: 8px;
  }
}
</style>
