<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Maximize2, MicOff, Minimize2, ScreenShare } from 'lucide-vue-next';
import type { VideoTrack } from 'livekit-client';
import { useI18n } from '../i18n';
import Avatar from './Avatar.vue';

export interface Tile {
  key: string;
  identity: string;
  name: string;
  color: string;
  kind: 'camera' | 'screen';
  local: boolean;
  track: VideoTrack | null;
  micOn: boolean;
  speaking: boolean;
  hand: boolean;
}

const props = defineProps<{ tile: Tile; focused: boolean; small?: boolean }>();
const emit = defineEmits<{ focus: [] }>();
const { t } = useI18n();
const video = ref<HTMLVideoElement>();
let attached: VideoTrack | null = null;

// A tile keeps its video element while the track behind it changes, for example when a camera is
// turned off and on again, so the old track is let go before the new one is shown.
function show(track: VideoTrack | null) {
  if (attached && video.value) attached.detach(video.value);
  attached = null;
  // Your own shared screen is not shown back to you: it would repeat itself endlessly on the screen being shared.
  if (!track || !video.value || (props.tile.local && props.tile.kind === 'screen')) return;
  track.attach(video.value);
  attached = track;
}
watch([() => props.tile.track, video], ([track]) => show(track), { immediate: true });
onBeforeUnmount(() => show(null));
</script>

<template>
  <div
    class="call-tile"
    :class="[tile.kind, { speaking: tile.speaking && tile.kind === 'camera', focused, small, mirrored: tile.local && tile.kind === 'camera' }]"
  >
    <video v-show="tile.track && !(tile.local && tile.kind === 'screen')" ref="video" autoplay playsinline muted />
    <div v-if="tile.local && tile.kind === 'screen'" class="call-tile-placeholder">
      <ScreenShare :size="small ? 22 : 34" />
      <span>{{ t('youAreSharing') }}</span>
    </div>
    <div v-else-if="!tile.track" class="call-tile-placeholder">
      <Avatar :name="tile.name" :color="tile.color" :size="small ? 'small' : 'large'" />
    </div>
    <div class="call-tile-label">
      <span v-if="tile.hand" aria-hidden="true">✋</span>
      <MicOff v-if="tile.kind === 'camera' && !tile.micOn" :size="14" class="call-tile-muted" />
      <ScreenShare v-if="tile.kind === 'screen'" :size="14" />
      <bdi>{{ tile.kind === 'screen' ? t('screenOf', { name: tile.name }) : tile.name }}</bdi>
    </div>
    <button
      v-if="!small"
      class="call-tile-focus"
      type="button"
      :title="focused ? t('showEveryone') : t('makeBig')"
      :aria-label="focused ? t('showEveryone') : t('makeBig')"
      @click.stop="emit('focus')"
    >
      <Minimize2 v-if="focused" :size="16" />
      <Maximize2 v-else :size="16" />
    </button>
  </div>
</template>

<style scoped>
.call-tile {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-radius: 10px;
  background: #2b2d31;
  cursor: pointer;
}

.call-tile.speaking {
  box-shadow: inset 0 0 0 3px #23a55a;
}

.call-tile video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  background: #000000;
}

/* A shared screen is shown whole, never cropped, so its text stays readable. */
.call-tile.screen video,
.call-tile.focused video {
  object-fit: contain;
}

/* Your own camera is shown like a mirror, as every video call app does. */
.call-tile.mirrored video {
  transform: scaleX(-1);
}

.call-tile-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #b5bac1;
  font-size: 13px;
  text-align: center;
}

.call-tile-label {
  max-width: calc(100% - 16px);
  position: absolute;
  bottom: 8px;
  inset-inline-start: 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.call-tile-label bdi {
  overflow: hidden;
  text-overflow: ellipsis;
}

.call-tile-muted {
  color: #f23f43;
}

.call-tile-focus {
  width: 32px;
  height: 32px;
  position: absolute;
  top: 8px;
  inset-inline-end: 8px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.55);
  opacity: 0;
  transition: opacity 160ms ease;
}

.call-tile:hover .call-tile-focus,
.call-tile-focus:focus-visible {
  opacity: 1;
}

/* Touch screens have no hover, so the button stays visible there. */
@media (hover: none) {
  .call-tile-focus {
    opacity: 0.85;
  }
}

.call-tile.small .call-tile-label {
  bottom: 4px;
  inset-inline-start: 4px;
  padding: 2px 6px;
  font-size: 11px;
}
</style>
