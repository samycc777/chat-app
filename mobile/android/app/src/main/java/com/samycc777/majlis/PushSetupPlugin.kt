package com.samycc777.majlis

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Notifications arrive through Firebase, which only works in an app built with the project's
// google-services.json (see mobile/README.md). Without that file the push plugin would crash the
// app when asked to register, so the page asks here first and simply does not offer notifications.
// This also makes the channel the server sends to, with a plain name people see in Android's settings.
@CapacitorPlugin(name = "PushSetup")
class PushSetupPlugin : Plugin() {
  companion object {
    // The server names this channel in every message (server/push.ts), and AndroidManifest.xml
    // makes it Firebase's default.
    const val CHANNEL_ID = "messages"
  }

  override fun load() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java)
    // Messages from friends should pop up like any chat app's, with the phone's own sound.
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel), NotificationManager.IMPORTANCE_HIGH)
    )
  }

  @PluginMethod
  fun status(call: PluginCall) {
    // The google-services Gradle plugin turns google-services.json into this resource.
    @Suppress("DiscouragedApi")
    val firebase = context.resources.getIdentifier("google_app_id", "string", context.packageName) != 0
    call.resolve(JSObject().put("firebase", firebase))
  }
}
