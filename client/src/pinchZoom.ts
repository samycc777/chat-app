import { computed, ref, type Ref } from 'vue';

// Zooming into a video shown full screen, as in a photo app, so the teacher's small writing and
// vowel marks can be read on a phone: two fingers pinch, one finger then moves around, and a
// double tap zooms in on that spot or back out. Computers use the mouse wheel or a double click.
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
// Further than this, a touch is a drag rather than a tap.
const TAP_SLOP_PX = 10;

type Point = { x: number; y: number };

export function usePinchZoom(area: Ref<HTMLElement | undefined>, enabled: () => boolean) {
  const scale = ref(1);
  const offset = ref<Point>({ x: 0, y: 0 });
  const pointers = new Map<number, Point>();
  let pinch: { distance: number; middle: Point } | null = null;
  let downAt: Point | null = null;
  let dragged = false;
  let lastTap = { time: 0, x: 0, y: 0 };
  let lastPointerType = '';

  // The video is scaled from its top-left corner and then moved; it may never be moved so far that
  // an edge comes away from the side of the screen.
  function keepInside() {
    const box = area.value?.getBoundingClientRect();
    if (!box) return;
    offset.value = {
      x: Math.min(0, Math.max(box.width * (1 - scale.value), offset.value.x)),
      y: Math.min(0, Math.max(box.height * (1 - scale.value), offset.value.y)),
    };
  }
  // Zooms while the point under the fingers stays where it is.
  function zoomAt(next: number, clientX: number, clientY: number) {
    const box = area.value?.getBoundingClientRect();
    if (!box) return;
    const target = Math.min(MAX_SCALE, Math.max(1, next));
    const px = clientX - box.left;
    const py = clientY - box.top;
    offset.value = {
      x: px - (px - offset.value.x) * target / scale.value,
      y: py - (py - offset.value.y) * target / scale.value,
    };
    scale.value = target;
    keepInside();
  }
  function reset() {
    scale.value = 1;
    offset.value = { x: 0, y: 0 };
  }
  function toggleAt(clientX: number, clientY: number) {
    if (scale.value > 1) reset();
    else zoomAt(DOUBLE_TAP_SCALE, clientX, clientY);
  }
  function fingers() {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  function pointerdown(event: PointerEvent) {
    if (!enabled()) return;
    lastPointerType = event.pointerType;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) { downAt = { x: event.clientX, y: event.clientY }; dragged = false; }
    if (pointers.size === 2) pinch = fingers();
  }
  function pointermove(event: PointerEvent) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > TAP_SLOP_PX) dragged = true;
    if (pinch && pointers.size >= 2) {
      const now = fingers();
      zoomAt(scale.value * now.distance / pinch.distance, now.middle.x, now.middle.y);
      // Moving both fingers together also moves the video.
      offset.value = { x: offset.value.x + now.middle.x - pinch.middle.x, y: offset.value.y + now.middle.y - pinch.middle.y };
      keepInside();
      pinch = now;
    } else if (scale.value > 1) {
      offset.value = { x: offset.value.x + event.clientX - previous.x, y: offset.value.y + event.clientY - previous.y };
      keepInside();
    }
  }
  function pointerup(event: PointerEvent) {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    // A pinch that ends almost at full size snaps back to it exactly.
    if (!pointers.size && scale.value < 1.05) reset();
    if (pointers.size || dragged || event.pointerType === 'mouse' || event.type === 'pointercancel') return;
    const now = Date.now();
    if (now - lastTap.time < DOUBLE_TAP_MS && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < TAP_SLOP_PX * 3) {
      toggleAt(event.clientX, event.clientY);
      lastTap = { time: 0, x: 0, y: 0 };
    } else {
      lastTap = { time: now, x: event.clientX, y: event.clientY };
    }
  }
  // Touch screens are handled by the double tap above.
  function dblclick(event: MouseEvent) {
    if (enabled() && lastPointerType === 'mouse') toggleAt(event.clientX, event.clientY);
  }
  function wheel(event: WheelEvent) {
    if (!enabled()) return;
    event.preventDefault();
    // A trackpad pinch arrives as the wheel with ctrl held, in much smaller steps.
    zoomAt(scale.value * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
  }
  // Letting go after moving the video is not a tap on it.
  function clickCapture(event: MouseEvent) {
    if (!dragged) return;
    dragged = false;
    event.stopPropagation();
  }

  const style = computed(() => scale.value === 1 ? undefined : {
    transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value})`,
    transformOrigin: '0 0',
  });
  return {
    style,
    zoomed: computed(() => scale.value > 1),
    reset,
    listeners: { pointerdown, pointermove, pointerup, pointercancel: pointerup, dblclick, wheel },
    clickCapture,
  };
}
