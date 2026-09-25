import { Track, type ElementInfo, type Participant, type RemoteVideoTrack, type Room } from 'livekit-client';
import { api, ApiError } from './api';
import { SCREEN_SUFFIX } from './nativeScreenShare';
import { recordingState } from './recordingState';
import { getSocket } from './socket';
import type { VoiceCall } from './types';

// A call is recorded in the browser of whoever presses Record, rather than by LiveKit, which stays
// set up without recording. The recording is a 1280×720 picture of the most important thing in the
// call (a shared screen, else whoever spoke last with their camera on) with everyone's voices mixed
// into one sound, uploaded in pieces as it is made.

const WIDTH = 1280;
const HEIGHT = 720;
const FRAMES_PER_SECOND = 12;
// Screen writing compresses well, so these keep an hour of lesson near 250 MB.
const VIDEO_BITS_PER_SECOND = 500_000;
const AUDIO_BITS_PER_SECOND = 64_000;
const PIECE_MS = 5_000;
const KEYFRAME_EVERY_MS = 5_000;
const BACKGROUND = '#111214';

/** The recording format this browser can make: WebM where it can, MP4 on Safari. */
export function recordingMimeType(): string | null {
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
    .find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}
export const canRecord = typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype
  && typeof AudioContext === 'function' && recordingMimeType() !== null;

/** A video being drawn into the recording. */
interface Shown { track: MediaStreamTrack; element: HTMLVideoElement; label: string; release: () => void }
interface Session {
  getRoom: () => Room | null;
  /** How a shared screen is named on the recording, in the recorder's language. */
  screenLabel: (name: string) => string;
  userId: string;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  canvasTrack: MediaStreamTrack;
  audio: AudioContext;
  mix: MediaStreamAudioDestinationNode;
  voices: Map<string, MediaStreamAudioSourceNode>;
  recorder: MediaRecorder;
  stopClock: () => void;
  shown: Shown | null;
  /** The video shown before, kept on screen until the new one has its first picture. */
  previous: Shown | null;
  /** When each shared screen was first seen, so the newest one is recorded. */
  screensSeen: Map<string, number>;
  ticks: number;
  localStart: number;
  onVoiceState: (state: { calls: VoiceCall[] }) => void;
}

let session: Session | null = null;
// Pieces wait here until the server has them, in order, so a network drop only delays them.
const pieces: Blob[] = [];
let nextIndex = 0;
let pumping = false;
let recorderStopped = false;
let failures = 0;
let resuming = false;

// Timers on a hidden page are slowed to once a second or even once a minute, which would freeze
// the recording while the recorder is in another tab or app. A worker's timer keeps its pace.
function startClock(tick: () => void): () => void {
  const interval = Math.round(1000 / FRAMES_PER_SECOND);
  try {
    const url = URL.createObjectURL(new Blob(
      ['let timer; onmessage = event => { clearInterval(timer); if (event.data) timer = setInterval(() => postMessage(0), event.data); };'],
      { type: 'text/javascript' },
    ));
    const worker = new Worker(url);
    worker.onmessage = tick;
    worker.postMessage(interval);
    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const timer = setInterval(tick, interval);
    return () => clearInterval(timer);
  }
}

const everyone = (room: Room): Participant[] => [room.localParticipant, ...room.remoteParticipants.values()];
const ownerName = (participant: Participant) => participant.name || participant.identity;

function liveVideo(participant: Participant, source: Track.Source) {
  const publication = participant.getTrackPublication(source);
  const track = publication?.track;
  return track && !publication.isMuted && track.mediaStreamTrack?.readyState === 'live' ? track : null;
}

