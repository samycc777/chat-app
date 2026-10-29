<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { RotateCcw, MicOff, Volume2, WifiOff } from 'lucide-vue-next';
import { VideoPresets } from 'livekit-client';
import { usePhoto } from '../photo';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import { prepareCleanVoice } from '../cleanVoice';
import { endPhoneCall, inMiniWindow, miniWindowAvailable, onPhoneCallLeave } from '../nativeCall';
import { clearBoards } from '../board';
import { callKey, createCallState, type CallProps, type CallSession, type CallUpdate, type Sheet } from '../call/context';
import { useToasts } from '../call/toasts';
import { useSound } from '../call/sound';
import { useMicrophone } from '../call/microphone';
import { useScreenShare } from '../call/screenShare';
import { useTabletBoard } from '../call/tabletBoard';
import { useFullScreen } from '../call/fullScreen';
import { canSavePicture, useTileLayout } from '../call/layout';
import { useCallTiles } from '../call/tiles';
import { useCallChat } from '../call/chat';
import { useLiveKitRoom } from '../call/room';
import Avatar from './Avatar.vue';
import CallTile from './CallTile.vue';
import CallHeader from './CallHeader.vue';
import CallToolbar from './CallToolbar.vue';
import CallFullScreen from './CallFullScreen.vue';
import CallPeopleSheet from './CallPeopleSheet.vue';
import CallChatSheet from './CallChatSheet.vue';
import CallMoreSheet from './CallMoreSheet.vue';
import TabletPrompt from './TabletPrompt.vue';

// The call screen. Each job lives in its own composable in ../call (sound, microphone, screen
// sharing, the tablet's board, full screen, where tiles go, the tiles themselves, the chat and the
// LiveKit room), and the parts of the screen beside this file reach them through the call context.
// This file wires them together, starts and ends the call, and lays out the stage.

const props = defineProps<CallProps>();
const emit = defineEmits<{
  leave: [];
  state: [state: CallUpdate];
}>();
const { t } = useI18n();
const root = ref<HTMLElement>();
const state = createCallState();
const { status, error, micOn, cameraOn, sheet, tiles: tileList } = state;
// Vue must not wrap LiveKit's room, so it is kept, with what goes with it, in a plain object.
const session: CallSession = { room: null, disposed: false, voicesWaiting: false };

const toasts = useToasts();
const { toast, showToast } = toasts;
const sound = useSound(session, showToast);
const fullScreen = useFullScreen(state, { root, visible: () => props.visible, showToast });
const layout = useTileLayout(state, fullScreen, showToast);
const tiles = useCallTiles(session, state, {
  props, fullScreen, lastSpeakerKey: layout.lastSpeakerKey, showToast, update: update => emit('state', update),
});
const { refresh, colorOf, pictureOf } = tiles;
const microphone = useMicrophone(session, {
  state, visible: () => props.visible, audioBlocked: sound.audioBlocked, enableAudio: sound.enableAudio, showToast, refresh,
});
const screenShare = useScreenShare(session, state, { props, showToast, refresh });
const tablet = useTabletBoard(session, state, props);
const chat = useCallChat(state, props, showToast);
const room = useLiveKitRoom(session, state, {
  props, sound, microphone, tiles, tablet, tellMiniShape: layout.tellMiniShape, toggleCamera, showToast,
});
const phoneLeaveListener = onPhoneCallLeave(() => leave());

// Your photo can be changed in the call too; your tile changes once the server tells everyone.
const photo = usePhoto();
watch(photo.problem, problem => { if (problem) showToast(problem); });

// The blackboard (see board.ts): what this viewer draws carries their colour and name.
const me = computed(() => ({ color: colorOf(props.userId), name: state.participants.value.find(person => person.local)?.name ?? '' }));

async function toggleCamera() {
  if (!session.room) return;
  try {
    await session.room.localParticipant.setCameraEnabled(!cameraOn.value, { resolution: VideoPresets.h360.resolution, facingMode: 'user' });
  } catch {
    showToast(t('cameraBlocked'));
  }
  refresh();
}
function toggleHand() {
  getSocket()?.emit('raise_hand', { channelId: props.channelId, raised: !tiles.myHandRaised.value });
  sheet.value = null;
}
function openSheet(next: Sheet) { sheet.value = sheet.value === next ? null : next; }
function closeSheet() { sheet.value = null; }
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  if (sheet.value) sheet.value = null;
  else fullScreen.exitFullScreen();
}

provide(callKey, {
  props, state, toasts, sound, microphone, screenShare, tablet, fullScreen, layout, tiles, chat, room, photo,
  openSheet, closeSheet, toggleCamera, toggleHand, leave,
});

// Unpacked for the template, which only unwraps refs at the top level.
const { audioBlocked, enableAudio } = sound;
const { micBlocked } = microphone;
const { tabletPrompt } = tablet;
const { fullTile, darkScreen, toggleDarkScreen, enterFullScreen } = fullScreen;
const { focusedTile, otherTiles, gridStyle, miniTile, miniSpeaker, spotOf, onTileClick, toggleFocus, setTileView, onVideoSize, savePicture } = layout;
const { weakConnection, rejoin } = room;

