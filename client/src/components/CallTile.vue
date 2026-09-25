<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Maximize, Maximize2, MicOff, Minimize2, ScreenShare } from 'lucide-vue-next';
import type { VideoTrack } from 'livekit-client';
import { useI18n } from '../i18n';
import { usePinchZoom } from '../pinchZoom';
import Avatar from './Avatar.vue';

export interface Tile {
  key: string;
  identity: string;
  name: string;
  color: string;
  kind: 'camera' | 'screen';
  local: boolean;
  track: VideoTrack | null;
  /** The size the video is sent at, when known; it gives the phone's small window its shape. */
  dimensions?: { width: number; height: number };
  micOn: boolean;
  speaking: boolean;
  hand: boolean;
}

// `full` is the tile shown full screen: it fills the screen alone, can be zoomed into, and leaves
// its name and buttons to the call screen's own bar on top of it.
const props = defineProps<{ tile: Tile; focused: boolean; small?: boolean; full?: boolean }>();
const emit = defineEmits<{ focus: []; fullscreen: [] }>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
let attached: VideoTrack | null = null;
// Your own shared screen is not shown back to you: it would repeat itself endlessly on the screen being shared.
const ownScreen = computed(() => props.tile.local && props.tile.kind === 'screen');
const zoom = usePinchZoom(root, () => Boolean(props.full));
defineExpose({ resetZoom: zoom.reset, zoomed: zoom.zoomed });

// A tile keeps its video element while the track behind it changes, for example when a camera is
// turned off and on again, so the old track is let go before the new one is shown.
function show(track: VideoTrack | null) {
  if (attached && video.value) attached.detach(video.value);
  attached = null;
  zoom.reset();
  if (!track || !video.value || ownScreen.value) return;
  track.attach(video.value);
  attached = track;
}
watch([() => props.tile.track, video], ([track]) => show(track), { immediate: true });
onBeforeUnmount(() => show(null));
</script>

<template>
  <div
    ref="root"
    class="call-tile"
    :class="[tile.kind, { speaking: tile.speaking && tile.kind === 'camera' && !full, focused, small, full, mirrored: tile.local && tile.kind === 'camera' }]"
    v-on="zoom.listeners"
    @click.capture="zoom.clickCapture"
  >
    <div class="call-tile-media" :style="zoom.style.value">
      <video v-show="tile.track && !ownScreen" ref="video" autoplay playsinline muted />
    </div>
    <div v-if="ownScreen" class="call-tile-placeholder">
      <ScreenShare :size="small ? 22 : 34" />
      <span>{{ t('youAreSharing') }}</span>
    </div>
    <div v-else-if="!tile.track" class="call-tile-placeholder">
      <Avatar :name="tile.name" :color="tile.color" :size="small ? 'small' : 'large'" />
    </div>
    <div v-if="!full" class="call-tile-label">
      <span v-if="tile.hand" aria-hidden="true">✋</span>
      <MicOff v-if="tile.kind === 'camera' && !tile.micOn" :size="14" class="call-tile-muted" />
      <ScreenShare v-if="tile.kind === 'screen'" :size="14" />
      <bdi>{{ tile.kind === 'screen' ? t('screenOf', { name: tile.name }) : tile.name }}</bdi>
    </div>
    <button
      v-if="!small && !full && tile.track && !ownScreen"
      class="call-tile-button call-tile-fullscreen"
      type="button"
      :title="t('fullscreen')"
      :aria-label="t('fullscreen')"
      @click.stop="emit('fullscreen')"
    >
      <Maximize :size="16" />
    </button>
    <button
      v-if="!small && !full"
      class="call-tile-button call-tile-focus"
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

.call-tile-media,
.call-tile video {
  width: 100%;
  height: 100%;
}

.call-tile video {
  display: block;
  object-fit: cover;
  background: #000000;
}

/* Full screen: black around the video, and the fingers zoom the video instead of the page. */
.call-tile.full {
  border-radius: 0;
  background: #000000;
  cursor: default;
  touch-action: none;
  user-select: none;
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

.call-tile-button {
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

.call-tile-fullscreen {
  inset-inline-end: 48px;
}

.call-tile:hover .call-tile-button,
.call-tile-button:focus-visible {
  opacity: 1;
}

/* Touch screens have no hover, so the buttons stay visible there. */
@media (hover: none) {
  .call-tile-button {
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
