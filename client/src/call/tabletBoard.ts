import { computed, ref, watch } from 'vue';
import type { RemoteParticipant } from 'livekit-client';
import { useI18n } from '../i18n';
import { boardForTablet, boardVersion } from '../board';
import { SCREEN_SUFFIX } from '../nativeScreenShare';
import { askToDrawOverApps, canDrawOverApps, hideOnTablet, onDrawOverAppsChanged, showOnTablet, tabletBoardAvailable } from '../nativeBoard';
import { phoneScreenOf } from './screenShare';
import type { CallProps, CallSession, CallState } from './context';

// The teacher shares his tablet's screen from the Android app and is then looking at his book, so
// the app draws the board over every other app there (see nativeBoard.ts). Android asks once for
// that; the first time, a short note explains why before its settings screen opens.
const TABLET_DECLINED_KEY = 'tabletBoardDeclined';

// While the teacher shares his screen he is in his book, not in the call, so the same window shows
// him, small at the top, who is talking and who comes and goes.
//
// Only clear speech counts as talking there: LiveKit already ignores the quietest sounds, and a
// voice must also be loud enough and go on for most of a second. Noise from someone's house, such
// as a door, dishes or children in another room, is softer than their voice, or over sooner.
// (LiveKit's own measure is used here because the teacher's copy of the call is in the background,
// where the page cannot measure voices itself.) The level is LiveKit's 0 to 1 scale, measured in
// October 2026: a voice gives 0.25 to 0.5, and talking in another room 0.125 (its lowest step).
const TALKING_LEVEL = 0.2;
const TALKING_FOR_MS = 800;
const STILL_TALKING_MS = 1200;
const NOTICE_MS = 5000;
// Someone whose connection drops for a moment comes back within seconds; they did not leave.
const LEFT_AFTER_MS = 10_000;

