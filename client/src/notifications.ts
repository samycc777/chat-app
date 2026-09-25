// Notifications when friends write or start a call (the server side is server/push.ts). Browsers
// use Web Push through the service worker in public/sw.js. The phone apps' web view has no Web Push,
// so there the app's own push plugin (@capacitor/push-notifications) gives a Firebase (Android) or
// Apple (iPhone) device token instead, which the server sends to.
import { computed, ref } from 'vue';
import type { Socket } from 'socket.io-client';
import { request } from './api';
import { bridge } from './nativeScreenShare';

export type NotifyLevel = 'all' | 'mentions' | 'off';
/**
 * What this device can do: 'web' or 'native' can be turned on; the others explain why not. An app
 * installed before notifications existed needs updating; an app built without the Firebase file, or
 * a server without the phone keys, is not ready.
 */
export type DeviceSupport = 'checking' | 'web' | 'native' | 'update-app' | 'app-not-ready' | 'iphone-home-screen' | 'unsupported';

export const support = ref<DeviceSupport>('checking');
export const permission = ref<'default' | 'granted' | 'denied'>('default');
export const level = ref<NotifyLevel>('all');
/** True once this device is registered with the server. */
export const enabledHere = ref(false);
export const busy = ref(false);
export const failed = ref(false);
/** A channel a tapped notification asked to open; App.vue opens it and clears this. */
export const channelToOpen = ref<string | null>(null);

const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* Private browsing. */ }
};

// "Not now" is remembered on this device, so the question is asked only once.
const promptDismissed = ref(stored('notify-prompt-dismissed') === '1');
export const showPrompt = computed(() => (support.value === 'web' || support.value === 'native')
  && permission.value === 'default' && level.value !== 'off' && !promptDismissed.value);
export function dismissPrompt() {
  promptDismissed.value = true;
  store('notify-prompt-dismissed', '1');
}

// A tapped notification opens the app on /?channel=<id>; the address bar is then tidied.
const url = new URL(window.location.href);
const linkedChannel = url.searchParams.get('channel');
if (linkedChannel !== null) {
  if (/^[\w-]{1,64}$/.test(linkedChannel)) channelToOpen.value = linkedChannel;
  url.searchParams.delete('channel');
  window.history.replaceState(null, '', url);
}

type Capacitor = typeof bridge & { getPlatform?: () => string };
const native = bridge as Capacitor | undefined;
const platform = native?.getPlatform?.();
const inPhoneApp = platform === 'android' || platform === 'ios';
const hasPlugin = (name: string) => Boolean(native?.PluginHeaders?.some(plugin => plugin.name === name));
const nativeKind = platform === 'ios' ? 'apns' : 'fcm';

// ---------------------------------------------------------------------------------------------
// Whether the app is in front of its owner. The server notifies only people with no such page.

let currentSocket: Socket | null = null;
let reported: boolean | null = null;
const inFront = () => document.visibilityState === 'visible' && document.hasFocus();
function reportActivity() {
  const active = inFront();
  if (!currentSocket?.connected || active === reported) return;
  reported = active;
  currentSocket.emit('app_active', { active });
}
document.addEventListener('visibilitychange', reportActivity);
window.addEventListener('focus', reportActivity);
window.addEventListener('blur', reportActivity);

// ---------------------------------------------------------------------------------------------
// Registering this device.

// i18n.ts keeps the page's language on <html lang>, which also serves code outside the components.
const pageLang = () => document.documentElement.lang === 'ar' ? 'ar' : 'en';

