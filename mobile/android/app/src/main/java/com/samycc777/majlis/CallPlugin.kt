package com.samycc777.majlis

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import androidx.activity.OnBackPressedCallback
import androidx.annotation.RequiresApi
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// The call screen tells the app when a call starts and ends, so the app can keep the call going
// while its owner is in another app (see CallService). While there is someone's camera or screen
// to watch, it also asks for the small window: leaving the app then shrinks it into a small window
// on top of the other apps, as in a WhatsApp video call, and the page shows just that video.
// When someone shows a video full screen, it hides the phone's own bars and can turn the app sideways.
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
  // During full screen, Back only leaves full screen, as in a video app, instead of closing the app.
  private val leaveFullScreen = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() {
      notifyListeners("fullScreenExit", JSObject())
    }
  }

  override fun load() {
    activity.addOnUserLeaveHintListener(onLeaveApp)
    activity.addOnPictureInPictureModeChangedListener(onMiniWindowChanged)
    activity.onBackPressedDispatcher.addCallback(activity, leaveFullScreen)
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

  @PluginMethod
  fun setFullScreen(call: PluginCall) {
    val on = call.getBoolean("on") ?: false
    val landscape = call.getBoolean("landscape") ?: false
    activity.runOnUiThread {
      showFullScreen(on, landscape)
      call.resolve()
    }
  }

  // The phone's status and navigation bars are hidden; a swipe from the edge shows them for a moment.
  // A wide video, such as a computer's screen, turns the app sideways even when the phone's own
  // rotation is locked, as YouTube does.
  private fun showFullScreen(on: Boolean, landscape: Boolean) {
    val bars = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
    if (on) {
      bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      bars.hide(WindowInsetsCompat.Type.systemBars())
    } else {
      bars.show(WindowInsetsCompat.Type.systemBars())
    }
    activity.requestedOrientation =
      if (on && landscape) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    leaveFullScreen.isEnabled = on
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
      showFullScreen(false, false)
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
    leaveFullScreen.remove()
    finish()
  }
}