export function useTabletBoard(session: CallSession, state: CallState, props: CallProps) {
  const { t } = useI18n();
  const { sharingScreen } = state;
  const tabletAllowed = ref(false);
  const tabletPrompt = ref(false);
  const offerTabletBoard = computed(() => tabletBoardAvailable && sharingScreen.value && !tabletAllowed.value);
  const myBoardKey = () => `${phoneScreenOf(props.userId)}:screen`;
  let tabletTimer: ReturnType<typeof setTimeout> | undefined;
  function drawOnTablet() {
    if (tabletTimer) return;
    // Sent at most twenty times a second while someone draws.
    tabletTimer = setTimeout(() => {
      tabletTimer = undefined;
      if (!sharingScreen.value || !tabletAllowed.value) return;
      const board = { ...boardForTablet(myBoardKey()), speakers: tabletSpeakers.value, notices: tabletNotices.value.map(notice => notice.text) };
      showOnTablet(board).catch(() => { tabletAllowed.value = false; });
    }, 50);
  }
  watch(boardVersion, () => { if (tabletBoardAvailable && sharingScreen.value && tabletAllowed.value) drawOnTablet(); });

  const tabletSpeakers = ref<string[]>([]);
  const tabletNotices = ref<{ id: number; text: string }[]>([]);
  const talkingSince = new Map<string, number>();
  const talkingUntil = new Map<string, number>();
  const leftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const announcedLeaving = new Set<string>();
  let talkingTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeId = 0;
  const showingTeacherSigns = () => tabletBoardAvailable && sharingScreen.value && tabletAllowed.value;
  function noteTalking() {
    const room = session.room;
    if (!room) return;
    const now = Date.now();
    for (const participant of room.remoteParticipants.values()) {
      const identity = participant.identity;
      if (identity.endsWith(SCREEN_SUFFIX)) continue;
      const talking = participant.isSpeaking && participant.isMicrophoneEnabled;
      if (talking && (talkingSince.has(identity) || participant.audioLevel >= TALKING_LEVEL)) {
        if (!talkingSince.has(identity)) talkingSince.set(identity, now);
        talkingUntil.set(identity, now + STILL_TALKING_MS);
      } else if ((talkingUntil.get(identity) ?? 0) <= now) {
        talkingSince.delete(identity);
        talkingUntil.delete(identity);
      }
    }
    for (const identity of talkingSince.keys()) if (!room.remoteParticipants.has(identity)) { talkingSince.delete(identity); talkingUntil.delete(identity); }
    const names = [...talkingSince].filter(([, since]) => now - since >= TALKING_FOR_MS)
      .map(([identity]) => session.room?.remoteParticipants.get(identity)?.name || '').filter(Boolean);
    if (names.join('\n') !== tabletSpeakers.value.join('\n')) tabletSpeakers.value = names;
    // Looked at again shortly, to show someone once they have talked long enough and to let go of
    // someone who stopped; LiveKit only says when the list of speakers changes.
    clearTimeout(talkingTimer);
    talkingTimer = talkingSince.size ? setTimeout(noteTalking, 300) : undefined;
  }
  function addNotice(text: string) {
    if (!showingTeacherSigns()) return;
    const id = ++noticeId;
    tabletNotices.value = [...tabletNotices.value, { id, text }].slice(-3);
    setTimeout(() => { tabletNotices.value = tabletNotices.value.filter(notice => notice.id !== id); }, NOTICE_MS);
  }
  function noteArrival(participant: RemoteParticipant) {
    if (participant.identity.endsWith(SCREEN_SUFFIX)) return;
    clearTimeout(leftTimers.get(participant.identity));
    const wasAway = leftTimers.delete(participant.identity);
    // Coming back within moments of a dropped connection is no news, unless their leaving was shown.
    if (wasAway && !announcedLeaving.has(participant.identity)) return;
    announcedLeaving.delete(participant.identity);
    addNotice(t('joinedNotice', { name: participant.name || '' }));
  }
  function noteLeaving(participant: RemoteParticipant) {
    if (participant.identity.endsWith(SCREEN_SUFFIX)) return;
    const name = participant.name || '';
    clearTimeout(leftTimers.get(participant.identity));
    leftTimers.set(participant.identity, setTimeout(() => {
      if (session.room?.remoteParticipants.has(participant.identity)) return;
      announcedLeaving.add(participant.identity);
      addNotice(t('leftNotice', { name }));
    }, LEFT_AFTER_MS));
    noteTalking();
  }
  watch([tabletSpeakers, tabletNotices], () => { if (showingTeacherSigns()) drawOnTablet(); });
  watch(sharingScreen, async sharing => {
    if (!tabletBoardAvailable) return;
    if (!sharing) { tabletPrompt.value = false; void hideOnTablet(); return; }
    tabletAllowed.value = await canDrawOverApps();
    if (tabletAllowed.value) drawOnTablet();
    else if (!(() => { try { return localStorage.getItem(TABLET_DECLINED_KEY); } catch { return null; } })()) tabletPrompt.value = true;
  });
  const drawPermissionListener = onDrawOverAppsChanged(allowed => {
    tabletAllowed.value = allowed;
    if (allowed && sharingScreen.value) drawOnTablet();
  });
  function answerTabletPrompt(allow: boolean) {
    tabletPrompt.value = false;
    if (allow) void askToDrawOverApps();
    else try { localStorage.setItem(TABLET_DECLINED_KEY, '1'); } catch { /* Private browsing: asked again next time. */ }
  }

  return {
    tabletPrompt, offerTabletBoard, answerTabletPrompt, noteTalking, noteArrival, noteLeaving,
    dispose() {
      clearTimeout(tabletTimer);
      clearTimeout(talkingTimer);
      leftTimers.forEach(timer => clearTimeout(timer));
      void hideOnTablet();
      void drawPermissionListener?.remove();
    },
  };
}
export type TabletBoard = ReturnType<typeof useTabletBoard>;
