import { computed, markRaw, ref, watch, type Ref } from 'vue';
import { Track, type Participant, type VideoTrack } from 'livekit-client';
import { useI18n } from '../i18n';
import { SCREEN_SUFFIX } from '../nativeScreenShare';
import { createSpeakingDetector } from '../speaking';
import type { Tile } from '../components/CallTile.vue';
import { watchable, type FullScreen } from './fullScreen';
import { ownerOf, phoneScreenOf } from './screenShare';
import type { CallProps, CallSession, CallState, CallUpdate } from './context';

// About two sentences of speaking.
const HAND_DOWN_AFTER_MS = 4000;
// The same palette the server hands out (auth.ts), so someone whose colour is not known yet still
// looks like the rest of the call.
const FALLBACK_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

// Who is in the call and what each tile shows, rebuilt from LiveKit's view of the room.
export function useCallTiles(session: CallSession, state: CallState, options: {
  props: CallProps;
  fullScreen: FullScreen;
  lastSpeakerKey: Ref<string>;
  showToast: (message: string) => void;
  update: (update: CallUpdate) => void;
  lowerMyHand: () => void;
}) {
  const { t } = useI18n();
  const { props, fullScreen, lastSpeakerKey, showToast } = options;
  const { participants, tiles, focusedKey, micOn, cameraOn, sharingScreen } = state;
  const raisedHands = computed(() => new Set(props.hands.map(hand => hand.userId)));
  const myHandRaised = computed(() => raisedHands.value.has(props.userId));
  // The server keeps raised hands in the order they went up. With two or more up, each shows its
  // place in that line, so the teacher answers in turn and everyone knows how many are before them;
  // a hand alone needs no number.
  const handPlaces = computed(() => new Map(props.hands.map((hand, index) => [hand.userId, index + 1])));
  const handTurnOf = (identity: string) => (props.hands.length > 1 ? handPlaces.value.get(identity) ?? null : null);
  const myHandTurn = computed(() => handTurnOf(props.userId));
  const handButtonLabel = computed(() => {
    if (!myHandRaised.value) return t('raiseHand');
    return myHandTurn.value ? t('lowerHandTurn', { turn: myHandTurn.value }) : t('lowerHand');
  });
  // Others whose internet has been weak for a few seconds, shown by a small sign on their tile, so
  // a voice that keeps cutting out is understood. A short dip is not shown.
  const weakPeople = ref(new Set<string>());
  const weakTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Measures who is speaking on this device, so their glow follows their voice (see speaking.ts). On
  // an iPhone, where a page gets few audio contexts, the call's mixer does the measuring.
  let speakingContext: AudioContext | undefined;
  const speakingDetector = createSpeakingDetector(() => {
    if (session.audioContext) return session.audioContext;
    try {
      if (!speakingContext) { speakingContext = new AudioContext(); void speakingContext.resume().catch(() => {}); }
    } catch { /* No measuring; LiveKit's answer is used. */ }
    return speakingContext;
  }, () => refresh());

  function colorOf(identity: string) {
    const known = props.people.get(identity)?.avatarColor;
    if (known) return known;
    let hash = 0;
    for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
    return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
  }
  const pictureOf = (identity: string) => props.people.get(identity)?.avatarUrl ?? null;
  // Someone who changes their picture during the call shows it on their tile straight away.
  watch(() => props.people, () => refresh());

  // Tiles are rebuilt from LiveKit's view of the room after every change: one per person, showing
  // their camera or their initials, and one more for each shared screen.
  function refresh() {
    const room = session.room;
    if (!room || session.disposed) return;
    const everyone: [Participant, boolean][] = [[room.localParticipant, true], ...[...room.remoteParticipants.values()].map(p => [p, false] as [Participant, boolean])];
    speakingDetector.follow(new Map(everyone.flatMap(([participant]) => {
      const microphone = participant.getTrackPublication(Track.Source.Microphone)?.track;
      return microphone && participant.isMicrophoneEnabled ? [[participant.identity, microphone.mediaStreamTrack] as const] : [];
    })));
    const isSpeaking = (participant: Participant) => participant.isMicrophoneEnabled && (speakingDetector.speaking(participant.identity) ?? participant.isSpeaking);
    participants.value = everyone.filter(([participant]) => !participant.identity.endsWith(SCREEN_SUFFIX)).map(([participant, local]) => ({
      identity: participant.identity, name: participant.name || participant.identity, local,
      micOn: participant.isMicrophoneEnabled, speaking: isSpeaking(participant),
    }));
    const next: Tile[] = [];
    for (const [participant, remoteOrLocal] of everyone) {
      const owner = ownerOf(participant.identity);
      const phoneScreen = owner !== participant.identity;
      const local = remoteOrLocal || owner === props.userId;
      const base = {
        identity: owner, name: participant.name || owner, color: colorOf(owner), picture: pictureOf(owner), local,
        micOn: participant.isMicrophoneEnabled, speaking: isSpeaking(participant), hand: raisedHands.value.has(owner), handTurn: handTurnOf(owner),
        weak: weakPeople.value.has(participant.identity),
      };
      const screen = participant.getTrackPublication(Track.Source.ScreenShare);
      // This phone's own screen is never downloaded (see onTrackPublished in room.ts), so it has no track here.
      if (phoneScreen && local && screen && !screen.isMuted) next.push({ ...base, key: `${participant.identity}:screen`, kind: 'screen', track: null });
      else if (screen?.track && !screen.isMuted) next.push({ ...base, key: `${participant.identity}:screen`, kind: 'screen', track: markRaw(screen.track as VideoTrack), dimensions: screen.dimensions });
      if (phoneScreen) continue;
      const camera = participant.getTrackPublication(Track.Source.Camera);
      const cameraTrack = camera?.track && !camera.isMuted ? markRaw(camera.track as VideoTrack) : null;
      next.push({ ...base, key: `${participant.identity}:camera`, kind: 'camera', track: cameraTrack, dimensions: camera?.dimensions });
    }
    const speaker = next.find(tile => tile.speaking && tile.kind === 'camera' && tile.track && !tile.local);
    if (speaker) lastSpeakerKey.value = speaker.key;
    if (focusedKey.value && !next.some(tile => tile.key === focusedKey.value)) focusedKey.value = null;
    // A screen that stops being shared, or a camera turned off, leaves full screen.
    if (fullScreen.fullKey.value && !next.some(tile => tile.key === fullScreen.fullKey.value && watchable(tile))) fullScreen.exitFullScreen();
    tiles.value = next;
    // The server must hear it too, so room noise picked up by the microphone doesn't lower a hand.
    noteMySpeech(isSpeaking(room.localParticipant) && room.localParticipant.isSpeaking);
    micOn.value = room.localParticipant.isMicrophoneEnabled;
    cameraOn.value = room.localParticipant.isCameraEnabled;
    sharingScreen.value = room.localParticipant.isScreenShareEnabled || room.remoteParticipants.has(phoneScreenOf(props.userId));
    options.update({
      micOn: micOn.value, cameraOn: cameraOn.value, sharing: sharingScreen.value,
      speaking: participants.value.filter(person => person.speaking).map(person => person.identity),
    });
  }

  function noteWeak(identity: string, weak: boolean) {
    clearTimeout(weakTimers.get(identity));
    weakTimers.delete(identity);
    const update = (on: boolean) => {
      const next = new Set(weakPeople.value);
      if (on) next.add(identity); else next.delete(identity);
      weakPeople.value = next;
      refresh();
    };
    if (!weak) { if (weakPeople.value.has(identity)) update(false); return; }
    weakTimers.set(identity, setTimeout(() => { weakTimers.delete(identity); update(true); }, 3000));
  }
  function clearWeak() {
    weakTimers.forEach(timer => clearTimeout(timer));
    weakTimers.clear();
    weakPeople.value = new Set();
  }

  // A raised hand goes down by itself once its owner has spoken for a few seconds: they have had
  // their turn, and people forget to lower it afterwards. Only speech while the hand is up counts,
  // added up across the pauses between sentences.
  let spokenMs = 0;
  let speakingSince: number | undefined;
  let handTimer: ReturnType<typeof setTimeout> | undefined;
  let loweringHand = false;
  function noteMySpeech(speaking: boolean) {
    const now = Date.now();
    if (speaking && myHandRaised.value && !loweringHand) {
      if (speakingSince === undefined) {
        speakingSince = now;
        // Looked at again when the time would be up, since nothing else may change meanwhile.
        handTimer = setTimeout(() => { handTimer = undefined; refresh(); }, HAND_DOWN_AFTER_MS - spokenMs);
      }
      if (spokenMs + now - speakingSince < HAND_DOWN_AFTER_MS) return;
      loweringHand = true;
      options.lowerMyHand();
      showToast(t('handLoweredAfterSpeaking'));
    }
    if (speakingSince !== undefined) spokenMs += now - speakingSince;
    speakingSince = undefined;
    clearTimeout(handTimer);
  }
  watch(myHandRaised, () => {
    spokenMs = 0;
    speakingSince = undefined;
    loweringHand = false;
    clearTimeout(handTimer);
  });

  watch(() => props.hands, (next, previous) => {
    const before = new Set(previous.map(hand => hand.userId));
    const raised = next.find(hand => !before.has(hand.userId) && hand.userId !== props.userId);
    if (raised) showToast(t('handRaised', { name: raised.displayName }));
    refresh();
  });

  return {
    raisedHands, myHandRaised, handPlaces, handTurnOf, myHandTurn, handButtonLabel, colorOf, pictureOf, refresh, noteWeak, clearWeak,
    stopWeakTimers: () => { weakTimers.forEach(timer => clearTimeout(timer)); clearTimeout(handTimer); },
    stopSpeaking() {
      speakingDetector.stop();
      void speakingContext?.close().catch(() => {});
      speakingContext = undefined;
    },
  };
}
export type CallTiles = ReturnType<typeof useCallTiles>;