// The most important thing to watch: the newest shared screen, else the camera of whoever spoke
// last, else nothing (a plain frame with the channel's name).
function choose(current: Session): { track: Track; label: string } | null {
  const room = current.getRoom();
  if (!room || room.state !== 'connected') return null;
  let screen: { track: Track; label: string } | null = null;
  let newest = -1;
  for (const participant of everyone(room)) {
    const track = liveVideo(participant, Track.Source.ScreenShare);
    if (!track) continue;
    const key = track.mediaStreamTrack.id;
    if (!current.screensSeen.has(key)) current.screensSeen.set(key, Date.now());
    const seen = current.screensSeen.get(key)!;
    if (seen > newest) { newest = seen; screen = { track, label: current.screenLabel(ownerName(participant)) }; }
  }
  if (screen) return screen;
  let camera: { track: Track; label: string } | null = null;
  let spoke = -1;
  for (const participant of everyone(room)) {
    if (participant.identity.endsWith(SCREEN_SUFFIX)) continue;
    const track = liveVideo(participant, Track.Source.Camera);
    if (!track) continue;
    const at = participant.lastSpokeAt?.getTime() ?? 0;
    if (at > spoke) { spoke = at; camera = { track, label: ownerName(participant) }; }
  }
  return camera;
}

// With adaptive streaming, LiveKit stops sending a video nobody on this device looks at, and every
// video while the page is hidden. The recording looks at it the whole time, as if it were a
// picture-in-picture window, so it keeps coming at a size worth recording.
function keepSending(element: HTMLVideoElement): ElementInfo {
  return {
    element, width: () => WIDTH, height: () => HEIGHT, visible: true, pictureInPicture: true,
    visibilityChangedAt: 0, observe: () => {}, stopObserving: () => {},
  };
}

function show(current: Session, choice: { track: Track; label: string } | null) {
  const mediaTrack = choice?.track.mediaStreamTrack;
  if (current.shown && current.shown.track === mediaTrack) { current.shown.label = choice!.label; return; }
  current.previous?.release();
  current.previous = current.shown;
  current.shown = null;
  if (!choice || !mediaTrack) return;
  const element = document.createElement('video');
  element.muted = true;
  element.playsInline = true;
  element.autoplay = true;
  element.srcObject = new MediaStream([mediaTrack]);
  void element.play().catch(() => {});
  const remote = 'observeElementInfo' in choice.track ? choice.track as RemoteVideoTrack : null;
  const info = remote ? keepSending(element) : null;
  if (remote && info) remote.observeElementInfo(info);
  current.shown = {
    track: mediaTrack, element, label: choice.label,
    release: () => {
      if (remote && info) remote.stopObservingElementInfo(info);
      element.pause();
      element.srcObject = null;
    },
  };
}

function drawLabel(context: CanvasRenderingContext2D, label: string) {
  context.font = '600 22px system-ui, "Noto Naskh Arabic", sans-serif';
  const width = Math.min(WIDTH - 40, context.measureText(label).width + 24);
  context.fillStyle = 'rgba(0, 0, 0, 0.6)';
  context.fillRect(16, HEIGHT - 56, width, 40);
  context.fillStyle = '#ffffff';
  context.textBaseline = 'middle';
  context.fillText(label, 28, HEIGHT - 36, WIDTH - 64);
}

function draw(current: Session) {
  const { context } = current;
  show(current, choose(current));
  const ready = [current.shown, current.previous].find(video => video && video.element.readyState >= 2 && video.element.videoWidth > 0);
  if (ready === current.shown && current.previous) { current.previous.release(); current.previous = null; }
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  if (ready) {
    // Letterboxed, never cropped: the whole of the teacher's screen must stay readable.
    const { videoWidth, videoHeight } = ready.element;
    const scale = Math.min(WIDTH / videoWidth, HEIGHT / videoHeight);
    const width = videoWidth * scale;
    const height = videoHeight * scale;
    context.drawImage(ready.element, (WIDTH - width) / 2, (HEIGHT - height) / 2, width, height);
    drawLabel(context, ready.label);
  } else {
    context.fillStyle = '#f2f3f5';
    context.font = '700 48px system-ui, "Noto Naskh Arabic", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(recordingState.channelName, WIDTH / 2, HEIGHT / 2, WIDTH - 80);
    context.textAlign = 'start';
  }
  (current.canvasTrack as CanvasCaptureMediaStreamTrack).requestFrame?.();
}

