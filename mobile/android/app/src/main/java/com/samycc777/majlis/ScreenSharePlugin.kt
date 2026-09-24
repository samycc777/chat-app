package com.samycc777.majlis

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// A web page inside an app is not allowed to capture the screen, so the call screen asks this
// plugin instead. It joins the call a second time with a screen-only pass from the server and
// sends the screen there, while the page itself stays in the call for voice and camera.
@CapacitorPlugin(name = "ScreenShare")
class ScreenSharePlugin : Plugin() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var room: Room? = null
  private var starting = false

  @PluginMethod
  fun start(call: PluginCall) {
    if (call.getString("url").isNullOrBlank() || call.getString("token").isNullOrBlank()) {
      call.reject("Missing call details")
      return
    }
    if (room != null || starting) { call.resolve(); return }
    starting = true
    val projection = context.getSystemService(MediaProjectionManager::class.java)
    startActivityForResult(call, projection.createScreenCaptureIntent(), "onCaptureAnswered")
  }

  @PluginMethod
  fun stop(call: PluginCall) {
    finish()
    call.resolve()
  }

  @ActivityCallback
  private fun onCaptureAnswered(call: PluginCall?, result: ActivityResult) {
    val data = result.data
    if (call == null || result.resultCode != Activity.RESULT_OK || data == null) {
      starting = false
      call?.reject("Screen sharing was not allowed", "CANCELLED")
      return
    }
    val sharing = LiveKit.create(context.applicationContext)
    room = sharing
    starting = false
    // Android turns off an app's microphone while another app is on screen unless a notification
    // says it is in use, and showing another app is the point of sharing the screen.
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      ContextCompat.startForegroundService(context, Intent(context, ScreenShareService::class.java))
    }
    ScreenShareService.onStopRequested = { scope.launch { finish() } }
    scope.launch {
      try {
        sharing.connect(call.getString("url")!!, call.getString("token")!!)
        // The same notification as the service's, so the phone shows one "sharing" notice, not two.
        sharing.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(
          data,
          notificationId = ScreenShareService.NOTIFICATION_ID,
          notification = ScreenShareService.notification(context),
          onStop = { scope.launch { finish() } },
        ))
        call.resolve()
      } catch (error: Exception) {
        finish()
        call.reject("Screen sharing could not start", "FAILED")
        return@launch
      }
      // The server closes this connection when its owner leaves the call.
      sharing.events.collect { event -> if (event is RoomEvent.Disconnected) finish() }
    }
  }

  private fun finish() {
    val sharing = room ?: return
    room = null
    ScreenShareService.onStopRequested = null
    context.stopService(Intent(context, ScreenShareService::class.java))
    sharing.disconnect()
    sharing.release()
    notifyListeners("stopped", JSObject())
  }

  override fun handleOnDestroy() {
    finish()
  }
}
