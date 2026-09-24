// Android silences an app's microphone and sound once another app is in front, unless the app shows
// a notification that it is in a call. The Android app does that with its own code
// (mobile/android/.../CallPlugin.kt), which the call screen switches on and off here. The same code
// shrinks the app into a small window over the other apps while there is a video to watch.
import { ref } from 'vue';
import { bridge } from './nativeScreenShare';

// An app installed before this existed has the bridge but not the plugin; its calls still stop in
// the background until the new app is installed.
const available = Boolean(bridge?.PluginHeaders?.some(plugin => plugin.name === 'Call'));

/** True while the app is shrunk into the small window over other apps. */
export const inMiniWindow = ref(false);
if (available) bridge!.addListener('Call', 'miniWindow', data => { inMiniWindow.value = data.active === true; });

/** Keeps the call going in the background. Call it again once the microphone is allowed. */
export function keepPhoneCallGoing() {
  // Android only lets the app claim the microphone while it is on screen.
  if (!available || document.visibilityState !== 'visible') return;
  void bridge!.nativePromise('Call', 'start').catch(() => {});
}
export function endPhoneCall() {
  if (available) void bridge!.nativePromise('Call', 'stop').catch(() => {});
}
/** Called when the person taps Leave call in the notification. */
export function onPhoneCallLeave(callback: () => void) {
  return available ? bridge!.addListener('Call', 'leave', callback) : undefined;
}
/**
 * Gives the shape of the video the small window will show, or null when there is nothing to watch
 * and leaving the app should just leave it. Apps from before the small window ignore it.
 */
export function setMiniWindow(video: { width: number; height: number } | null) {
  if (!available) return;
  const shape = video ? { width: Math.round(video.width), height: Math.round(video.height) } : {};
  void bridge!.nativePromise('Call', 'setMiniWindow', shape).catch(() => {});
}
