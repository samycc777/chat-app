// The Android app's own code for the blackboard (mobile/android/.../BoardPlugin.kt). While the
// teacher shares his tablet's screen he is looking at his book, not at this page, so the app draws
// what others point at and draw on top of every other app. Android asks once for "Display over
// other apps" before it may. The same code saves pictures into the phone's gallery, which a page
// inside an app cannot do by itself.
import { bridge } from './nativeScreenShare';

export type TabletBoard = { strokes: { color: string; points: number[] }[]; pointers: { x: number; y: number; color: string; name: string }[] };

// An app installed before the blackboard existed has the bridge but not this code.
export const tabletBoardAvailable = Boolean(bridge?.PluginHeaders?.some(plugin => plugin.name === 'Board'));

export async function canDrawOverApps() {
  if (!tabletBoardAvailable) return false;
  try { return Boolean(((await bridge!.nativePromise('Board', 'canDraw')) as { allowed?: boolean }).allowed); } catch { return false; }
}
/** Opens Android's "Display over other apps" switch for the app. */
export function askToDrawOverApps() {
  return bridge!.nativePromise('Board', 'askToDraw').catch(() => {});
}
/** Called when the person comes back from that switch, with whether it is now on. */
export function onDrawOverAppsChanged(callback: (allowed: boolean) => void) {
  return bridge?.addListener('Board', 'drawPermission', data => callback(Boolean(data.allowed)));
}
export function showOnTablet(board: TabletBoard) {
  return bridge!.nativePromise('Board', 'show', board);
}
export function hideOnTablet() {
  return tabletBoardAvailable ? bridge!.nativePromise('Board', 'hide').catch(() => {}) : Promise.resolve();
}
/** Saves a PNG picture (base64, without the data: prefix) into the phone's gallery. */
export function saveToGallery(data: string, name: string) {
  return bridge!.nativePromise('Board', 'savePicture', { data, name });
}
