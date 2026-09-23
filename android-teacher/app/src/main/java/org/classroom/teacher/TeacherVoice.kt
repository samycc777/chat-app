package org.classroom.teacher

import io.livekit.android.audio.AudioProcessorInterface
import java.nio.ByteBuffer

// Cleans up and strengthens the teacher's microphone before the class hears it: RNNoise removes
// the noise of the house, then the voice is made louder, with a limiter so loud words never
// crackle. WebRTC runs this after its echo cancellation, on 10 ms of audio at a time, and it is
// always on: students turn the teacher down on their side if they want.
class TeacherVoice : AudioProcessorInterface {
  companion object {
    // Without the native library the lesson still runs, with the microphone as it was.
    private val loaded = runCatching { System.loadLibrary("teachervoice") }.isSuccess
  }

  private val lock = Any()
  private var handle = if (loaded) nativeCreate() else 0L

  override fun isEnabled() = handle != 0L
  override fun getName() = "teacher-voice"
  // The buffer length tells the native code the sample rate, so there is nothing to prepare.
  override fun initializeAudioProcessing(sampleRateHz: Int, numChannels: Int) = Unit
  override fun resetAudioProcessing(newRate: Int) = Unit

  override fun processAudio(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
    synchronized(lock) { if (handle != 0L) nativeProcess(handle, buffer, numFrames) }
  }

  // WebRTC may still be finishing a buffer on its audio thread when the lesson ends.
  fun release() {
    synchronized(lock) {
      if (handle != 0L) nativeDestroy(handle)
      handle = 0L
    }
  }

  private external fun nativeCreate(): Long
  private external fun nativeProcess(handle: Long, buffer: ByteBuffer, frames: Int)
  private external fun nativeDestroy(handle: Long)
}
