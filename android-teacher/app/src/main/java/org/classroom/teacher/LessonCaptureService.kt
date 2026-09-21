package org.classroom.teacher

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class LessonCaptureService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val channelId = "lesson_capture"
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(channelId, "Lesson sharing", NotificationManager.IMPORTANCE_LOW))
    val notification = NotificationCompat.Builder(this, channelId)
      .setSmallIcon(R.drawable.ic_screen_share)
      .setContentTitle("Lesson screen sharing is active")
      .setContentText("Return to Classroom Teacher to stop sharing.")
      .addAction(0, "Stop lesson", PendingIntent.getActivity(this, 0,
        Intent(this, MainActivity::class.java).setAction(MainActivity.STOP_LESSON_ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      .setOngoing(true)
      .build()
    ServiceCompat.startForeground(this, 101, notification,
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    return START_NOT_STICKY
  }
  override fun onBind(intent: Intent?): IBinder? = null
}
