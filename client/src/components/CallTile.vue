<script lang="ts">
// The last picture of each shared screen, by tile. It lives outside the tile because a dropped
// connection removes the tile until the screen comes back.
const lastPictures = new Map<string, HTMLCanvasElement>();
const SAVE_PICTURE_EVERY_MS = 2000;
// LiveKit sends a tiny blank picture when it cuts a video off; that is not a picture of the screen.
const isRealPicture = (width: number, height: number) => width > 16 && height > 16;
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Maximize, Maximize2, MicOff, Minimize2, Moon, ScreenShare, Sun } from 'lucide-vue-next';
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
// `dark` shows a shared screen in dark colours for this viewer only; the person sharing sees nothing change.
const props = defineProps<{ tile: Tile; focused: boolean; small?: boolean; full?: boolean; dark?: boolean }>();
const emit = defineEmits<{ focus: []; fullscreen: []; darkScreen: []; videoSize: [size: { width: number; height: number }] }>();
const { t } = useI18n();
const NO_POSTER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const root = ref<HTMLElement>();
const video = ref<HTMLVideoElement>();
let attached: VideoTrack | null = null;
// Your own shared screen is not shown back to you: it would repeat itself endlessly on the screen being shared.
const ownScreen = computed(() => props.tile.local && props.tile.kind === 'screen');
const zoom = usePinchZoom(root, () => Boolean(props.full));
// The zoom belongs to full screen. Leaving the app from a zoomed-in full screen showed only that
// piece of the screen in the small window over the other apps; it now shows the whole picture
// there, and coming back to full screen finds the zoom as it was.
const zoomStyle = computed(() => props.full ? zoom.style.value : undefined);
defineExpose({ resetZoom: zoom.reset, zoomed: zoom.zoomed });

// A tile keeps its video element while the track behind it changes, for example when a camera is
// turned off and on again, so the old track is let go before the new one is shown.
function show(track: VideoTrack | null) {
  if (attached && video.value) attached.detach(video.value);
  attached = null;
  hasPicture.value = false;
  zoom.reset();
  if (!track || !video.value || ownScreen.value) return;
  track.attach(video.value);
  attached = track;
}
// The size the sender announced when they started can be wrong, for example after the teacher's
// tablet is turned, so the phone's small window takes its shape from the picture that really arrives.
function reportSize() {
  const { videoWidth: width, videoHeight: height } = video.value ?? {};
  if (width && height && isRealPicture(width, height)) emit('videoSize', { width, height });
}

// On weak internet a shared screen often has to start again: after this device's connection drops
// and comes back, when the teacher's tablet reconnects, or when the app comes back to the front.
// Its video then stays empty, a dark rectangle, until a whole new picture of the screen has
// arrived, which can take many seconds. The last picture seen is shown meanwhile, so students can
// go on reading the lesson.
const hasPicture = ref(false);
const held = ref<HTMLCanvasElement>();
const holding = computed(() => props.tile.kind === 'screen' && !ownScreen.value && Boolean(props.tile.track) && !hasPicture.value && lastPictures.has(props.tile.key));
let savedAt = 0;
let frameRequest: number | undefined;
function onFrame(_now: number, frame: VideoFrameCallbackMetadata) {
  const element = video.value;
  if (!element) return;
  frameRequest = element.requestVideoFrameCallback(onFrame);
  hasPicture.value = isRealPicture(frame.width, frame.height);
  if (!hasPicture.value || Date.now() - savedAt < SAVE_PICTURE_EVERY_MS) return;
  savedAt = Date.now();
  const copy = lastPictures.get(props.tile.key) ?? document.createElement('canvas');
  copy.width = frame.width;
  copy.height = frame.height;
  copy.getContext('2d')?.drawImage(element, 0, 0, frame.width, frame.height);
  lastPictures.set(props.tile.key, copy);
}
// Only screens are kept: a camera's last picture would show someone frozen mid-word.
watch(video, element => {
  if (element && props.tile.kind === 'screen' && !ownScreen.value && 'requestVideoFrameCallback' in element) frameRequest = element.requestVideoFrameCallback(onFrame);
}, { immediate: true });
watch([holding, held], ([hold, canvas]) => {
  const copy = lastPictures.get(props.tile.key);
  if (!hold || !canvas || !copy) return;
  canvas.width = copy.width;
  canvas.height = copy.height;
  canvas.getContext('2d')?.drawImage(copy, 0, 0);
});
watch([() => props.tile.track, video], ([track]) => show(track), { immediate: true });
onBeforeUnmount(() => {
  if (frameRequest !== undefined) video.value?.cancelVideoFrameCallback(frameRequest);
  show(null);
});
</script>