// Everyone's microphone and shared-screen sound, and this device's own microphone, are mixed into
// the recording's one sound. People come and go, and a rejoined call has new tracks, so the mix is
// brought up to date every second.
function syncVoices(current: Session) {
  const room = current.getRoom();
  const wanted = new Map<string, MediaStreamTrack>();
  for (const participant of room ? everyone(room) : []) {
    for (const publication of participant.audioTrackPublications.values()) {
      const track = publication.track?.mediaStreamTrack;
      if (track && track.readyState === 'live') wanted.set(track.id, track);
    }
  }
  for (const [id, node] of current.voices) {
    if (!wanted.has(id)) { node.disconnect(); current.voices.delete(id); }
  }
  for (const [id, track] of wanted) {
    if (current.voices.has(id)) continue;
    try {
      const node = current.audio.createMediaStreamSource(new MediaStream([track]));
      node.connect(current.mix);
      current.voices.set(id, node);
    } catch { /* That voice is left out rather than stopping the recording. */ }
  }
  if (current.audio.state === 'suspended') void current.audio.resume().catch(() => {});
}

function tick() {
  const current = session;
  if (!current) return;
  draw(current);
  if (current.ticks++ % FRAMES_PER_SECOND === 0) syncVoices(current);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const id = recordingState.id;
  try {
    while (pieces.length && recordingState.id === id && !recordingState.lost) {
      try {
        await api.uploadRecordingPiece(id, nextIndex, pieces[0]);
        pieces.shift();
        nextIndex++;
        failures = 0;
        recordingState.uploadTrouble = false;
      } catch (cause) {
        const status = cause instanceof ApiError ? cause.status : 0;
        if (status === 413) {
          // What was recorded until now is kept and can be posted.
          pieces.length = 0;
          stopRecording('recordingTooLarge');
          break;
        }
        if ([403, 404, 409, 415].includes(status)) {
          pieces.length = 0;
          recordingState.lost = true;
          stopRecording();
          break;
        }
        // Anything else is the network, which comes back; the pieces wait and are tried again.
        failures++;
        recordingState.uploadTrouble = failures >= 2;
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))));
      }
    }
  } finally {
    pumping = false;
  }
  if (pieces.length && recordingState.id === id && !recordingState.lost) { void pump(); return; }
  if (recordingState.phase === 'saving' && recorderStopped && !pieces.length) recordingState.phase = 'ready';
}

// A dropped connection makes the server forget who was recording; once this device is back in the
// call, it says so again. If someone else started recording meanwhile, this recording stops, so the
// call never shows one recording while another is secretly made.
function watchCall(userId: string) {
  return ({ calls }: { calls: VoiceCall[] }) => {
    if (recordingState.phase !== 'recording' || resuming) return;
    const call = calls.find(listed => listed.channelId === recordingState.voiceChannelId);
    if (!call?.members.some(member => member.id === userId)) return;
    if (call.recording && call.recording.userId !== userId) { stopRecording('recordingTakenOver'); return; }
    if (call.recording) return;
    resuming = true;
    api.resumeRecording(recordingState.id).catch(() => {}).finally(() => { resuming = false; });
  };
}

/**
 * Starts recording the call. Called straight from the tap on Record, because a phone only lets the
 * sound mixer start inside a tap.
 */
