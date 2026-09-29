package com.samycc777.majlis

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper

// During a call, the app's browser engine (Chrome's) picks where the call's sound plays: earphones
// when they are plugged in, otherwise the phone's speaker. It is told about earphones by a message
// that can arrive before Android lists them, so after earphones were taken out and plugged back in,
// the sound often stayed on the speaker until the call was rejoined (September 2026). This follows
// Android's own list of devices instead, which is complete by the time it reports a change, and
// makes the same choice the engine would have made.
class EarphoneRoute(context: Context) {
  companion object {
    // The engine's order: wired earphones, then USB, then Bluetooth, then the speaker.
    private val PREFERRED = listOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
    )
    private val WIRED = setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
    )
    // Checked again a moment later too, in case the engine made its own, older choice after ours.
    private const val RECHECK_MS = 700L
  }

  private val audioManager = context.getSystemService(AudioManager::class.java)
  private val handler = Handler(Looper.getMainLooper())
  private val recheck = Runnable { follow() }
  private var listening = false
  private val onChange = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = changed()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = changed()
  }

  fun start() {
    if (listening || audioManager == null) return
    listening = true
    audioManager.registerAudioDeviceCallback(onChange, handler)
  }

  fun stop() {
    if (!listening) return
    listening = false
    handler.removeCallbacks(recheck)
    audioManager?.unregisterAudioDeviceCallback(onChange)
  }

  private fun changed() {
    follow()
    handler.removeCallbacks(recheck)
    handler.postDelayed(recheck, RECHECK_MS)
  }

  private fun follow() {
    val audio = audioManager ?: return
    // Only while the call's sound is a call's, which is while the microphone is open. Otherwise
    // Android already plays the sound in the earphones by itself.
    if (!listening || audio.mode != AudioManager.MODE_IN_COMMUNICATION) return
    try {
      if (Build.VERSION.SDK_INT >= 31) {
        val available = audio.availableCommunicationDevices
        val wanted = PREFERRED.firstNotNullOfOrNull { type -> available.firstOrNull { it.type == type } } ?: return
        if (audio.communicationDevice?.id != wanted.id) audio.setCommunicationDevice(wanted)
      } else {
        // Older Android has only the speaker switch. Bluetooth is left to the engine, which has to
        // open a separate connection to it.
        val wired = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in WIRED }
        @Suppress("DEPRECATION")
        if (wired && audio.isSpeakerphoneOn) audio.isSpeakerphoneOn = false
      }
    } catch (error: Exception) {
      // The sound stays where it is; rejoining the call still fixes it.
    }
  }
}