<template>
  <div
    ref="root"
    class="call-tile"
    :class="[tile.kind, { speaking: tile.speaking && tile.kind === 'camera' && !full, focused, small, full, mirrored: tile.local && tile.kind === 'camera', dark: dark && tile.kind === 'screen' }]"
    v-on="zoom.listeners"
    @click.capture="zoom.clickCapture"
  >
    <div class="call-tile-media" :style="zoomStyle">
      <!-- The empty poster replaces the grey play button Android shows until the first picture arrives. -->
      <video v-show="tile.track && !ownScreen" ref="video" autoplay playsinline muted :poster="NO_POSTER" @loadedmetadata="reportSize" @resize="reportSize" />
      <!-- Over the video rather than instead of it: a hidden video is no longer sent, so it would never come back. -->
      <canvas v-show="holding" ref="held" class="call-tile-held" />
    </div>
    <span v-if="holding" class="call-tile-waiting">{{ t('screenCatchingUp') }}</span>
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
      v-if="!small && !full && tile.kind === 'screen' && tile.track && !ownScreen"
      class="call-tile-button call-tile-dark"
      type="button"
      :aria-pressed="dark"
      :title="dark ? t('lightScreen') : t('darkScreen')"
      :aria-label="dark ? t('lightScreen') : t('darkScreen')"
      @click.stop="emit('darkScreen')"
    >
      <Sun v-if="dark" :size="16" />
      <Moon v-else :size="16" />
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
  background: var(--call-surface);
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

.call-tile-media {
  position: relative;
}

/* The last picture of the screen covers the empty video exactly, so the change is not seen. */
.call-tile-held {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: var(--call-video-bg);
}

.call-tile video {
  display: block;
  object-fit: cover;
  background: var(--call-video-bg);
}

/* Full screen: black around the video in light mode too, and the fingers zoom the video instead
   of the page. */
.call-tile.full {
  border-radius: 0;
  background: #000000;
  cursor: default;
  touch-action: none;
  user-select: none;
}

.call-tile.full video,
.call-tile.full .call-tile-held {
  background: #000000;
}

/* A shared screen is shown whole, never cropped, so its text stays readable. */
.call-tile.screen video,
.call-tile.focused video {
  object-fit: contain;
}

/* Dark screen turns white pages black and black text white; turning the hues back round keeps
   blue, red and green roughly their own colours, so the teacher's colour-coded writing still reads. */
.call-tile.dark video,
.call-tile.dark .call-tile-held {
  filter: invert(1) hue-rotate(180deg);
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
  color: var(--call-text-muted);
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

.call-tile-dark {
  inset-inline-end: 88px;
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

/* Said on the picture, so nobody waits for writing that is not coming yet. */
.call-tile-waiting {
  position: absolute;
  top: 8px;
  left: 50%;
  max-width: calc(100% - 16px);
  transform: translateX(-50%);
  padding: 3px 10px;
  border-radius: 6px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.call-tile.small .call-tile-waiting {
  display: none;
}

.call-tile.small .call-tile-label {
  bottom: 4px;
  inset-inline-start: 4px;
  padding: 2px 6px;
  font-size: 11px;
}
</style>
