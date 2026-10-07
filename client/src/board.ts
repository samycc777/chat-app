import { ref } from 'vue';

// The blackboard: anyone in a call can point at a shared screen or draw on it, and everyone sees
// it, as students would at the front of a classroom. Drawings stay until someone erases them;
// a point shows where for a few seconds, with the name of who is pointing.
//
// Everything travels between people as small LiveKit messages (see CallView.vue). Positions are
// fractions of the shared screen's picture, so a drawing lands on the same word on every device,
// whatever its size, and on the teacher's own tablet when the Android app draws it over his book
// (see nativeBoard.ts). That is also why the sizes below are fractions of the picture: the tablet
// draws the same shapes, and its drawing is part of the shared screen, so both copies must match.

export type Stroke = { id: string; color: string; points: number[] };
export type Pointer = { id: number; color: string; name: string; x: number; y: number; at: number };
type Board = { strokes: Stroke[]; pointers: Pointer[] };
export type BoardMessage =
  // `o` is where these points go in the line, so a piece that arrives twice is not added twice.
  | { t: 'line'; b: string; id: string; c: string; p: number[]; o: number }
  | { t: 'point'; b: string; c: string; x: number; y: number }
  | { t: 'erase'; b: string }
  | { t: 'hello' };

const POINTER_MS = 3000;
const POINTER_FADE_MS = 400;
// Messages carry whole numbers out of this, which keeps them short.
const GRID = 10_000;
// A very long line is cut into pieces, so no single message grows too big for LiveKit.
const MAX_POINTS = 600;
const MAX_STROKES = 400;
const COLOR = /^#[0-9a-f]{6}$/i;
// Android 12 and later only let touches through a window drawn over other apps if it is at most
// this solid, and the teacher must keep using his book under the drawings. Every copy is drawn
// the same, so the tablet's and the website's land on top of each other as one.
const OPACITY = 0.8;

const boards = new Map<string, Board>();
/** Goes up on every change, for whatever draws the boards. */
export const boardVersion = ref(0);
/** This viewer's pen: while it is on, touching a shared screen draws or points instead of zooming. */
export const penOn = ref(false);

let send: (message: BoardMessage, to?: string[]) => void = () => {};
let pointerId = 0;
let pointerTimer: ReturnType<typeof setInterval> | undefined;

export function sendBoardWith(sender: typeof send) { send = sender; }

function boardOf(key: string) {
  let board = boards.get(key);
  if (!board) { board = { strokes: [], pointers: [] }; boards.set(key, board); }
  return board;
}
export function boardStrokes(key: string): readonly Stroke[] { return boards.get(key)?.strokes ?? []; }
export function boardPointers(key: string): readonly Pointer[] { return boards.get(key)?.pointers ?? []; }
export const hasDrawings = (key: string) => boardStrokes(key).length > 0;
const changed = () => { boardVersion.value++; };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const toGrid = (points: number[]) => points.map(value => Math.round(clamp(value) * GRID));
const fromGrid = (points: unknown[]) => points.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).map(value => clamp(value / GRID));

// Returns where the points went in the line.
function addPoints(key: string, id: string, color: string, points: number[], at?: number) {
  const board = boardOf(key);
  let stroke = board.strokes.find(line => line.id === id);
  if (!stroke) {
    if (board.strokes.length >= MAX_STROKES) board.strokes.shift();
    stroke = { id, color, points: [] };
    board.strokes.push(stroke);
  }
  const start = Math.min(at ?? stroke.points.length, stroke.points.length);
  if (start / 2 < MAX_POINTS * 20) stroke.points.splice(start, points.length, ...points);
  changed();
  return start;
}

// A line being drawn is sent a few times a second, so others watch it appear.
const pending = new Map<string, { key: string; color: string; points: number[]; at: number }>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  flushTimer = undefined;
  for (const [id, line] of pending) {
    for (let start = 0; start < line.points.length; start += MAX_POINTS * 2) {
      send({ t: 'line', b: line.key, id, c: line.color, p: toGrid(line.points.slice(start, start + MAX_POINTS * 2)), o: line.at + start });
    }
  }
  pending.clear();
}
function queue(key: string, id: string, color: string, points: number[], at: number) {
  const line = pending.get(id) ?? { key, color, points: [], at };
  line.points.push(...points);
  pending.set(id, line);
  flushTimer ??= setTimeout(flush, 60);
}

export function startLine(key: string, color: string, x: number, y: number) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  queue(key, id, color, [x, y], addPoints(key, id, color, [clamp(x), clamp(y)]));
  return id;
}
export function extendLine(key: string, id: string, color: string, x: number, y: number) {
  queue(key, id, color, [x, y], addPoints(key, id, color, [clamp(x), clamp(y)]));
}

function showPointer(key: string, color: string, name: string, x: number, y: number) {
  const board = boardOf(key);
  board.pointers = [...board.pointers.filter(pointer => pointer.name !== name), { id: ++pointerId, color, name, x: clamp(x), y: clamp(y), at: Date.now() }];
  changed();
  // Old points are cleared away while any are showing.
  pointerTimer ??= setInterval(() => {
    let any = false;
    for (const each of boards.values()) {
      const kept = each.pointers.filter(pointer => Date.now() - pointer.at < POINTER_MS);
      if (kept.length !== each.pointers.length) { each.pointers = kept; changed(); }
      if (kept.length) any = true;
    }
    if (!any) { clearInterval(pointerTimer); pointerTimer = undefined; }
  }, 100);
}
export function point(key: string, color: string, name: string, x: number, y: number) {
  showPointer(key, color, name, x, y);
  send({ t: 'point', b: key, c: color, x: Math.round(clamp(x) * GRID), y: Math.round(clamp(y) * GRID) });
}
export function erase(key: string) {
  const board = boards.get(key);
  if (board) { board.strokes = []; board.pointers = []; changed(); }
  send({ t: 'erase', b: key });
}

