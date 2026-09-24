// Android silences an app's microphone and sound once another app is in front, unless the app shows
// a notification that it is in a call. The Android app does that with its own code
// (mobile/android/.../CallPlugin.kt), which the call screen switches on and off here.
import { bridge } from './nativeScreenShare';

// An app installed before this existed has the bridge but not the plugin; its calls still stop in
// the background until the new app is installed.
const available = Boolean(bridge?.PluginHeaders?.some(plugin => plugin.name === 'Call'));

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
