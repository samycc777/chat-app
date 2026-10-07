<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { boardVersion, drawBoard, extendLine, penOn, point, pointersShowing, startLine } from '../board';

// Lies over a shared screen, inside the part that zooms, so drawings stay on their word when
// someone zooms in. With the pen off, or on a small tile, it lets every touch through to the screen
// below; `drawable` is false on small tiles, which a tap makes big instead.
const props = defineProps<{ boardKey: string; video?: HTMLVideoElement; color: string; name: string; drawable: boolean }>();
const drawing = computed(() => penOn.value && props.drawable);
const canvas = ref<HTMLCanvasElement>();
// Further than this, a touch draws a line; less is a point at that spot.
const TAP_SLOP_PX = 8;

// Where the shared screen's picture sits inside the layer: the video is shown whole, so there may
// be bars beside or above it, and nothing is drawn there.
function frame(width: number, height: number) {
  const pictureWidth = props.video?.videoWidth || width;
  const pictureHeight = props.video?.videoHeight || height;
  const scale = Math.min(width / pictureWidth, height / pictureHeight);
  const shownWidth = pictureWidth * scale, shownHeight = pictureHeight * scale;
  return { left: (width - shownWidth) / 2, top: (height - shownHeight) / 2, width: shownWidth, height: shownHeight };
}

let frameRequest: number | undefined;
function draw() {
  frameRequest = undefined;
  const element = canvas.value;
  const context = element?.getContext('2d');
  if (!element || !context) return;
  const ratio = window.devicePixelRatio || 1;
  const width = element.clientWidth, height = element.clientHeight;
  if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  drawBoard(context, props.boardKey, frame(width, height));
  // A point fades away by itself, so frames keep coming until it has gone.
  if (pointersShowing(props.boardKey)) redraw();
}
function redraw() { frameRequest ??= requestAnimationFrame(draw); }
watch(boardVersion, redraw);
let resizeWatcher: ResizeObserver | undefined;
onMounted(() => {
  resizeWatcher = new ResizeObserver(redraw);
  if (canvas.value) resizeWatcher.observe(canvas.value);
  props.video?.addEventListener('resize', redraw);
  redraw();
});
watch(() => props.video, (now, before) => { before?.removeEventListener('resize', redraw); now?.addEventListener('resize', redraw); redraw(); });
onBeforeUnmount(() => {
  resizeWatcher?.disconnect();
  props.video?.removeEventListener('resize', redraw);
  if (frameRequest !== undefined) cancelAnimationFrame(frameRequest);
});

// A touch's place as a fraction of the shared picture. The layer may be zoomed, so its size on the
// screen is compared with its own size.
function place(event: PointerEvent) {
  const element = canvas.value!;
  const box = element.getBoundingClientRect();
  const width = element.clientWidth, height = element.clientHeight;
  const x = (event.clientX - box.left) * width / box.width;
  const y = (event.clientY - box.top) * height / box.height;
  const picture = frame(width, height);
  return { x: (x - picture.left) / picture.width, y: (y - picture.top) / picture.height };
}
const inside = ({ x, y }: { x: number; y: number }) => x >= 0 && x <= 1 && y >= 0 && y <= 1;

let touch: { id: number; startX: number; startY: number; line: string | null } | null = null;
function down(event: PointerEvent) {
  if (!drawing.value || touch) return;
  event.stopPropagation();
  canvas.value?.setPointerCapture(event.pointerId);
  touch = { id: event.pointerId, startX: event.clientX, startY: event.clientY, line: null };
}
function move(event: PointerEvent) {
  if (!touch || event.pointerId !== touch.id) return;
  event.stopPropagation();
  const spot = place(event);
  if (!touch.line) {
    if (Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) < TAP_SLOP_PX) return;
    if (!inside(spot)) return;
    touch.line = startLine(props.boardKey, props.color, spot.x, spot.y);
    return;
  }
  extendLine(props.boardKey, touch.line, props.color, spot.x, spot.y);
}
function up(event: PointerEvent) {
  if (!touch || event.pointerId !== touch.id) return;
  event.stopPropagation();
  const spot = place(event);
  if (!touch.line && event.type === 'pointerup' && inside(spot)) point(props.boardKey, props.color, props.name, spot.x, spot.y);
  touch = null;
}
</script>

<template>
  <canvas
    ref="canvas"
    class="board-layer"
    :class="{ pen: drawing }"
    aria-hidden="true"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
    @click="drawing && $event.stopPropagation()"
    @dblclick="drawing && $event.stopPropagation()"
    @touchstart="drawing && $event.stopPropagation()"
  />
</template>

<style scoped>
.board-layer {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* With the pen on, the layer takes the touches, and the page does not scroll or zoom under them. */
.board-layer.pen {
  pointer-events: auto;
  touch-action: none;
  cursor: crosshair;
}
</style>