export async function startRecording(options: { getRoom: () => Room | null; screenLabel: (name: string) => string; userId: string; voiceChannelId: string; channelName: string }) {
  const mimeType = recordingMimeType();
  if (!canRecord || !mimeType || recordingState.phase !== 'idle') return;
  const audio = new AudioContext();
  recordingState.phase = 'starting';
  let started: { id: string; startedAt: number };
  try {
    started = await api.startRecording(options.voiceChannelId);
  } catch (cause) {
    recordingState.phase = 'idle';
    void audio.close().catch(() => {});
    throw cause;
  }

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext('2d', { alpha: false })!;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  // Frames are pushed one by one where the browser allows it, so a slow page never records
  // duplicates; elsewhere the canvas is sampled at the same rate.
  let canvasStream = canvas.captureStream(0);
  let canvasTrack = canvasStream.getVideoTracks()[0];
  if (typeof (canvasTrack as CanvasCaptureMediaStreamTrack).requestFrame !== 'function') {
    canvasTrack.stop();
    canvasStream = canvas.captureStream(FRAMES_PER_SECOND);
    canvasTrack = canvasStream.getVideoTracks()[0];
  }
  const mix = audio.createMediaStreamDestination();
  // A watcher can only skip to a whole picture (a keyframe), so Chrome is asked for one every few
  // seconds; browsers that do not know the option ignore it.
  const recorder = new MediaRecorder(new MediaStream([canvasTrack, ...mix.stream.getAudioTracks()]), {
    mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    videoKeyFrameIntervalDuration: KEYFRAME_EVERY_MS,
  } as MediaRecorderOptions);

  pieces.length = 0;
  nextIndex = 0;
  failures = 0;
  recorderStopped = false;
  const current: Session = {
    getRoom: options.getRoom, screenLabel: options.screenLabel, userId: options.userId, canvas, context, canvasTrack, audio, mix,
    voices: new Map(), recorder, stopClock: () => {}, shown: null, previous: null, screensSeen: new Map(),
    ticks: 0, localStart: Date.now(), onVoiceState: watchCall(options.userId),
  };
  session = current;
  Object.assign(recordingState, {
    id: started.id, voiceChannelId: options.voiceChannelId, channelName: options.channelName,
    startedAt: started.startedAt, durationMs: 0, uploadTrouble: false, stoppedBecause: '', lost: false,
  });
  recorder.ondataavailable = event => {
    if (!event.data.size || recordingState.lost) return;
    pieces.push(event.data);
    void pump();
  };
  recorder.onerror = () => stopRecording();
  // The browser may stop a recording by itself, for example when it runs short of memory.
  recorder.onstop = () => stopRecording();
  syncVoices(current);
  draw(current);
  current.stopClock = startClock(tick);
  getSocket()?.on('voice_state', current.onVoiceState);
  recorder.start(PIECE_MS);
  recordingState.phase = 'recording';
}

function teardown(current: Session) {
  current.stopClock();
  getSocket()?.off('voice_state', current.onVoiceState);
  current.shown?.release();
  current.previous?.release();
  for (const node of current.voices.values()) node.disconnect();
  current.voices.clear();
  current.canvasTrack.stop();
  void current.audio.close().catch(() => {});
  if (session === current) session = null;
}

/** Stops recording; the last pieces are uploaded, then the recorder chooses where to post it. */
export function stopRecording(reason?: 'recordingTooLarge' | 'recordingTakenOver') {
  const current = session;
  if (!current || recordingState.phase !== 'recording') return;
  recordingState.phase = 'saving';
  recordingState.durationMs = Date.now() - current.localStart;
  if (reason) recordingState.stoppedBecause = reason;
  void api.stopRecording(recordingState.id).catch(() => { /* The badge goes anyway when the recording is posted. */ });
  const finished = () => {
    if (recorderStopped) return;
    recorderStopped = true;
    teardown(current);
    void pump();
  };
  if (current.recorder.state === 'inactive') { finished(); return; }
  current.recorder.onstop = finished;
  try { current.recorder.stop(); } catch { finished(); }
}

/** Whether this device is recording the given call right now. */
export function isRecording(voiceChannelId: string) {
  return recordingState.phase === 'recording' && recordingState.voiceChannelId === voiceChannelId;
}
