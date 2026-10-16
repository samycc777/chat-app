import { computed, ref, watch, type Ref } from 'vue';
import { useI18n } from '../i18n';
import { bridge } from '../nativeScreenShare';
import { onPhoneFullScreenExit, phoneFullScreenAvailable, setPhoneFullScreen } from '../nativeCall';
import type CallTile from '../components/CallTile.vue';
import type { Tile } from '../components/CallTile.vue';
import type { CallState } from './context';

// Full screen shows one video alone on the whole screen, with a bar of buttons that comes back with
// a tap. On a phone, a wide video also turns the screen sideways, as YouTube does.

const ZOOM_HINT_KEY = 'zoomHintSeen';
const DARK_SCREEN_KEY = 'darkScreen';
// Inside the phone apps, Capacitor cancels a page's full screen as soon as it starts, so there the
// call fills the app itself, and the Android app hides the phone's bars.
const browserFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled && !bridge;

// A tile with a video to look at; your own shared screen is never shown back to you.
export const watchable = (tile: Tile) => Boolean(tile.track) && !(tile.local && tile.kind === 'screen');
export const onPhone = () => Math.min(window.screen.width, window.screen.height) < 600;

export function useFullScreen(state: CallState, options: {
  root: Ref<HTMLElement | undefined>;
  visible: () => boolean;
  showToast: (message: string) => void;
}) {
  const { t } = useI18n();
  const { sheet, focusedKey, tiles, participants } = state;
  // The tile shown full screen, alone over everything else.
  const fullKey = ref<string | null>(null);
  const fullTileView = ref<InstanceType<typeof CallTile>>();
  const fullTile = computed(() => tiles.value.find(tile => tile.key === fullKey.value) ?? null);
  const fullZoomed = computed(() => Boolean(fullTileView.value?.zoomed));
  const phoneFullScreenListener = onPhoneFullScreenExit(() => exitFullScreen());

  function wantsLandscape() {
    const size = fullTile.value?.dimensions;
    return onPhone() && Boolean(size && size.width > size.height);
  }
  // Dark screen is each viewer's own choice, remembered on this device, for anyone who finds the
  // teacher's white pages too bright; it only changes how the screen is drawn here.
  const darkScreen = ref((() => { try { return localStorage.getItem(DARK_SCREEN_KEY) === '1'; } catch { return false; } })());
  function toggleDarkScreen() {
    darkScreen.value = !darkScreen.value;
    try { localStorage.setItem(DARK_SCREEN_KEY, darkScreen.value ? '1' : '0'); } catch { /* Private browsing: the choice lasts for this call. */ }
  }

  async function enterFullScreen(key: string) {
    sheet.value = null;
    focusedKey.value = key;
    fullKey.value = key;
    showZoomHint();
    if (phoneFullScreenAvailable) { setPhoneFullScreen(true, wantsLandscape()); return; }
    if (!browserFullscreen || document.fullscreenElement) return;
    // Without a tap, as when the phone is turned sideways, the browser refuses; the call still fills the page.
    try { await options.root.value?.requestFullscreen(); } catch { return; }
    turnSideways();
  }
  function exitFullScreen() {
    if (!fullKey.value) return;
    // Otherwise the next full screen would open zoomed in where this one was left.
    fullTileView.value?.resetZoom();
    fullKey.value = null;
    if (phoneFullScreenAvailable) setPhoneFullScreen(false, false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    try { screen.orientation?.unlock(); } catch { /* Nothing was locked. */ }
  }
  // Only phone browsers in full screen can be turned sideways, and Chrome on Android is the one that does.
  function turnSideways() {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (to: string) => Promise<void> };
    if (wantsLandscape()) orientation?.lock?.('landscape').catch(() => {});
    else try { orientation?.unlock(); } catch { /* Nothing was locked. */ }
  }
  // The teacher may turn the tablet while it is shown full screen.
  watch(wantsLandscape, () => {
    if (!fullKey.value) return;
    if (phoneFullScreenAvailable) setPhoneFullScreen(true, wantsLandscape());
    else if (document.fullscreenElement) turnSideways();
  });
  // Leaving the browser's full screen, for example with Escape or the Back gesture, leaves the call's too.
  function onFullscreenChange() { if (!document.fullscreenElement) exitFullScreen(); }
  watch(options.visible, visible => { if (!visible) exitFullScreen(); });
  // Once per device, the first time, so everyone learns that the teacher's writing can be made bigger.
  function showZoomHint() {
    try {
      if (localStorage.getItem(ZOOM_HINT_KEY)) return;
      localStorage.setItem(ZOOM_HINT_KEY, '1');
    } catch { return; }
    options.showToast(t(window.matchMedia('(pointer: coarse)').matches ? 'pinchToZoom' : 'scrollToZoom'));
  }

  // In full screen nobody's tile is visible, so the name of whoever is talking shows, small and
  // faint, in a corner. It stays a moment after they stop, so pauses between words don't make it
  // blink.
  const fullSpeaker = ref('');
  let fullSpeakerTimer: ReturnType<typeof setTimeout> | undefined;
  watch(() => participants.value.find(person => person.speaking && !person.local)?.name ?? '', name => {
    clearTimeout(fullSpeakerTimer);
    if (name) fullSpeaker.value = name;
    else fullSpeakerTimer = setTimeout(() => { fullSpeaker.value = ''; }, 1200);
  });

  return {
    fullKey, fullTileView, fullTile, fullZoomed, fullSpeaker, darkScreen, toggleDarkScreen, enterFullScreen, exitFullScreen,
    start() { document.addEventListener('fullscreenchange', onFullscreenChange); },
    dispose() {
      clearTimeout(fullSpeakerTimer);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      void phoneFullScreenListener?.remove();
    },
  };
}
export type FullScreen = ReturnType<typeof useFullScreen>;