/** Someone joining asks for what is already on the boards; one person answers (see CallView.vue). */
export function sayHello() { send({ t: 'hello' }); }
export function tellBoards(to: string) {
  for (const [key, board] of boards) {
    for (const stroke of board.strokes) {
      for (let start = 0; start < stroke.points.length; start += MAX_POINTS * 2) {
        send({ t: 'line', b: key, id: stroke.id, c: stroke.color, p: toGrid(stroke.points.slice(start, start + MAX_POINTS * 2)), o: start }, [to]);
      }
    }
  }
}

/** Takes in a message from someone else; returns true if they asked for the boards. */
export function receiveBoard(message: unknown, senderName: string): boolean {
  if (!message || typeof message !== 'object') return false;
  const data = message as Record<string, unknown>;
  if (data.t === 'hello') return true;
  if (typeof data.b !== 'string' || data.b.length > 200) return false;
  if (data.t === 'erase') {
    const board = boards.get(data.b);
    if (board) { board.strokes = []; board.pointers = []; changed(); }
  } else if (data.t === 'line' && typeof data.id === 'string' && data.id.length <= 40 && typeof data.c === 'string' && COLOR.test(data.c) && Array.isArray(data.p)) {
    const points = fromGrid(data.p.slice(0, MAX_POINTS * 2));
    const at = typeof data.o === 'number' && Number.isInteger(data.o) && data.o >= 0 ? data.o - data.o % 2 : undefined;
    if (points.length >= 2) addPoints(data.b, data.id, data.c, points.slice(0, points.length - points.length % 2), at);
  } else if (data.t === 'point' && typeof data.c === 'string' && COLOR.test(data.c) && typeof data.x === 'number' && typeof data.y === 'number') {
    showPointer(data.b, data.c, senderName, data.x / GRID, data.y / GRID);
  }
  return false;
}

/** Forgets every board, when this person leaves the call. */
export function clearBoards() {
  boards.clear();
  pending.clear();
  clearTimeout(flushTimer); flushTimer = undefined;
  clearInterval(pointerTimer); pointerTimer = undefined;
  penOn.value = false;
  changed();
}

// Drawing, shared by the layer over a shared screen and the saved picture. `frame` is where the
// shared screen's picture sits on the canvas, in canvas pixels.
type Frame = { left: number; top: number; width: number; height: number };
export function drawBoard(context: CanvasRenderingContext2D, key: string, frame: Frame, now = Date.now()) {
  const board = boards.get(key);
  if (!board) return;
  const unit = Math.min(frame.width, frame.height);
  const at = (x: number, y: number) => [frame.left + x * frame.width, frame.top + y * frame.height] as const;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = Math.max(2, 0.008 * unit);
  context.globalAlpha = OPACITY;
  for (const stroke of board.strokes) {
    context.strokeStyle = stroke.color;
    context.beginPath();
    const [x0, y0] = at(stroke.points[0], stroke.points[1]);
    context.moveTo(x0, y0);
    // A single point is drawn as a dot.
    if (stroke.points.length === 2) context.lineTo(x0 + 0.01, y0);
    for (let index = 2; index < stroke.points.length; index += 2) context.lineTo(...at(stroke.points[index], stroke.points[index + 1]));
    context.stroke();
  }
  for (const pointer of board.pointers) {
    const left = POINTER_MS - (now - pointer.at);
    if (left <= 0) continue;
    context.globalAlpha = OPACITY * Math.min(1, left / POINTER_FADE_MS);
    const [x, y] = at(pointer.x, pointer.y);
    const radius = 0.035 * unit;
    context.strokeStyle = context.fillStyle = pointer.color;
    context.lineWidth = 0.006 * unit;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(x, y, 0.008 * unit, 0, Math.PI * 2);
    context.fill();
    if (pointer.name) {
      const size = Math.max(10, 0.03 * unit);
      context.font = `bold ${size}px system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';
      // Measured from the font's own ascent and descent, as Android measures it on the tablet.
      const metrics = context.measureText(pointer.name);
      const ascent = metrics.fontBoundingBoxAscent ?? size * 0.93;
      const descent = metrics.fontBoundingBoxDescent ?? size * 0.24;
      const padX = 0.016 * unit, padY = 0.008 * unit;
      const top = y + radius + 0.012 * unit;
      context.fillStyle = 'rgba(0, 0, 0, 0.6)';
      context.beginPath();
      // Older Android system browsers have no rounded rectangles; square corners do as well there.
      const box = [x - metrics.width / 2 - padX, top - padY, metrics.width + padX * 2, ascent + descent + padY * 2] as const;
      if (context.roundRect) context.roundRect(...box, 0.012 * unit);
      else context.rect(...box);
      context.fill();
      context.fillStyle = '#ffffff';
      context.fillText(pointer.name, x, top + ascent);
    }
    context.globalAlpha = 1;
  }
}

/** Whether any pointer is still fading, so the layer keeps drawing frames until it has gone. */
export const pointersShowing = (key: string) => boardPointers(key).some(pointer => Date.now() - pointer.at < POINTER_MS);

/** The board as the Android app draws it over the teacher's tablet (see nativeBoard.ts). */
export function boardForTablet(key: string) {
  return {
    strokes: boardStrokes(key).map(stroke => ({ color: stroke.color, points: stroke.points })),
    pointers: boardPointers(key).filter(pointer => Date.now() - pointer.at < POINTER_MS).map(({ x, y, color, name }) => ({ x, y, color, name })),
  };
}
