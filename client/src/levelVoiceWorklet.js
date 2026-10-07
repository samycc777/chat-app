// Runs inside the browser's audio thread (see cleanVoice.ts), so it keeps working while the app is
// in the background, where the page's own timers slow down to almost nothing.
//
// It measures how loud this person speaks, only while they speak, and slowly turns their voice up
// or down until it reaches the same level as everyone else's. Measuring only the words, never the
// quiet between them, keeps it from turning up the leftover noise of the house.

// The level every voice is brought to, as the loud part of its words (see below): what the browser's own
// leveling gives an ordinary voice, measured in October 2026, so most voices barely change.
const TARGET_DB = -10;
// The browser's own leveling is off (see microphoneOptions in CallView.vue), so this also makes up
// for phones that record much more softly than others. A whisper far from the phone is raised at
// most this much, so what is left of the noise under it is not raised too far with it; a shout
// close to it is lowered at most this much.
const MAX_UP_DB = 24;
const MAX_DOWN_DB = -12;
// The voice is measured in pieces of 10 ms. (sampleRate is given to every audio-thread script.)
const PIECE = Math.round(sampleRate / 100);
// A piece counts as speech when it is this loud and clearly above the quiet between words.
const SPEECH_GATE_DB = -55;
const ABOVE_QUIET_DB = 12;
// The level follows the loud part of the person's words: it rises within half a second when they
// speak up, but sinks only over about fifteen seconds of quieter sound. Someone's voice is the
// loudest thing near their phone, so a television or people talking in another room, softer than
// that, are not raised to a voice's level even when they go on for a while. During the first three
// seconds of speech it moves twenty times faster, so a soft voice is raised within its first sentence.
const RISE_PIECES = 50;
const SINK_PIECES = 1500;
// Sounds far softer than the person's voice, such as people talking in another room while they are
// silent, barely move it at all: over many minutes rather than seconds.
const FAR_BELOW_DB = 12;
const FAR_BELOW_PIECES = 30000;
const SETTLING_PIECES = 300;
const SETTLING_SPEED = 20;
// Gain changes are spread over about a fifth of a second, so they are never heard as a jump.
const GAIN_SMOOTHING = 1 / (0.2 * sampleRate);

const toGain = db => 10 ** (db / 20);

class LevelVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.speechDb = TARGET_DB;
    this.speechPieces = 0;
    this.quietDb = -70;
    this.sum = 0;
    this.count = 0;
    this.targetGain = 1;
    this.gain = this.targetGain;
  }

  measure(power) {
    const db = 10 * Math.log10(power + 1e-12);
    // The quiet between words: it follows a quieter piece at once and a louder one only very slowly.
    this.quietDb = db < this.quietDb ? db : this.quietDb + (db - this.quietDb) * 0.0005;
    if (db < SPEECH_GATE_DB || db < this.quietDb + ABOVE_QUIET_DB) return;
    const settling = this.speechPieces < SETTLING_PIECES;
    if (settling) this.speechPieces++;
    const sinking = !settling && db < this.speechDb - FAR_BELOW_DB ? FAR_BELOW_PIECES : SINK_PIECES;
    const pieces = (db > this.speechDb ? RISE_PIECES : sinking) / (settling ? SETTLING_SPEED : 1);
    this.speechDb += (db - this.speechDb) / pieces;
    const changeDb = Math.min(MAX_UP_DB, Math.max(MAX_DOWN_DB, TARGET_DB - this.speechDb));
    this.targetGain = toGain(changeDb);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) { output.fill(0); return true; }
    for (let i = 0; i < input.length; i++) {
      const sample = input[i];
      this.sum += sample * sample;
      if (++this.count === PIECE) {
        this.measure(this.sum / PIECE);
        this.sum = 0;
        this.count = 0;
      }
      this.gain += (this.targetGain - this.gain) * GAIN_SMOOTHING;
      output[i] = sample * this.gain;
    }
    return true;
  }
}

registerProcessor('level-voice', LevelVoice);
