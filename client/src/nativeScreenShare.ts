// The Android app shares the screen with its own code (mobile/android/.../ScreenSharePlugin.kt),
// because a web page inside an app is not allowed to capture the screen. Capacitor puts a bridge to
// that code into the page when it runs inside the app; on a website there is no bridge.

// That code joins the call as a second participant with this suffix after its owner's ID. The
// server gives out these identities (server/voice.ts).
export const SCREEN_SUFFIX = ':screen';

type NativeError = { message?: string; code?: string };
type Bridge = {
  PluginHeaders?: { name: string }[];
  nativePromise: (plugin: string, method: string, options?: object) => Promise<unknown>;
  addListener: (plugin: string, event: string, callback: (data: Record<string, unknown>) => void) => { remove: () => Promise<void> };
};

export const bridge = (window as unknown as { Capacitor?: Bridge }).Capacitor;
// An app installed before screen sharing existed has the bridge but not the plugin.
export const phoneScreenShareAvailable = Boolean(bridge?.PluginHeaders?.some(plugin => plugin.name === 'ScreenShare'));

/** Resolves once the screen is being sent; rejects with code CANCELLED if the person said no. */
export function startPhoneScreenShare(credentials: { url: string; token: string }): Promise<unknown> {
  return bridge!.nativePromise('ScreenShare', 'start', credentials);
}
export function stopPhoneScreenShare(): Promise<unknown> {
  return bridge ? bridge.nativePromise('ScreenShare', 'stop') : Promise.resolve();
}
/** Called when sharing ends without the page asking, e.g. from the notification's Stop button. */
export function onPhoneScreenShareStopped(callback: () => void) {
  return bridge?.addListener('ScreenShare', 'stopped', callback);
}
export const wasCancelled = (cause: unknown) => (cause as NativeError | null)?.code === 'CANCELLED';
