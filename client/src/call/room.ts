import { ref } from 'vue';
import {
  AudioPresets, ConnectionQuality, DisconnectReason, Room, RoomEvent, Track, VideoPreset, VideoPresets, type RemoteParticipant, type RemoteTrackPublication,
} from 'livekit-client';
import { api, ApiError } from '../api';
import { getSocket } from '../socket';
import { useI18n } from '../i18n';
import { SCREEN_SUFFIX } from '../nativeScreenShare';
import { keepPhoneCallGoing } from '../nativeCall';
import { receiveBoard, sayHello, sendBoardWith, tellBoards, type BoardMessage } from '../board';
import { phoneScreenOf } from './screenShare';
import type { CallProps, CallSession, CallState } from './context';
import type { Sound } from './sound';
import type { Microphone } from './microphone';
import type { CallTiles } from './tiles';
import type { TabletBoard } from './tabletBoard';

// Chrome on Android, which the Android app is built on, decides once, as a sound starts playing,
// whether it is a call's sound or a video's, and it only takes the echo out of a call's. A sound
// counts as a call's only while the microphone is open. Voices that started before it, as they did
// for anyone who joined muted and spoke later, came out of the speaker and went straight back into
// the microphone: the echo everyone heard in September 2026, until that person rejoined. So on
// Android the microphone is opened before any voice plays, muted when its owner joined muted.
const onAndroid = /Android/i.test(navigator.userAgent);
// Longer than this, as when the phone is still asking whether the app may use the microphone, and
// the voices play anyway: hearing the call matters more.
const MICROPHONE_WAIT_MS = 4000;

