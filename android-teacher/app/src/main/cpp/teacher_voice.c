#include <jni.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include "rnnoise.h"

// How much louder the class hears the teacher than the microphone records. The limiter keeps the
// loudest words just under full scale, so only quieter speech gains the full amount.
#define VOICE_GAIN 2.0f
// WebRTC hands over samples as floats on the 16-bit scale; this is about 1 dB below its top.
#define LIMIT (0.89f * 32767.0f)
// After a loud word the limiter eases back to full gain over about this long.
#define RELEASE_SECONDS 0.1f
// RNNoise works on 10 ms at 48 kHz.
#define RNNOISE_FRAME 480
// Students found the voice too sharp, so it is made warmer before it is made louder: the bass is
// raised a little and the treble, where a small speaker starts to hurt, is turned down.
#define BASS_HZ 250.0f
#define BASS_DB 4.0f
#define TREBLE_HZ 3000.0f
#define TREBLE_DB -6.0f

typedef struct {
  float b0, b1, b2, a1, a2;
  float z1, z2;
} Shelf;

typedef struct {
  DenoiseState *denoiser;
  float limiter_gain;
  int sample_rate;
  Shelf bass, treble;
} TeacherVoice;

// A shelving filter from Robert Bristow-Johnson's Audio EQ Cookbook, with its gentlest slope.
// The high shelf is the low shelf with the signs of a few terms flipped.
static Shelf shelf_create(int high, float hz, float db, float sample_rate) {
  float s = high ? -1.0f : 1.0f;
  float a = powf(10.0f, db / 40.0f);
  float w = 2.0f * 3.14159265f * hz / sample_rate;
  float c = cosf(w);
  float k = sqrtf(2.0f * a) * sinf(w);
  float a0 = (a + 1.0f) + s * (a - 1.0f) * c + k;
  return (Shelf) {
    .b0 = a * ((a + 1.0f) - s * (a - 1.0f) * c + k) / a0,
    .b1 = 2.0f * s * a * ((a - 1.0f) - s * (a + 1.0f) * c) / a0,
    .b2 = a * ((a + 1.0f) - s * (a - 1.0f) * c - k) / a0,
    .a1 = -2.0f * s * ((a - 1.0f) + s * (a + 1.0f) * c) / a0,
    .a2 = ((a + 1.0f) + s * (a - 1.0f) * c - k) / a0,
  };
}

static float shelf_run(Shelf *shelf, float x) {
  float y = shelf->b0 * x + shelf->z1;
  shelf->z1 = shelf->b1 * x - shelf->a1 * y + shelf->z2;
  shelf->z2 = shelf->b2 * x - shelf->a2 * y;
  return y;
}

JNIEXPORT jlong JNICALL
Java_org_classroom_teacher_TeacherVoice_nativeCreate(JNIEnv *env, jobject self) {
  TeacherVoice *voice = calloc(1, sizeof(TeacherVoice));
  if (!voice) return 0;
  // NULL selects the model built into the library.
  voice->denoiser = rnnoise_create(NULL);
  voice->limiter_gain = 1.0f;
  return (jlong) (intptr_t) voice;
}

// Cleans and strengthens one 10 ms buffer of the microphone in place.
JNIEXPORT void JNICALL
Java_org_classroom_teacher_TeacherVoice_nativeProcess(JNIEnv *env, jobject self, jlong handle, jobject buffer, jint frames) {
  TeacherVoice *voice = (TeacherVoice *) (intptr_t) handle;
  float *samples = (*env)->GetDirectBufferAddress(env, buffer);
  if (!voice || !samples || frames <= 0) return;
  if ((*env)->GetDirectBufferCapacity(env, buffer) < (jlong) frames * (jlong) sizeof(float)) return;

  // At any other sample rate the voice is still made louder, just not denoised.
  if (voice->denoiser && frames == RNNOISE_FRAME) rnnoise_process_frame(voice->denoiser, samples, samples);

  // Every buffer is 10 ms long, so the sample rate is its length times 100.
  int sample_rate = frames * 100;
  if (sample_rate != voice->sample_rate) {
    voice->sample_rate = sample_rate;
    voice->bass = shelf_create(0, BASS_HZ, BASS_DB, (float) sample_rate);
    voice->treble = shelf_create(1, TREBLE_HZ, TREBLE_DB, (float) sample_rate);
  }
  float release = 1.0f - expf(-1.0f / (RELEASE_SECONDS * (float) sample_rate));
  float gain = voice->limiter_gain;
  for (jint i = 0; i < frames; i++) {
    // The tone is shaped before the voice is made louder, so the limiter still has the last word.
    float sample = shelf_run(&voice->treble, shelf_run(&voice->bass, samples[i])) * VOICE_GAIN;
    float peak = fabsf(sample);
    float target = peak > LIMIT ? LIMIT / peak : 1.0f;
    // Turns down at once for a peak, never letting it past the limit, and back up gradually.
    gain = target < gain ? target : gain + (target - gain) * release;
    samples[i] = sample * gain;
  }
  voice->limiter_gain = gain;
}

JNIEXPORT void JNICALL
Java_org_classroom_teacher_TeacherVoice_nativeDestroy(JNIEnv *env, jobject self, jlong handle) {
  TeacherVoice *voice = (TeacherVoice *) (intptr_t) handle;
  if (!voice) return;
  if (voice->denoiser) rnnoise_destroy(voice->denoiser);
  free(voice);
}
