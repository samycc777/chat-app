// Who is speaking, measured on this device from the voices themselves.
//
// LiveKit decides who is speaking on its servers and tells the call a little later, so the green
// glow around someone came on well after their voice started and stayed on after they stopped.
// Measuring each voice's loudness here follows what is heard within about a tenth of a second.
// When it cannot measure (no audio mixer allowed yet, or the call is in the background, where
// timers slow down), it says so, and the call falls back on LiveKit's answer.

// Louder than this is a voice. The voices arrive already cleaned of background noise (see
// cleanVoice.ts), so the silence between words is far below it.
const SPEECH_DB = -50;
const CHECK_EVERY_MS = 50;
// Two loud checks in a row, so a single click or tap does not light someone up.
const LOUD_CHECKS_TO_START = 2;
// The glow stays through the short gaps between words and breaths. Switching on and off with
// every syllable would make it flicker, which people sensitive to flashing find hard.
const HOLD_MS = 400;

interface Voice {
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  silent: GainNode;
  samples: Float32Array<ArrayBuffer>;
  loudChecks: number;
  lastLoudAt: number;
  speaking: boolean;
}

export function createSpeakingDetector(contextFor: () => AudioContext | undefined, onChange: () => void) {
  const voices = new Map<string, Voice>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function measuring() {
    return document.visibilityState === 'visible' && contextFor()?.state === 'running';
  }

  function check() {
    if (!measuring()) return;
    const now = Date.now();
    let changed = false;
    for (const voice of voices.values()) {
      voice.analyser.getFloatTimeDomainData(voice.samples);
      let power = 0;
      for (const sample of voice.samples) power += sample * sample;
      const loud = 10 * Math.log10(power / voice.samples.length || 1e-12) > SPEECH_DB;
      voice.loudChecks = loud ? voice.loudChecks + 1 : 0;
      if (voice.loudChecks >= LOUD_CHECKS_TO_START) voice.lastLoudAt = now;
      const speaking = now - voice.lastLoudAt < HOLD_MS;
      if (speaking !== voice.speaking) { voice.speaking = speaking; changed = true; }
    }
    if (changed) onChange();
  }

  function forget(identity: string) {
    const voice = voices.get(identity);
    if (!voice) return;
    [voice.source, voice.analyser, voice.silent].forEach(node => node.disconnect());
    voices.delete(identity);
    if (!voices.size) { clearInterval(timer); timer = undefined; }
  }

  function listen(identity: string, track: MediaStreamTrack) {
    const context = contextFor();
    if (!context) return;
    try {
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const analyser = new AnalyserNode(context, { fftSize: 1024 });
      // Some browsers only measure what reaches the speakers, so the voice goes there, silenced;
      // it is still played only by the call's own audio.
      const silent = new GainNode(context, { gain: 0 });
      source.connect(analyser).connect(silent).connect(context.destination);
      voices.set(identity, { track, source, analyser, silent, samples: new Float32Array(analyser.fftSize), loudChecks: 0, lastLoudAt: 0, speaking: false });
      timer ??= setInterval(check, CHECK_EVERY_MS);
    } catch { /* Not measured; LiveKit's answer is used for this voice. */ }
  }

  return {
    // Measures exactly these voices, by person: new ones are added, changed ones replaced and
    // the rest let go.
    follow(tracks: Map<string, MediaStreamTrack>) {
      for (const [identity, voice] of voices) {
        if (tracks.get(identity) !== voice.track || voice.track.readyState === 'ended') forget(identity);
      }
      for (const [identity, track] of tracks) {
        if (!voices.has(identity) && track.readyState === 'live') listen(identity, track);
      }
    },
    // Whether this person is speaking, or undefined when it cannot be measured here.
    speaking(identity: string): boolean | undefined {
      const voice = voices.get(identity);
      return voice && measuring() ? voice.speaking : undefined;
    },
    stop() {
      [...voices.keys()].forEach(forget);
    },
  };
}
