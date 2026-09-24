package com.samycc777.majlis

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

// Runs while the person is in a voice call. Without it, Android silences the app's microphone and
// lets its sound die as soon as another app comes to the front, so nobody could hear each other.
// Its notification says the call is still going and gives a Leave call button.
class CallService : Service() {
  companion object {
    const val NOTIFICATION_ID = 302
    private const val CHANNEL_ID = "voice_call"
    private const val ACTION_LEAVE = "com.samycc777.majlis.LEAVE_CALL"
    var onLeaveRequested: (() -> Unit)? = null
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_LEAVE) {
      onLeaveRequested?.invoke() ?: stopSelf()
      return START_NOT_STICKY
    }
    // Android refuses to keep the microphone for an app that was never allowed to use it, so a
    // person who said no to the microphone keeps only the sound of the call.
    val microphone = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val type = when {
      Build.VERSION.SDK_INT < 29 -> 0
      microphone && Build.VERSION.SDK_INT >= 30 -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      else -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    }
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
    } catch (error: Exception) {
      // Android can still refuse the microphone, for example when it was allowed only once. Keeping
      // the sound is better than closing the app over it.
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0)
    }
    return START_NOT_STICKY
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, getString(R.string.call_channel), NotificationManager.IMPORTANCE_LOW)
      )
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val leave = PendingIntent.getService(
      this, 2,
      Intent(this, CallService::class.java).setAction(ACTION_LEAVE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_call)
      .setContentTitle(getString(R.string.call_title))
      .setContentText(getString(R.string.call_text))
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setContentIntent(open)
      .addAction(0, getString(R.string.call_leave), leave)
      .build()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