function cleanup() {
  if (session.disposed) return;
  session.disposed = true;
  fullScreen.exitFullScreen();
  microphone.dispose();
  room.stopWeakTimer();
  tiles.stopWeakTimers();
  fullScreen.dispose();
  toasts.dispose();
  document.removeEventListener('keydown', onKeydown);
  room.dispose();
  layout.dispose();
  screenShare.stopPhoneShare();
  chat.dispose();
  clearBoards();
  tablet.dispose();
  screenShare.dispose();
  void phoneLeaveListener?.remove();
  endPhoneCall();
  session.room?.disconnect(); session.room = null;
  sound.removeVoices();
  tiles.stopSpeaking();
  sound.closeMixer();
}
function leave() { cleanup(); emit('leave'); }
defineExpose({ toggleMicrophone: () => microphone.setMicrophone(!micOn.value), leave });
// Zooming is only locked in the call (see the viewport tag in index.html for why); the screens
// before it can be zoomed.
const viewport = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
const zoomableViewport = viewport?.content ?? '';
onMounted(() => {
  if (viewport) viewport.content = `${zoomableViewport}, maximum-scale=1.0, user-scalable=no`;
  fullScreen.start();
  // Escape closes an open panel wherever keyboard focus happens to be.
  document.addEventListener('keydown', onKeydown);
  room.start();
  layout.start();
  sound.createMixer();
  // Fetched while the call connects, so the microphone does not wait for it.
  void prepareCleanVoice();
  void room.connect();
});
onBeforeUnmount(() => {
  if (viewport) viewport.content = zoomableViewport;
  cleanup();
});
</script>

<template>
  <section v-show="visible || inMiniWindow" ref="root" class="call-view" :class="{ mini: inMiniWindow }" :aria-label="channelName">
    <!-- The Android app's small window over other apps: just one video, or who is talking. The
         full call screen stays on the page, only hidden, and the video moves into the small window,
         so going in and out of it shows the picture straight away. -->
    <div v-if="miniWindowAvailable" v-show="inMiniWindow" class="call-mini">
      <div v-show="miniTile && status === 'connected'" id="call-spot-mini" class="call-mini-spot" />
      <div v-if="!miniTile || status !== 'connected'" class="call-mini-card">
        <Avatar v-if="miniSpeaker" :name="miniSpeaker.name" :color="colorOf(miniSpeaker.identity)" :picture="pictureOf(miniSpeaker.identity)" size="small" />
        <Volume2 v-else :size="22" aria-hidden="true" />
        <bdi>{{ miniSpeaker?.name ?? channelName }}</bdi>
      </div>
    </div>
    <div v-show="!inMiniWindow" class="call-main">
      <CallHeader />

      <main class="call-stage">
        <div v-if="error" class="call-state-card error" role="alert">
          <strong>{{ t('callJoinFailed') }}</strong>
          <p dir="auto">{{ error }}</p>
          <button class="call-state-action" type="button" @click="rejoin"><RotateCcw :size="16" />{{ t('rejoinCall') }}</button>
        </div>
        <div v-else-if="status === 'disconnected'" class="call-state-card" role="status">
          <strong>{{ t('callDisconnected') }}</strong>
          <button class="call-state-action" type="button" @click="rejoin"><RotateCcw :size="16" />{{ t('rejoinCall') }}</button>
        </div>
        <div v-else-if="status === 'joining'" class="call-state-card" role="status">
          <strong>{{ t('joiningCall') }}</strong>
        </div>
        <CallFullScreen v-else-if="fullTile" />
        <template v-else-if="focusedTile">
          <div id="call-spot-focus" class="call-focus" />
          <div v-show="otherTiles.length" id="call-spot-strip" class="call-strip" />
        </template>
        <div v-else id="call-spot-grid" class="call-grid" :style="gridStyle" />
        <p v-if="status === 'reconnecting'" class="call-pill call-reconnecting" role="status">{{ t('callReconnecting') }}</p>
        <p v-else-if="weakConnection && status === 'connected'" class="call-pill call-weak" role="status"><WifiOff :size="16" aria-hidden="true" />{{ t('weakConnection') }}</p>
      </main>

      <button v-if="audioBlocked" class="call-pill call-sound-pill" type="button" @click="enableAudio">
        <Volume2 :size="17" />{{ t('tapToEnableSound') }}
      </button>
      <!-- Always in the page, empty when there is nothing to say: a screen reader only announces
           changes to a live region that already exists. -->
      <div v-show="toast" class="call-pill call-toast" role="status"><bdi>{{ toast }}</bdi></div>
      <p v-if="micBlocked" id="call-mic-hint" class="call-pill call-mic-hint" role="status"><MicOff :size="16" aria-hidden="true" />{{ t('micBlockedShort') }}</p>
      <TabletPrompt v-if="tabletPrompt" />

      <CallToolbar />

      <template v-if="sheet">
        <div class="call-sheet-backdrop" @click="closeSheet" />
        <CallPeopleSheet v-if="sheet === 'participants'" />
        <CallChatSheet v-else-if="sheet === 'chat'" />
        <CallMoreSheet v-else-if="sheet === 'more'" />
      </template>
    </div>
    <!-- Last, so the spots above already exist when a tile moves into one. -->
    <div id="call-spot-parked" hidden />
    <Teleport v-for="(tile, index) in tileList" :key="tile.key" :to="`#call-spot-${spotOf(tile)}`" defer>
      <CallTile
        :ref="view => setTileView(tile, view)"
        :tile="tile"
        :focused="spotOf(tile) === 'focus' || spotOf(tile) === 'full'"
        :small="spotOf(tile) === 'strip' || spotOf(tile) === 'mini'"
        :full="spotOf(tile) === 'full'"
        :dark="darkScreen"
        :me="me"
        :can-save="canSavePicture"
        :style="{ order: index }"
        @focus="toggleFocus(tile.key)"
        @fullscreen="enterFullScreen(tile.key)"
        @dark-screen="toggleDarkScreen"
        @click="onTileClick(tile)"
        @video-size="size => onVideoSize(tile, size)"
        @save="savePicture(tile)"
      />
    </Teleport>
  </section>
