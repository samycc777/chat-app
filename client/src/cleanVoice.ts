import type { AudioProcessorOptions, LocalTrack, Track, TrackProcessor } from 'livekit-client';
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// Every voice is cleaned before it is sent, so everyone in the call hears it the same way, whatever
// they listen on. Zoom does much the same, and the old teacher app did it for the teacher alone.
//
// Rumble from traffic, fans and desk bumps sits below any voice, so it is cut first.
const LOW_CUT_HZ = 90;
// RNNoise, an open-source noise filter that runs on the device, then removes the noise of the house
// between and under the words. It only understands sound at 48 kHz.
const FILTER_SAMPLE_RATE = 48_000;
// The warmer tone students asked for: a little more bass, and a little less of the treble that turns
// harsh on small speakers. The treble is only turned down gently and high up, so the hissing
// consonants that tell س, ص, ث and ش apart stay clear.
const BASS_HZ = 200;
const BASS_DB = 3;
const TREBLE_HZ = 4500;
const TREBLE_DB = -3;
// The browser already evens out each voice's level; it is then made a little louder, as the old
// teacher app did, and a limiter keeps the loudest words from crackling. A compressor was tried
// here too, but it brought the leftover noise between words back up.
const LOUDER_DB = 4;
const LIMIT_DB = -6;
// Chrome's limiter quietly adds its own boost after limiting, and lets the start of each loud word
// through before it reacts. With the limit at -3 dB, that pushed ordinary speech past full scale,
// where it is cut off when sent: the crackling students heard in a lesson in September 2026. The
// voice is turned back down after the limiter so its loudest peaks stay about 1 dB below full scale,
// and a gentle ceiling rounds off anything that still gets through instead of cutting it off.
const AFTER_LIMIT_DB = -2;
const CEILING_FROM = 0.9;

export type CleanVoice = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> & {
  /** Whether the noise filter is running, rather than only the tone and loudness shaping. */
  readonly denoising: boolean;
  /** The microphone as recorded; LiveKit's own track for it is this processor's output. */
  readonly recordedTrack: MediaStreamTrack | undefined;
};

// Leaves the voice untouched up to CEILING_FROM of full scale, then bends smoothly towards it.
const ceilingCurve = (() => {
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) {
    const x = i / 1024 - 1;
    const size = Math.abs(x);
    curve[i] = Math.sign(x) * (size <= CEILING_FROM ? size : CEILING_FROM + (1 - CEILING_FROM) * Math.tanh((size - CEILING_FROM) / (1 - CEILING_FROM)));
  }
  return curve;
})();

let filterBinary: Promise<ArrayBuffer | null> | undefined;
const filterLoaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

function loadFilterBinary() {
  if (typeof AudioWorkletNode !== 'function' || typeof WebAssembly !== 'object') return Promise.resolve(null);
  filterBinary ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch(() => {
    // A dropped connection is tried again the next time the microphone is turned on.
    filterBinary = undefined;
    return null;
  });
  return filterBinary;
}
/**
 * Fetches the noise filter, once per page. It resolves to false where the browser cannot run it;
 * the browser's own, milder noise filter is then left on.
 */
export async function prepareCleanVoice() {
  return Boolean(await loadFilterBinary());
}
/**
 * Downloads everything the noise filter needs while the app is idle, so joining a call later does
 * not wait for it: on slow internet those files took seconds, and the microphone waited with them.
 */
export function preloadCleanVoice() {
  void loadFilterBinary();
  // The browser keeps this file for a year, so turning the filter on later reads it from the device.
  if (typeof AudioWorkletNode === 'function') void fetch(rnnoiseWorkletUrl).catch(() => {});
}
function loadFilter(context: BaseAudioContext) {
  let loaded = filterLoaded.get(context);
  if (!loaded) {
    loaded = context.audioWorklet.addModule(rnnoiseWorkletUrl).then(() => true, () => false);
    filterLoaded.set(context, loaded);
  }
  return loaded;
}

