import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from '../i18n';
import { bridge } from '../nativeScreenShare';
import { inMiniWindow, setMiniWindow } from '../nativeCall';
import { saveToGallery, tabletBoardAvailable } from '../nativeBoard';
import type CallTile from '../components/CallTile.vue';
import type { Tile } from '../components/CallTile.vue';
import { onPhone, watchable, type FullScreen } from './fullScreen';
import type { CallState } from './context';

// Where each tile is shown: the grid, the big spot with the strip beside it, full screen, or the
// Android app's small window.

// Each tile's video is made once and moved between the grid, the big spot, full screen and the
// Android app's small window, never made anew. A new video stays empty until the picture next
// changes, which for a teacher's still screen can take a long time, so students used to wait
// for the screen after going in or out of full screen. Hidden tiles wait in a hidden holder.
export type TileSpot = 'grid' | 'focus' | 'strip' | 'full' | 'mini' | 'parked';

// A picture of a shared screen, with what is drawn on it. The Android app puts it in the gallery;
// a phone's browser offers its own share sheet, where "Save image" keeps it in the photos; a
// computer downloads it. An Android app from before the blackboard cannot save, so it shows no button.
export const canSavePicture = !bridge || tabletBoardAvailable;

// Only the shape matters, so a smaller copy of the same picture, sent on weak internet, changes nothing.
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export function useTileLayout(state: CallState, fullScreen: FullScreen, showToast: (message: string) => void) {
  const { t } = useI18n();
  const { tiles, focusedKey, participants, status, error, sharingScreen } = state;
  const { fullKey, fullTile, fullTileView } = fullScreen;
  const lastSpeakerKey = ref('');

  const focusedTile = computed(() => tiles.value.find(tile => tile.key === focusedKey.value) ?? null);
  const otherTiles = computed(() => tiles.value.filter(tile => tile.key !== focusedKey.value));
  function spotOf(tile: Tile): TileSpot {
    if (inMiniWindow.value) return tile.key === miniTile.value?.key && status.value === 'connected' ? 'mini' : 'parked';
    if (error.value || status.value === 'disconnected' || status.value === 'joining') return 'parked';
    if (fullTile.value) return tile.key === fullTile.value.key ? 'full' : 'parked';
    if (focusedTile.value) return tile.key === focusedTile.value.key ? 'focus' : 'strip';
    return 'grid';
  }
  function onTileClick(tile: Tile) {
    const spot = spotOf(tile);
    // A full-screen tile keeps its buttons showing, so a tap on it does nothing.
    if (spot !== 'full' && spot !== 'mini') toggleFocus(tile.key);
  }
  function toggleFocus(key: string) { focusedKey.value = focusedKey.value === key ? null : key; }
  const tileViews = new Map<string, InstanceType<typeof CallTile>>();
  function setTileView(tile: Tile, view: unknown) {
    if (view) tileViews.set(tile.key, view as InstanceType<typeof CallTile>); else tileViews.delete(tile.key);
    if (tile.key === fullKey.value) fullTileView.value = (view ?? undefined) as InstanceType<typeof CallTile> | undefined;
  }
  // What Full screen in the More menu shows: the big tile, else a shared screen, else a camera.
  const fullScreenChoice = computed(() => {
    const videos = tiles.value.filter(watchable);
    return videos.find(tile => tile.key === focusedKey.value) ?? videos.find(tile => tile.kind === 'screen')
      ?? videos.find(tile => !tile.local) ?? videos[0] ?? null;
  });

  // Columns grow with the number of tiles, so everyone stays as large as the screen allows; a phone
  // held upright stacks them instead.
  const narrow = ref(window.innerWidth < 700);
  function onResize() { narrow.value = window.innerWidth < 700; }
  const gridStyle = computed(() => {
    const count = Math.max(1, tiles.value.length);
    const columns = narrow.value ? (count <= 2 ? 1 : 2) : Math.ceil(Math.sqrt(count));
    return { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(count / columns)}, minmax(0, 1fr))` };
  });

  // The one video the Android app shows in its small window over other apps: the one made big, else
  // a shared screen, else whoever spoke last with their camera on. Never your own video, and nothing
  // while you share your screen, because the small window would then appear in what you share.
  const miniTile = computed(() => {
    if (sharingScreen.value) return null;
    const watchable = tiles.value.filter(tile => !tile.local && tile.track);
    return watchable.find(tile => tile.key === focusedKey.value) ?? watchable.find(tile => tile.kind === 'screen')
      ?? watchable.find(tile => tile.key === lastSpeakerKey.value) ?? watchable[0] ?? null;
  });
  const miniSpeaker = computed(() => participants.value.find(person => person.speaking && !person.local) ?? null);
  // Tells the Android app whether to shrink into the small window when its owner leaves it, and in
  // what shape. Wide or tall, the window matches the video, so none of it is cut off. The shape is
  // compared as text, so the app is only told when it really changes, not on every refresh.
  // The size of the picture each video really shows, once it has arrived. Every tile reports it, so
  // the small window has the right shape as soon as it opens, rather than changing shape once showing.
  const videoSizes = shallowRef<Record<string, { width: number; height: number }>>({});
  function onVideoSize(tile: Tile, size: { width: number; height: number }) {
    const known = videoSizes.value[tile.key];
    if (known?.width === size.width && known.height === size.height) return;
    videoSizes.value = { ...videoSizes.value, [tile.key]: size };
  }
  const miniShape = computed(() => {
    const tile = miniTile.value;
    if (!tile) return '';
    const size = videoSizes.value[tile.key] ?? tile.dimensions
      ?? (tile.kind === 'screen' ? { width: 16, height: 9 } : { width: 4, height: 3 });
    const divisor = gcd(Math.round(size.width), Math.round(size.height)) || 1;
    return `${Math.round(size.width) / divisor}x${Math.round(size.height) / divisor}`;
  });
  function tellMiniShape() {
    const [width, height] = miniShape.value.split('x').map(Number);
    setMiniWindow(miniShape.value ? { width, height } : null);
  }
  watch(miniShape, tellMiniShape);

  async function savePicture(tile: Tile) {
    const picture = tileViews.get(tile.key)?.picture();
    if (!picture) return;
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const name = `${t('appName')} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    try {
      if (tabletBoardAvailable) {
        await saveToGallery(picture.toDataURL('image/png').split(',')[1], name);
        showToast(t('pictureSaved'));
        return;
      }
      const blob = await new Promise<Blob | null>(resolve => picture.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('No picture');
      const file = new File([blob], `${name}.png`, { type: 'image/png' });
      if (onPhone() && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      showToast(t('pictureSaved'));
    } catch (cause) {
      // Closing the share sheet without choosing is not a failure.
      if ((cause as Error | null)?.name !== 'AbortError') showToast(t('pictureNotSaved'));
    }
  }

  return {
    lastSpeakerKey, focusedTile, otherTiles, spotOf, onTileClick, toggleFocus, setTileView, fullScreenChoice,
    gridStyle, miniTile, miniSpeaker, onVideoSize, tellMiniShape, savePicture,
    start() { window.addEventListener('resize', onResize); },
    dispose() { window.removeEventListener('resize', onResize); },
  };
}
export type TileLayout = ReturnType<typeof useTileLayout>;