async function save(kind: 'web' | 'fcm' | 'apns', endpoint: string, keys?: object) {
  await request('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ kind, endpoint, keys, lang: pageLang() }) });
  store('push-endpoint', endpoint);
  enabledHere.value = true;
}

function keyBytes(base64url: string) {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

let webPublicKey = '';
async function subscribeWeb() {
  const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another server's key cannot receive this one's notifications.
  const serverKey = keyBytes(webPublicKey);
  const key = subscription?.options.applicationServerKey;
  const sameKey = key && new Uint8Array(key).length === serverKey.length && new Uint8Array(key).every((byte, index) => byte === serverKey[index]);
  if (subscription && !sameKey) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  const json = subscription.toJSON();
  await save('web', json.endpoint!, json.keys);
}

function registerNative() {
  return new Promise<void>((resolve, reject) => {
    const listeners = [
      native!.addListener('PushNotifications', 'registration', data => { finish(); save(nativeKind, String(data.value)).then(resolve, reject); }),
      native!.addListener('PushNotifications', 'registrationError', data => { finish(); reject(new Error(String(data.error))); }),
    ];
    const timer = setTimeout(() => { finish(); reject(new Error('No answer from the phone')); }, 30_000);
    function finish() { clearTimeout(timer); for (const listener of listeners) void listener.remove(); }
    native!.nativePromise('PushNotifications', 'register').catch(error => { finish(); reject(error); });
  });
}

const nativePermission = (state: unknown) => state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'default';

async function checkPermission() {
  if (support.value === 'web') permission.value = Notification.permission;
  else if (support.value === 'native') {
    const result = await native!.nativePromise('PushNotifications', 'checkPermissions') as { receive?: string };
    permission.value = nativePermission(result?.receive);
  }
}

async function detectSupport(config: { webPublicKey: string; fcm: boolean; apns: boolean }): Promise<DeviceSupport> {
  webPublicKey = config.webPublicKey;
  if (inPhoneApp) {
    if (!hasPlugin('PushNotifications')) return 'update-app';
    if (platform === 'ios') return config.apns ? 'native' : 'app-not-ready';
    // Without its Firebase file the Android app would crash on registering, so it is asked first.
    if (!hasPlugin('PushSetup')) return 'update-app';
    const status = await native!.nativePromise('PushSetup', 'status') as { firebase?: boolean };
    return status?.firebase && config.fcm ? 'native' : 'app-not-ready';
  }
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext) return 'web';
  // iPhones only allow notifications for sites added to the home screen.
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return 'iphone-home-screen';
  return 'unsupported';
}

async function subscribeHere() {
  if (support.value === 'web') await subscribeWeb();
  else if (support.value === 'native') await registerNative();
}

let listening = false;
function listenForTaps() {
  if (listening) return;
  listening = true;
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'open-channel' && typeof event.data.channelId === 'string') channelToOpen.value = event.data.channelId;
  });
  if (inPhoneApp && hasPlugin('PushNotifications')) {
    native!.addListener('PushNotifications', 'pushNotificationActionPerformed', action => {
      const channelId = (action.notification as { data?: { channelId?: unknown } } | undefined)?.data?.channelId;
      if (typeof channelId === 'string') channelToOpen.value = channelId;
    });
  }
}

// The server words notifications in the language the device uses, so it is told when that changes.
new MutationObserver(() => {
  if (enabledHere.value && permission.value === 'granted') void subscribeHere().catch(() => {});
}).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

/** Starts reporting whether the app is in front, and keeps an allowed device registered. */
export async function startNotifications(socket: Socket) {
  currentSocket = socket;
  reported = null;
  socket.on('connect', () => { reported = null; reportActivity(); });
  reportActivity();
  listenForTaps();
  try {
    const [config, me] = await Promise.all([request('/api/push/config'), request('/api/me')]);
    level.value = me.notifyLevel ?? 'all';
    support.value = await detectSupport(config);
    await checkPermission();
    // Addresses change now and then, so an allowed device registers again on every start.
    if (permission.value === 'granted') await subscribeHere();
  } catch {
    if (support.value === 'checking') support.value = 'unsupported';
  }
}

/** Asks this device for permission, which must happen right after a tap, and registers it. */
export async function turnOnHere() {
  failed.value = false;
  busy.value = true;
  try {
    if (support.value === 'web') permission.value = await Notification.requestPermission();
    else if (support.value === 'native') {
      const result = await native!.nativePromise('PushNotifications', 'requestPermissions') as { receive?: string };
      permission.value = nativePermission(result?.receive);
    }
    if (permission.value === 'granted') await subscribeHere();
  } catch {
    failed.value = true;
  } finally {
    busy.value = false;
  }
}

export async function chooseLevel(next: NotifyLevel) {
  const previous = level.value;
  level.value = next;
  try { await request('/api/push/level', { method: 'PUT', body: JSON.stringify({ level: next }) }); } catch { level.value = previous; }
}

/**
 * Signing out stops notifications on this device, so the next person here does not get the last
 * one's. The request goes out before the session is cleared.
 */
export function forgetThisDevice() {
  const endpoint = stored('push-endpoint');
  if (endpoint) void request('/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }).catch(() => {});
  store('push-endpoint', null);
  if (support.value === 'web') {
    void navigator.serviceWorker.getRegistration()
      .then(registration => registration?.pushManager.getSubscription())
      .then(subscription => subscription?.unsubscribe())
      .catch(() => {});
  }
  enabledHere.value = false;
  currentSocket = null;
}
