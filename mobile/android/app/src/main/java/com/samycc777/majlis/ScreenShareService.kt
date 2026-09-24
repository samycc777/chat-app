package com.samycc777.majlis

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// Runs while the phone shares its screen. Its notification tells Android that the call still uses
// the microphone while another app is in front, and gives a Stop sharing button.
class ScreenShareService : Service() {
  companion object {
    const val NOTIFICATION_ID = 301
    private const val CHANNEL_ID = "screen_share"
    private const val ACTION_STOP = "com.samycc777.majlis.STOP_SHARING"
    var onStopRequested: (() -> Unit)? = null

    fun notification(context: Context): Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, context.getString(R.string.screen_share_channel), NotificationManager.IMPORTANCE_LOW)
        )
      }
      val open = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val stop = PendingIntent.getService(
        context, 1,
        Intent(context, ScreenShareService::class.java).setAction(ACTION_STOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_screen_share)
        .setContentTitle(context.getString(R.string.screen_share_title))
        .setContentText(context.getString(R.string.screen_share_text))
        .setOngoing(true)
        .setContentIntent(open)
        .addAction(0, context.getString(R.string.screen_share_stop), stop)
        .build()
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      onStopRequested?.invoke() ?: stopSelf()
      return START_NOT_STICKY
    }
    val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this), type)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