</template>

<style scoped>
/* A voice channel's call fills the main area: near-black like most video calls, or white in light mode. */
.call-view {
  position: relative;
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--call-text);
  /* Only the still corner glow here, no grid, so nothing busy sits behind the videos. */
  background: var(--call-bg);
}

/* In the Android app's small window, the call covers the whole page, even when a text channel was open. */
.call-view.mini {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.call-main {
  display: contents;
}

.call-mini {
  flex: 1;
  min-height: 0;
  display: flex;
}

.call-mini-spot {
  flex: 1;
  min-width: 0;
  display: flex;
}

.call-mini-spot .call-tile {
  flex: 1;
  border-radius: 0;
}

.call-mini-card {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  color: var(--call-text-muted);
  font-size: 13px;
  font-weight: 600;
}

.call-mini-card bdi {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.call-stage {
  position: relative;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}

.call-grid {
  min-height: 0;
  flex: 1;
  display: grid;
  gap: 8px;
}

.call-focus {
  min-height: 0;
  flex: 1;
  display: grid;
}

.call-strip {
  flex: 0 0 96px;
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.call-strip > * {
  flex: 0 0 160px;
}

.call-state-card {
  max-width: min(390px, calc(100% - 32px));
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 22px 24px;
  border-radius: var(--radius);
  background: var(--call-surface);
  text-align: center;
}

.call-state-card p {
  color: var(--call-text-muted);
  font-size: 13px;
  line-height: 1.55;
}

.call-state-card.error strong {
  color: var(--danger);
}

/* The rejoin arrow turns the way reading goes, so it turns around for Arabic. */
[dir='rtl'] .call-state-action svg {
  transform: scaleX(-1);
}

.call-state-action {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  padding: 0 16px;
  border-radius: var(--radius);
  color: var(--text-on-accent);
  background: var(--text-accent);
  font-size: 14px;
  font-weight: 600;
}

/* Floating notices, shown over full screen too. */
.call-pill {
  position: absolute;
  z-index: 6;
  left: 50%;
  max-width: calc(100% - 32px);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  overflow: hidden;
  padding: 9px 15px;
  border-radius: 999px;
  color: var(--call-text);
  background: var(--call-sheet);
  border: 1px solid var(--call-outline);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transform: translateX(-50%);
}

.call-sound-pill {
  top: 64px;
  color: var(--text-on-accent);
  background: var(--text-accent);
}

.call-toast {
  top: 112px;
  animation: anime-pop 480ms ease-out;
  width: max-content;
  max-width: min(460px, calc(100% - 32px));
  border-radius: var(--radius);
  white-space: normal;
  text-align: center;
}

.call-reconnecting {
  top: 12px;
}

/* Just above the buttons, where it stays clear of full screen's bar too. */
.call-weak {
  bottom: calc(env(safe-area-inset-bottom) + 84px);
  white-space: normal;
  text-align: center;
}

/* Above the weak-connection sign, so the two never cover each other. */
.call-mic-hint {
  bottom: calc(env(safe-area-inset-bottom) + 128px);
  border-color: var(--leave);
  color: var(--leave);
}

/* Sheets: bottom sheets on phones; the participants list docks to the side on wide screens. */
.call-sheet-backdrop {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: rgba(0, 0, 0, 0.45);
}

@media (min-width: 900px) {
  .call-sheet-backdrop:has(+ .call-sheet.side) {
    background: transparent;
  }
}

@media (max-width: 768px) {
  .call-strip {
    flex-basis: 80px;
  }

  .call-strip > * {
    flex-basis: 120px;
  }
}
</style>
