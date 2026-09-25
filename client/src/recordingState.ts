import { reactive } from 'vue';

// What the person recording a call sees of their recording. It lives outside the call screen,
// because the call screen closes when they leave the call, and the recording still has to be
// saved and posted after that. The part that records (callRecorder.ts) carries LiveKit, so it
// loads with the call screen; this part is small enough for the main app.
export type RecordingPhase =
  /** Nothing is being recorded on this device. */
  | 'idle'
  /** Record was pressed and the server is being asked. */
  | 'starting'
  | 'recording'
  /** Stopped; the last pieces are still being uploaded. */
  | 'saving'
  /** Everything is uploaded, and the recorder chooses where to post it. */
  | 'ready';

export const recordingState = reactive({
  phase: 'idle' as RecordingPhase,
  id: '',
  voiceChannelId: '',
  channelName: '',
  startedAt: 0,
  durationMs: 0,
  /** The last pieces could not be sent yet; they are being tried again. */
  uploadTrouble: false,
  /** Why the recording stopped by itself, as a translation key, if it did. */
  stoppedBecause: '' as '' | 'recordingTooLarge' | 'recordingTakenOver',
  /** The recording no longer exists on the server, so there is nothing to post. */
  lost: false,
});

export function resetRecordingState() {
  Object.assign(recordingState, {
    phase: 'idle', id: '', voiceChannelId: '', channelName: '', startedAt: 0, durationMs: 0,
    uploadTrouble: false, stoppedBecause: '', lost: false,
  });
}