// Joining the LiveKit room, following everything that happens in it, and joining again after a drop.
export function useLiveKitRoom(session: CallSession, state: CallState, parts: {
  props: CallProps;
  sound: Sound;
  microphone: Microphone;
  tiles: CallTiles;
  tablet: TabletBoard;
  tellMiniShape: () => void;
  toggleCamera: () => Promise<void>;
  showToast: (message: string, duration?: number) => void;
}) {
  const { t, translateError } = useI18n();
  const { props, sound, microphone, tiles, tablet, showToast } = parts;
  const { status, error, participants } = state;
  const { refresh } = tiles;
  const startedAt = ref(0);
  const weakConnection = ref(false);
  // Once this device's internet has shown it cannot keep up, other people's cameras stop being
  // downloaded until the call is left, so what little there is goes to voices and the shared screen.
  const savingData = ref(false);
  let wakeLock: WakeLockSentinel | null = null;
  let weakTimer: ReturnType<typeof setTimeout> | undefined;
  let rejoinWhenVisible = false;
  let lastAutoRejoinAt = 0;
  // How many times in a row joining has failed and been tried again by itself.
  let joinRetries = 0;

  // The blackboard (see board.ts) travels between the people in the call as LiveKit data messages.
  const boardEncoder = new TextEncoder();
  const boardDecoder = new TextDecoder();
  sendBoardWith((message: BoardMessage, to?: string[]) => {
    try {
      void session.room?.localParticipant.publishData(boardEncoder.encode(JSON.stringify(message)), { reliable: true, topic: 'board', destinationIdentities: to }).catch(() => {});
    } catch { /* Not connected; a drawing is not worth interrupting the call for. */ }
  });
  // One person answers someone who joins with what is already drawn, so they do not all send it:
  // the first of the others in a fixed order.
  function answersHello(requester: string) {
    const room = session.room;
    if (!room) return false;
    const others = [room.localParticipant.identity, ...room.remoteParticipants.keys()].filter(identity => identity !== requester && !identity.endsWith(SCREEN_SUFFIX)).sort();
    return others[0] === room.localParticipant.identity;
  }

  // Downloading your own phone's screen would only use data to show it back to you.
  function onTrackPublished(publication: RemoteTrackPublication, participant: RemoteParticipant) {
    if (participant.identity === phoneScreenOf(props.userId)) publication.setSubscribed(false);
    else if (publication.source === Track.Source.Camera) publication.setSubscribed(!savingData.value);
  }
  function saveData() {
    if (savingData.value || !session.room) return;
    savingData.value = true;
    applySavingData();
    showToast(t('camerasHiddenSlowInternet'), 6000);
  }
  function applySavingData() {
    for (const participant of session.room?.remoteParticipants.values() ?? []) {
      for (const publication of participant.trackPublications.values()) onTrackPublished(publication, participant);
    }
  }
  // Two short pulses when someone else joins the call, so a phone in a pocket feels it; there is no
  // sound. A friend whose connection dropped for a moment is coming back rather than joining.
  const leftAt = new Map<string, number>();
  let quietUntil = 0;
  function onParticipantConnected(participant: RemoteParticipant) {
    if (participant.identity.endsWith(SCREEN_SUFFIX) || participant.identity === props.userId || Date.now() < quietUntil) return;
    if (Date.now() - (leftAt.get(participant.identity) ?? 0) < 30_000) return;
    try { navigator.vibrate?.([70, 60, 70]); } catch { /* Not a phone, or vibration is turned off. */ }
  }

  // Keeps a phone from dimming and locking during a call. Browsers release the lock whenever the
  // page is hidden, so it is requested again when the page returns.
  async function keepScreenOn() {
    if (session.disposed || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Battery saver, or not supported. */ }
  }
  function onVisibilityChange() {
    if (session.disposed || document.visibilityState !== 'visible') return;
    void keepScreenOn();
    if (rejoinWhenVisible) { rejoinWhenVisible = false; void rejoin(); } else sound.resumeSound();
  }

  async function connect() {
    let attempt: Room | undefined;
    try {
      const credentials = await api.getLiveKitToken(props.channelId);
      if (session.disposed) return;
      startedAt.value = credentials.startedAt;
      const audioContext = session.audioContext;
      // Adaptive streaming sends each tile only as much video as its size needs, and dynacast stops
      // sending camera layers nobody is watching, which keeps calls light on mobile data.
      const connectingRoom = new Room({
        adaptiveStream: true, dynacast: true, ...(audioContext ? { webAudioMix: { audioContext } } : {}),
        // Everything is sent as lightly as it can be while staying clear, because some of the class
        // have slow internet. Each video also goes out in smaller copies, and the server gives every
        // person the largest copy their internet can take, so one slow connection slows nobody else.
        // A voice needs far less than music; a shared browser tab's sound keeps music quality (see
        // toggleScreenShare in screenShare.ts).
        publishDefaults: {
          audioPreset: AudioPresets.speech,
          videoSimulcastLayers: [VideoPresets.h90, VideoPresets.h180],
          // A screen is mostly still text, so a few frames a second keep it readable at a fraction of the data.
          screenShareEncoding: { maxBitrate: 1_200_000, maxFramerate: 15 },
          screenShareSimulcastLayers: [new VideoPreset(640, 360, 120_000, 3), new VideoPreset(1280, 720, 400_000, 5)],
        },
      });
      session.room = attempt = connectingRoom;
      session.voicesWaiting = onAndroid;
      // Events from a room that a rejoin has replaced are ignored.
      const current = () => !session.disposed && session.room === connectingRoom;
      connectingRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (!current()) return;
        sound.attachAudio(track, participant);
        refresh();
      });
      connectingRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        sound.detachAudio(track);
        if (current()) refresh();
      });
      connectingRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (current()) sound.audioBlocked.value = !connectingRoom.canPlaybackAudio; });
      // LiveKit retries a dropped connection for a while before giving up with Disconnected.
      connectingRoom.on(RoomEvent.Reconnecting, () => { if (current()) status.value = 'reconnecting'; });
      connectingRoom.on(RoomEvent.Reconnected, () => { if (current()) { status.value = 'connected'; quietUntil = Date.now() + 3000; refresh(); } });
      connectingRoom.on(RoomEvent.ParticipantConnected, participant => { if (current()) { onParticipantConnected(participant); tablet.noteArrival(participant); } });
      connectingRoom.on(RoomEvent.ParticipantDisconnected, participant => { if (current()) { leftAt.set(participant.identity, Date.now()); tablet.noteLeaving(participant); } });
      connectingRoom.on(RoomEvent.ActiveSpeakersChanged, () => { if (current()) tablet.noteTalking(); });
      connectingRoom.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        // A join that fails is tried again by connect() itself.
        if (!current() || error.value || status.value === 'joining') return;
        status.value = 'disconnected';
        // A deleted channel, or the call opened on another device, stays closed. Anything else, such
        // as the browser putting the page to sleep while its owner was in another app, is rejoined as
        // soon as the page is looked at. A call that keeps dropping straight after a rejoin is left
        // to be rejoined by hand.
        if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.DUPLICATE_IDENTITY) return;
        if (Date.now() - lastAutoRejoinAt < 15_000) return;
        lastAutoRejoinAt = Date.now();
        if (document.visibilityState === 'visible') void rejoin();
        else rejoinWhenVisible = true;
      });
      // A weak connection for more than a moment is worth knowing about: it explains a voice that cuts
      // out, and that the problem is here rather than with the others.
      connectingRoom.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (!current()) return;
        if (participant !== connectingRoom.localParticipant) { tiles.noteWeak(participant.identity, quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost); return; }
        clearTimeout(weakTimer);
        if (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) weakTimer = setTimeout(() => { weakConnection.value = true; saveData(); }, 3000);
        else weakConnection.value = false;
      });
      connectingRoom.on(RoomEvent.TrackPublished, (publication, participant) => { if (current()) onTrackPublished(publication, participant); });
      // The server pauses a video when this device's internet cannot carry it.
      connectingRoom.on(RoomEvent.TrackStreamStateChanged, (publication, streamState) => {
        if (current() && streamState === Track.StreamState.Paused && publication.kind === Track.Kind.Video && publication.isSubscribed) saveData();
      });
      connectingRoom.on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
        if (!current() || topic !== 'board' || !sender) return;
        let message: unknown;
        try { message = JSON.parse(boardDecoder.decode(payload)); } catch { return; }
        if (receiveBoard(message, sender.name || sender.identity) && answersHello(sender.identity)) tellBoards(sender.identity);
      });
      for (const event of [
        RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ParticipantNameChanged,
        RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
        RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged,
      ] as const) connectingRoom.on(event, () => { if (current()) refresh(); });
      // A slow connection gets twice LiveKit's usual time to join before it counts as failed.
      await connectingRoom.connect(credentials.url, credentials.token, { websocketTimeout: 30_000, peerConnectionTimeout: 30_000, maxRetries: 2 });
      if (!current()) { connectingRoom.disconnect(); return; }
      // A phone set to save data (Android's Data Saver in Chrome) is slow or on a limited plan from the start.
      if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) savingData.value = true;
      status.value = 'connected';
      joinRetries = 0;
      // Drawings made before this person came are asked for (see board.ts). A message sent the moment
      // the call connects can be lost, so the question waits a moment, and is asked once more.
      for (const delay of [1500, 5000]) setTimeout(() => { if (current()) sayHello(); }, delay);
      for (const participant of connectingRoom.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) onTrackPublished(publication, participant);
      }
      refresh();
      // Started before the microphone, so the call's sound keeps going even if the microphone is refused.
      keepPhoneCallGoing();
      // Told again once the call is running on the phone, so the small window never misses its shape.
      parts.tellMiniShape();
      // The microphone and camera start as chosen on the screen before the call.
      const opening = props.startMic ? microphone.setMicrophone(true) : onAndroid ? microphone.openMutedMicrophone() : Promise.resolve();
      if (session.voicesWaiting) await Promise.race([opening, new Promise(resolve => setTimeout(resolve, MICROPHONE_WAIT_MS))]);
      if (session.room !== connectingRoom) return;
      session.voicesWaiting = false;
      for (const participant of connectingRoom.remoteParticipants.values()) {
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.track) sound.attachAudio(publication.track, participant);
        }
      }
      await opening;
      if (props.startCamera && !session.disposed) await parts.toggleCamera();
    } catch (cause) {
      if (session.disposed) return;
      // On weak internet a join often fails once and works the next time, so it is tried twice more
      // by itself, still showing "Joining the call…", before the Rejoin button is offered.
      if (!(cause instanceof ApiError) && status.value === 'joining' && joinRetries < 2) {
        joinRetries++;
        if (session.room === attempt) session.room = null;
        void attempt?.disconnect();
        setTimeout(() => { if (!session.disposed && !session.room && status.value === 'joining') void connect(); }, 2000);
        return;
      }
      joinRetries = 0;
      error.value = cause instanceof ApiError ? translateError(cause.message) : t('callConnectFailed');
    }
  }
  async function rejoin() {
    rejoinWhenVisible = false;
    const previous = session.room;
    session.room = null;
    microphone.stopListening();
    clearTimeout(weakTimer);
    weakConnection.value = false;
    tiles.clearWeak();
    previous?.disconnect();
    sound.removeVoices();
    error.value = '';
    status.value = 'joining';
    participants.value = [];
    state.tiles.value = [];
    // The server forgets whoever lost their connection, so it is told again before the call is rejoined.
    await new Promise(resolve => getSocket()?.emit('voice_join', { channelId: props.channelId }, resolve));
    await connect();
  }

  return {
    startedAt, weakConnection, rejoin,
    start() {
      document.addEventListener('visibilitychange', onVisibilityChange);
      // A page brought back from the browser's back-forward cache may not report a visibility change.
      window.addEventListener('pageshow', onVisibilityChange);
      void keepScreenOn();
    },
    connect,
    stopWeakTimer: () => clearTimeout(weakTimer),
    dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onVisibilityChange);
      void wakeLock?.release().catch(() => {});
    },
  };
}
export type LiveKitRoom = ReturnType<typeof useLiveKitRoom>;
