package com.samycc777.majlis

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import androidx.annotation.RequiresApi
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// The call screen tells the app when a call starts and ends, so the app can keep the call going
// while its owner is in another app (see CallService). While there is someone's camera or screen
// to watch, it also asks for the small window: leaving the app then shrinks it into a small window
// on top of the other apps, as in a WhatsApp video call, and the page shows just that video.
@CapacitorPlugin(name = "Call")
class CallPlugin : Plugin() {
  companion object {
    // Android refuses small windows narrower or wider than these shapes.
    private val NARROWEST = Rational(100, 239)
    private val WIDEST = Rational(239, 100)
  }

  // The shape of the video to show in the small window, or null when there is nothing to watch.
  private var miniWindow: Rational? = null
  private val onLeaveApp = Runnable { enterMiniWindow() }
  private val onMiniWindowChanged = Consumer<PictureInPictureModeChangedInfo> { info ->
    notifyListeners("miniWindow", JSObject().put("active", info.isInPictureInPictureMode))
  }

  override fun load() {
    activity.addOnUserLeaveHintListener(onLeaveApp)
    activity.addOnPictureInPictureModeChangedListener(onMiniWindowChanged)
  }

  @PluginMethod
  fun start(call: PluginCall) {
    CallService.onLeaveRequested = { notifyListeners("leave", JSObject()) }
    // Starting it again after the microphone is allowed lets the running service claim it.
    try {
      ContextCompat.startForegroundService(context, Intent(context, CallService::class.java))
      call.resolve()
    } catch (error: Exception) {
      // Android only lets an app start this while it is on screen; the call still works then.
      call.reject("The call could not be kept going in the background", "FAILED")
    }
  }

  @PluginMethod
  fun stop(call: PluginCall) {
    finish()
    call.resolve()
  }

  @PluginMethod
  fun setMiniWindow(call: PluginCall) {
    val width = call.getInt("width") ?: 0
    val height = call.getInt("height") ?: 0
    val shape = if (width > 0 && height > 0) Rational(width, height) else null
    activity.runOnUiThread {
      miniWindow = shape
      updateMiniWindow()
      call.resolve()
    }
  }

  // Phones with little memory, and Android before 8, have no small windows.
  private fun canShrink() =
    Build.VERSION.SDK_INT >= 26 && activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  @RequiresApi(26)
  private fun miniWindowParams(): PictureInPictureParams {
    val shape = miniWindow ?: Rational(16, 9)
    val builder = PictureInPictureParams.Builder()
      .setAspectRatio(if (shape < NARROWEST) NARROWEST else if (shape > WIDEST) WIDEST else shape)
    // Android 12 and newer shrink the app by themselves as it is left, with a smoother animation.
    // Seamless resizing is meant for text, not video, which it would show stretched for a moment.
    if (Build.VERSION.SDK_INT >= 31) builder.setAutoEnterEnabled(miniWindow != null).setSeamlessResizeEnabled(false)
    return builder.build()
  }

  // Also reshapes the small window when it is already showing, for example when someone starts
  // sharing a wide screen while a camera held upright was shown.
  private fun updateMiniWindow() {
    if (!canShrink()) return
    try {
      activity.setPictureInPictureParams(miniWindowParams())
    } catch (error: Exception) {
      // The person may have turned small windows off for the app in the phone's settings.
    }
  }

  private fun enterMiniWindow() {
    // Android 12 and newer do this themselves (setAutoEnterEnabled above).
    if (miniWindow == null || Build.VERSION.SDK_INT >= 31 || !canShrink()) return
    try {
      activity.enterPictureInPictureMode(miniWindowParams())
    } catch (error: Exception) {
      // Same as above: the app then just goes to the background, and the call carries on.
    }
  }

  private fun finish() {
    CallService.onLeaveRequested = null
    context.stopService(Intent(context, CallService::class.java))
    activity.runOnUiThread {
      miniWindow = null
      updateMiniWindow()
      // Leaving the call from the notification would otherwise leave a tiny copy of the chat on
      // top of the other apps; the app goes to the background instead, as if the window was closed.
      if (Build.VERSION.SDK_INT >= 26 && activity.isInPictureInPictureMode) activity.moveTaskToBack(false)
    }
  }

  override fun handleOnDestroy() {
    activity.removeOnUserLeaveHintListener(onLeaveApp)
    activity.removeOnPictureInPictureModeChangedListener(onMiniWindowChanged)
    finish()
  }
}
