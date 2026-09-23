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

typedef struct {
  DenoiseState *denoiser;
  float limiter_gain;
} TeacherVoice;

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
  float release = 1.0f - expf(-1.0f / (RELEASE_SECONDS * (float) frames * 100.0f));
  float gain = voice->limiter_gain;
  for (jint i = 0; i < frames; i++) {
    float sample = samples[i] * VOICE_GAIN;
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
