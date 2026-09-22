package org.classroom.teacher

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class LessonService : Service() {

  companion object {
    const val CHANNEL_ID = "lesson_service"
    const val NOTIFICATION_ID = 201
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel_active_lesson), NotificationManager.IMPORTANCE_LOW)
    )
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val stopIntent = Intent(this, MainActivity::class.java).apply {
      action = MainActivity.STOP_LESSON_ACTION
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val pendingStop = PendingIntent.getActivity(this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_screen_share)
      .setContentTitle(getString(R.string.notification_lesson_title))
      .setContentText(getString(R.string.notification_lesson_text))
      .setOngoing(true)
      .addAction(0, getString(R.string.notification_end_lesson), pendingStop)
      .setContentIntent(PendingIntent.getActivity(this, 1,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      .build()

    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    acquireLocks()
    return START_STICKY
  }

  private fun acquireLocks() {
    if (wakeLock == null) {
      val pm = getSystemService(PowerManager::class.java)
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "classroom:lesson").apply { acquire() }
    }
    if (wifiLock == null) {
      val wm = applicationContext.getSystemService(WifiManager::class.java)
      @Suppress("DEPRECATION")
      wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "classroom:lesson").apply { acquire() }
    }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
    wifiLock?.let { if (it.isHeld) it.release() }; wifiLock = null
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
