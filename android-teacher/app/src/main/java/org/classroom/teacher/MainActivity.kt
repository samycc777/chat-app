package org.classroom.teacher

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class MainActivity : AppCompatActivity() {
  companion object { const val STOP_LESSON_ACTION = "org.classroom.teacher.STOP_LESSON" }
  private lateinit var serverUrl: EditText
  private lateinit var classCode: EditText
  private lateinit var displayName: EditText
  private lateinit var status: TextView
  private lateinit var startStop: Button
  private lateinit var mute: Button
  private var authToken: String? = null
  private var userId: String? = null
  private var socket: Socket? = null
  private var room: Room? = null
  private var sharing = false

  private fun buildCaptureNotification(): android.app.Notification {
    val channelId = "lesson_capture"
    val manager = getSystemService(android.app.NotificationManager::class.java)
    manager.createNotificationChannel(android.app.NotificationChannel(channelId, "Lesson sharing", android.app.NotificationManager.IMPORTANCE_LOW))
    return androidx.core.app.NotificationCompat.Builder(this, channelId)
      .setSmallIcon(R.drawable.ic_screen_share)
      .setContentTitle("Lesson screen sharing is active")
      .setContentText("Return to Classroom Teacher to stop sharing.")
      .setOngoing(true)
      .build()
  }

  private val screenCapture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode != Activity.RESULT_OK || result.data == null) { setStatus("Screen sharing was cancelled"); return@registerForActivityResult }
    lifecycleScope.launch {
      try {
        room?.localParticipant?.setScreenShareEnabled(true, ScreenCaptureParams(result.data!!,
          notificationId = 101,
          notification = buildCaptureNotification(),
          onStop = { runOnUiThread { stopLesson("Android stopped screen sharing") } }
        ))
        sharing = true; startStop.text = "Stop lesson"; mute.visibility = View.VISIBLE
        setStatus("Sharing. Switch to JNotes and teach.")
      } catch (error: Exception) { stopLesson("Could not start screen sharing") }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 56, 40, 40); gravity = Gravity.CENTER_HORIZONTAL }
    serverUrl = field(root, "Website URL", "https://nurturing-dedication-production-9379.up.railway.app")
    classCode = field(root, "Class code", "0000")
    displayName = field(root, "Teacher name", "test")
    startStop = Button(this).apply { text = "Start lesson"; setOnClickListener { if (sharing) stopLesson("Lesson stopped") else startLesson() } }
    mute = Button(this).apply { text = "Mute microphone"; visibility = View.GONE; setOnClickListener { toggleMute() } }
    status = TextView(this).apply { text = "Sign in, then start a lesson. The PDF stays in JNotes on this phone."; setPadding(0, 28, 0, 0) }
    root.addView(startStop); root.addView(mute); root.addView(status)
    setContentView(root)
    if (intent.action == STOP_LESSON_ACTION) stopLesson("Lesson stopped")
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == STOP_LESSON_ACTION) stopLesson("Lesson stopped")
  }

  private fun field(root: LinearLayout, label: String, hint: String): EditText {
    root.addView(TextView(this).apply { text = label })
    return EditText(this).also { it.setText(hint); root.addView(it, LinearLayout.LayoutParams(-1, -2)) }
  }

  private val permissionsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results: Map<String, Boolean> ->
    if (results[Manifest.permission.RECORD_AUDIO] != true) { setStatus("Microphone permission is required"); return@registerForActivityResult }
    lifecycleScope.launch { doStartLesson() }
  }

  private fun startLesson() {
    val needed = mutableListOf<String>()
    if (ActivityCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.RECORD_AUDIO)
    if (android.os.Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.POST_NOTIFICATIONS)
    if (needed.isNotEmpty()) { permissionsLauncher.launch(needed.toTypedArray()); return }
    lifecycleScope.launch { doStartLesson() }
  }

  private suspend fun doStartLesson() {
    try {
      setStatus("Signing in…")
      val identity = joinClass()
      authToken = identity.getString("token")
      userId = identity.getJSONObject("user").getString("id")
      connectSocket(authToken!!)
      socket?.on("wb_started") { data ->
        val started = data.firstOrNull() as? JSONObject ?: return@on
        runOnUiThread {
          if (started.optString("presenterId") == userId) lifecycleScope.launch { connectLessonMedia() }
          else setStatus("Another teacher already has an active lesson.")
        }
      }
      socket?.on(Socket.EVENT_CONNECT) {
        socket?.emit("wb_start", JSONObject().put("conversationId", "classroom"))
      }
      socket?.on(Socket.EVENT_CONNECT_ERROR) { args ->
        val msg = (args.firstOrNull() as? Exception)?.message ?: "Socket connection failed"
        runOnUiThread { stopLesson("Connection error: $msg") }
      }
      socket?.connect()
    } catch (error: Exception) { stopLesson("Could not connect. Check the website URL and lesson configuration.") }
  }

  private suspend fun connectLessonMedia() {
    try {
      if (room != null) return
      val credentials = getCredentials(authToken!!)
      livekit.org.webrtc.PeerConnectionFactory.initialize(
        livekit.org.webrtc.PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
      )
      val keyProvider = BaseKeyProvider().also { it.setSharedKey(credentials.getString("encryptionKey")) }
      room = LiveKit.create(applicationContext, options = RoomOptions(e2eeOptions = E2EEOptions(keyProvider = keyProvider)))
      room!!.connect(credentials.getString("url"), credentials.getString("token"))
      room!!.localParticipant.setMicrophoneEnabled(true)
      val projection = getSystemService(MediaProjectionManager::class.java)
      screenCapture.launch(projection.createScreenCaptureIntent())
    } catch (error: Exception) { stopLesson("Could not connect. Check the website URL and lesson configuration.") }
  }

  private fun toggleMute() = lifecycleScope.launch {
    val enabled = room?.localParticipant?.isMicrophoneEnabled == true
    room?.localParticipant?.setMicrophoneEnabled(!enabled)
    mute.text = if (enabled) "Unmute microphone" else "Mute microphone"
  }

  private fun stopLesson(message: String) = lifecycleScope.launch {
    if (!sharing && room == null) { setStatus(message); return@launch }
    sharing = false
    try { room?.localParticipant?.setScreenShareEnabled(false); room?.disconnect(); room?.release() } catch (_: Exception) { }
    socket?.emit("wb_end", JSONObject().put("conversationId", "classroom")); socket?.disconnect(); socket = null; room = null
    startStop.text = "Start lesson"; mute.visibility = View.GONE; setStatus(message)
  }

  private suspend fun joinClass(): JSONObject = withContext(Dispatchers.IO) {
    val base = baseUrl(); val body = JSONObject().put("classCode", classCode.text.toString()).put("visitorId", visitorId()).put("displayName", displayName.text.toString())
    request("$base/api/auth/join", body, null)
  }
  private suspend fun getCredentials(token: String): JSONObject = withContext(Dispatchers.IO) { request("${baseUrl()}/api/livekit/token", JSONObject().put("conversationId", "classroom"), token) }
  private fun connectSocket(token: String) { socket = IO.socket(baseUrl(), IO.Options().apply { auth = mapOf("token" to token); transports = arrayOf("websocket") }) }
  private fun baseUrl() = serverUrl.text.toString().trim().removeSuffix("/")
  private fun visitorId(): String { val p = getSharedPreferences("teacher", Context.MODE_PRIVATE); return p.getString("visitorId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("visitorId", it).apply() } }
  private fun request(url: String, body: JSONObject, token: String?): JSONObject { val connection = URL(url).openConnection() as HttpURLConnection; connection.requestMethod = "POST"; connection.setRequestProperty("Content-Type", "application/json"); if (token != null) connection.setRequestProperty("Authorization", "Bearer $token"); connection.doOutput = true; connection.outputStream.use { it.write(body.toString().toByteArray()) }; val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream; val response = stream.bufferedReader().use { it.readText() }; if (connection.responseCode !in 200..299) throw IllegalStateException(response); return JSONObject(response) }
  private fun setStatus(value: String) { status.text = value }
  override fun onDestroy() { if (sharing) stopLesson("Lesson stopped"); super.onDestroy() }
}