// While the page's audio is paused, as on an iPhone that has just been in another app, anything
// shaped here would reach the call as silence, so the voice is then sent exactly as recorded.
export function cleanVoice(): CleanVoice {
  let context: AudioContext;
  // Only when the call's own audio does not run at 48 kHz, as on some computers.
  let ownContext: AudioContext | undefined;
  let binary: ArrayBuffer | null = null;
  let localTrack: LocalTrack | undefined;
  let nodes: AudioNode[] = [];
  let denoising = false;
  let recordedTrack: MediaStreamTrack | undefined;
  const paused = () => context.state !== 'running' && context.state !== 'closed';
  const sendAsRecorded = () => { void localTrack?.stopProcessor().catch(() => {}); };
  const onStateChange = () => { if (processor.processedTrack && paused()) sendAsRecorded(); };

  function shape(track: MediaStreamTrack) {
    release();
    recordedTrack = track;
    const source = context.createMediaStreamSource(new MediaStream([track]));
    // Some microphones record in stereo; the voice is mixed down to one channel here, because the
    // noise filter only cleans one, and Opus sends one anyway.
    const lowCut = new BiquadFilterNode(context, {
      type: 'highpass', frequency: LOW_CUT_HZ, Q: Math.SQRT1_2, channelCount: 1, channelCountMode: 'explicit',
    });
    const noiseFilter = binary ? new RnnoiseWorkletNode(context, { wasmBinary: binary, maxChannels: 1 }) : null;
    const bass = new BiquadFilterNode(context, { type: 'lowshelf', frequency: BASS_HZ, gain: BASS_DB });
    const treble = new BiquadFilterNode(context, { type: 'highshelf', frequency: TREBLE_HZ, gain: TREBLE_DB });
    const louder = new GainNode(context, { gain: 10 ** (LOUDER_DB / 20) });
    const limiter = new DynamicsCompressorNode(context, { threshold: LIMIT_DB, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
    const afterLimit = new GainNode(context, { gain: 10 ** (AFTER_LIMIT_DB / 20) });
    const ceiling = new WaveShaperNode(context, { curve: ceilingCurve });
    const destination = context.createMediaStreamDestination();
    nodes = [source, lowCut, ...(noiseFilter ? [noiseFilter] : []), bass, treble, louder, limiter, afterLimit, ceiling, destination];
    nodes.reduce((from, to) => from.connect(to));
    denoising = Boolean(noiseFilter);
    processor.processedTrack = destination.stream.getAudioTracks()[0];
  }
  function release() {
    for (const node of nodes) {
      node.disconnect();
      // Frees the noise filter's memory inside the audio thread.
      if (node instanceof RnnoiseWorkletNode) node.destroy();
    }
    nodes = [];
    denoising = false;
    processor.processedTrack?.stop();
    processor.processedTrack = undefined;
  }

  const processor: CleanVoice = {
    name: 'clean-voice',
    get denoising() { return denoising; },
    get recordedTrack() { return recordedTrack; },
    async init(options) {
      localTrack = options.localTrack;
      context = options.audioContext;
      binary = await loadFilterBinary();
      if (binary && context.sampleRate !== FILTER_SAMPLE_RATE) {
        try {
          ownContext = new AudioContext({ sampleRate: FILTER_SAMPLE_RATE, latencyHint: 'interactive' });
          context = ownContext;
        } catch {
          // The voice is still shaped, just without the noise filter.
          binary = null;
        }
      }
      if (paused()) await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, 200))]);
      // LiveKit then keeps sending the microphone as it is.
      if (context.state !== 'running') throw new Error('Call audio is paused');
      if (binary && !await loadFilter(context)) binary = null;
      shape(options.track);
      context.addEventListener('statechange', onStateChange);
    },
    // A new microphone, such as after earphones are plugged in; LiveKit does not pass the context again.
    async restart(options) {
      if (paused()) { release(); sendAsRecorded(); } else shape(options.track);
    },
    async destroy() {
      context?.removeEventListener('statechange', onStateChange);
      release();
      void ownContext?.close().catch(() => {});
      ownContext = undefined;
    },
  };
  return processor;
}
