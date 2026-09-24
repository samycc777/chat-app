package com.samycc777.majlis

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// The call screen tells the app when a call starts and ends, so the app can keep the call going
// while its owner is in another app (see CallService).
@CapacitorPlugin(name = "Call")
class CallPlugin : Plugin() {
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

  private fun finish() {
    CallService.onLeaveRequested = null
    context.stopService(Intent(context, CallService::class.java))
  }

  override fun handleOnDestroy() {
    finish()
  }
}
