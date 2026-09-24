import type { AudioProcessorOptions, LocalTrack, Track, TrackProcessor } from 'livekit-client';

// A warmer tone for every voice: a little more bass, and less of the sharp treble that hurts on
// small speakers. It is applied to the microphone before the voice is sent, so everyone in the call
// hears it, whatever they listen on.
const BASS_HZ = 250;
const BASS_DB = 4;
const TREBLE_HZ = 3000;
const TREBLE_DB = -6;

// While the page's audio is paused, as on an iPhone that has just been in another app, anything
// shaped here would reach the class as silence, so the voice is then sent exactly as recorded.
export function warmVoice(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let context: AudioContext;
  let localTrack: LocalTrack | undefined;
  let nodes: AudioNode[] = [];
  const paused = () => context.state !== 'running' && context.state !== 'closed';
  const sendAsRecorded = () => { void localTrack?.stopProcessor().catch(() => {}); };
  const onStateChange = () => { if (processor.processedTrack && paused()) sendAsRecorded(); };

  function shape(track: MediaStreamTrack) {
    release();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const bass = new BiquadFilterNode(context, { type: 'lowshelf', frequency: BASS_HZ, gain: BASS_DB });
    const treble = new BiquadFilterNode(context, { type: 'highshelf', frequency: TREBLE_HZ, gain: TREBLE_DB });
    // The extra bass can push a loud word past the top, so a limiter keeps it from crackling.
    const limiter = new DynamicsCompressorNode(context, { threshold: -2, knee: 0, ratio: 20, attack: 0.002, release: 0.1 });
    const destination = context.createMediaStreamDestination();
    source.connect(bass).connect(treble).connect(limiter).connect(destination);
    nodes = [source, bass, treble, limiter, destination];
    processor.processedTrack = destination.stream.getAudioTracks()[0];
  }
  function release() {
    nodes.forEach(node => node.disconnect());
    nodes = [];
    processor.processedTrack?.stop();
    processor.processedTrack = undefined;
  }

  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: 'warm-voice',
    async init(options) {
      context = options.audioContext;
      localTrack = options.localTrack;
      if (paused()) await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, 200))]);
      // LiveKit then keeps sending the microphone as it is.
      if (context.state !== 'running') throw new Error('Call audio is paused');
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
    },
  };
  return processor;
}
