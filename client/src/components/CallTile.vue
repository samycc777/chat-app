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
import { Download, Eraser, Maximize, Maximize2, MicOff, Minimize2, Moon, Pencil, ScreenShare, Sun, WifiOff } from 'lucide-vue-next';
import type { VideoTrack } from 'livekit-client';
import { useI18n } from '../i18n';
import { usePinchZoom } from '../pinchZoom';
import Avatar from './Avatar.vue';
import BoardLayer from './BoardLayer.vue';
import { boardVersion, drawBoard, erase, hasDrawings, penOn } from '../board';

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
  /** Their internet has been weak for a few seconds. */
  weak?: boolean;
}

// `full` is the tile shown full screen: it fills the screen alone, can be zoomed into, and leaves
// its name and buttons to the call screen's own bar on top of it.
// `dark` shows a shared screen in dark colours for this viewer only; the person sharing sees nothing change.
// `me` is who is watching, for the colour and name of what they draw on a shared screen. `canSave`
// says whether this device can keep a picture of a shared screen.
const props = defineProps<{ tile: Tile; focused: boolean; small?: boolean; full?: boolean; dark?: boolean; me?: { color: string; name: string }; canSave?: boolean }>();
const emit = defineEmits<{ focus: []; fullscreen: []; darkScreen: []; videoSize: [size: { width: number; height: number }]; save: [] }>();
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
// Someone else's shared screen is a blackboard: they can point at it and draw on it (see board.ts).
const isBoard = computed(() => props.tile.kind === 'screen' && !ownScreen.value && Boolean(props.tile.track) && Boolean(props.me));
// The pen and eraser show on a shared screen made big; small tiles have no room for them, and full
// screen has them in the call screen's own bar.
const boardTools = computed(() => isBoard.value && props.focused && !props.full && !props.small);
const drawn = computed(() => { void boardVersion.value; return hasDrawings(props.tile.key); });
// A picture of the shared screen as it is now, with what is drawn on it, at the size it was sent.
function picture() {
  const element = video.value;
  const source = holding.value ? lastPictures.get(props.tile.key) : element;
  const width = holding.value ? source?.width : element?.videoWidth;
  const height = holding.value ? source?.height : element?.videoHeight;
  if (!source || !width || !height) return null;
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const context = copy.getContext('2d');
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  drawBoard(context, props.tile.key, { left: 0, top: 0, width, height });
  return copy;
}
defineExpose({ resetZoom: zoom.reset, zoomed: zoom.zoomed, picture });
// The page does not zoom (see index.html), so pinching a shared screen to read it opens it full
// screen, where the pinch zooms the screen itself.
function pinchToFullScreen(event: TouchEvent) {
  if (event.touches.length >= 2 && !props.full && props.tile.kind === 'screen' && props.tile.track && !ownScreen.value) emit('fullscreen');
}

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
    @touchstart.passive="pinchToFullScreen"
  >
    <div class="call-tile-media" :style="zoomStyle">
      <!-- The empty poster replaces the grey play button Android shows until the first picture arrives. -->
      <video v-show="tile.track && !ownScreen" ref="video" autoplay playsinline muted :poster="NO_POSTER" @loadedmetadata="reportSize" @resize="reportSize" />
      <!-- Over the video rather than instead of it: a hidden video is no longer sent, so it would never come back. -->
      <canvas v-show="holding" ref="held" class="call-tile-held" />
      <BoardLayer v-if="isBoard && me" :board-key="tile.key" :video="video" :color="me.color" :name="me.name" :drawable="(focused || Boolean(full)) && !small" />
    </div>
    <div v-if="boardTools" class="call-tile-board" @click.stop>
      <button v-if="penOn && drawn" class="call-tile-board-btn" type="button" :title="t('eraseBoard')" :aria-label="t('eraseBoard')" @click="erase(tile.key)">
        <Eraser :size="17" />
      </button>
      <button class="call-tile-board-btn" :class="{ on: penOn }" type="button" :aria-pressed="penOn" @click="penOn = !penOn">
        <Pencil :size="17" />{{ penOn ? t('stopDrawing') : t('draw') }}
      </button>
      <button v-if="canSave" class="call-tile-board-btn" type="button" :title="t('savePicture')" :aria-label="t('savePicture')" @click="emit('save')">
        <Download :size="17" />
      </button>
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
      <span v-if="tile.hand" class="anime-wave" aria-hidden="true">✋</span>
      <MicOff v-if="tile.kind === 'camera' && !tile.micOn" :size="14" class="call-tile-muted" />
      <WifiOff v-if="tile.weak" :size="12" class="call-tile-weak" role="img" :aria-label="t('weakInternetOf', { name: tile.name })" />
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
  border-radius: 16px;
  background: var(--call-surface);
  cursor: pointer;
}

/* Someone who appears pops in. There is no flash of light with it, for people sensitive to
   flashing. The full screen tile is left still, so a lesson never jumps. Moving a tile to another
   place on the screen plays it again, which reads as the tile landing there. */
.call-tile:not(.full) {
  animation: call-tile-in 520ms ease-out both;
}

@keyframes call-tile-in {
  0% { opacity: 0; scale: 0.7; }
  55% { opacity: 1; scale: 1.04; }
  78% { scale: 0.985; }
  100% { scale: 1; }
}

/* Whoever is speaking glows softly green from the edges. It comes on at once, with their voice,
   and fades out gently; it stays steady through the pauses between words (see speaking.ts), so it
   does not flicker, which people sensitive to flashing find hard. Only its opacity changes, which
   phones draw cheaply over a moving video. */
.call-tile::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: inherit;
  box-shadow: inset 0 0 0 3px var(--speaking), inset 0 0 20px 1px color-mix(in srgb, var(--speaking) 55%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity 350ms ease;
}

.call-tile.speaking::after {
  opacity: 1;
  transition-duration: 80ms;
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
.call-tile.dark .call-tile-held,
.call-tile.dark :deep(.board-layer) {
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
  z-index: 2;
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
  color: #f07a72;
}

/* Small and faint on purpose: it explains a voice that cuts out without drawing attention. */
.call-tile-weak {
  flex: none;
  color: #f5c27a;
  opacity: 0.8;
}

.call-tile-button {
  width: 32px;
  height: 32px;
  position: absolute;
  top: 8px;
  inset-inline-end: 8px;
  z-index: 2;
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

/* The pen, eraser and save buttons, together at the bottom of a shared screen made big. */
.call-tile-board {
  position: absolute;
  bottom: 8px;
  inset-inline-end: 8px;
  z-index: 2;
  display: flex;
  gap: 6px;
}

.call-tile-board-btn {
  min-width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  border-radius: 12px;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.6);
  font-size: 13px;
  font-weight: 700;
}

.call-tile-board-btn.on {
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.call-tile.small {
  border-radius: 10px;
}

.call-tile.small .call-tile-label {
  bottom: 4px;
  inset-inline-start: 4px;
  padding: 2px 6px;
  font-size: 11px;
}
</style>
