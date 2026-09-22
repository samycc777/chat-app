package org.classroom.teacher

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import livekit.org.webrtc.PeerConnectionFactory
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

class MainActivity : AppCompatActivity() {
  companion object { const val STOP_LESSON_ACTION = "org.classroom.teacher.STOP_LESSON" }

  // Setup views
  private lateinit var setupLayout: LinearLayout
  private lateinit var serverUrl: EditText
  private lateinit var classCode: EditText
  private lateinit var displayName: EditText

  // Lesson views
  private lateinit var lessonLayout: LinearLayout
  private lateinit var participantList: LinearLayout
  private lateinit var chatMessages: LinearLayout
  private lateinit var chatScroll: ScrollView
  private lateinit var chatInput: EditText
  private lateinit var muteBtn: Button
  private lateinit var statusText: TextView

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
    if (result.resultCode != Activity.RESULT_OK || result.data == null) { statusText.text = "Screen sharing was cancelled"; return@registerForActivityResult }
    lifecycleScope.launch {
      try {
        room?.localParticipant?.setScreenShareEnabled(true, ScreenCaptureParams(result.data!!,
          notificationId = 101,
          notification = buildCaptureNotification(),
          onStop = { runOnUiThread { stopLesson("Android stopped screen sharing") } }
        ))
        sharing = true
        showLessonUI()
        statusText.text = "Sharing. Switch to JNotes and teach."
      } catch (error: Exception) { stopLesson("Could not start screen sharing") }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildUI()
    if (intent.action == STOP_LESSON_ACTION) stopLesson("Lesson stopped")
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == STOP_LESSON_ACTION) stopLesson("Lesson stopped")
  }

  private fun buildUI() {
    val root = FrameLayout(this)

    // Setup screen
    setupLayout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(40, 56, 40, 40)
      gravity = Gravity.CENTER_HORIZONTAL
    }
    serverUrl = field(setupLayout, "Website URL", "https://nurturing-dedication-production-9379.up.railway.app")
    classCode = field(setupLayout, "Class code", "0000")
    displayName = field(setupLayout, "Teacher name", "test")
    val startBtn = Button(this).apply {
      text = "Start lesson"
      setOnClickListener { startLesson() }
    }
    setupLayout.addView(startBtn)
    val setupStatus = TextView(this).apply {
      text = "Sign in, then start a lesson."
      setPadding(0, 28, 0, 0)
    }
    setupLayout.addView(setupStatus)
    statusText = setupStatus

    // Lesson screen
    lessonLayout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      visibility = View.GONE
    }
    buildLessonUI()

    root.addView(setupLayout)
    root.addView(lessonLayout)
    setContentView(root)
  }

  private fun buildLessonUI() {
    // Top bar
    val topBar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(24, 24, 24, 12)
      gravity = Gravity.CENTER_VERTICAL
      setBackgroundColor(Color.parseColor("#1a2e1f"))
    }
    val title = TextView(this).apply {
      text = "Live Lesson"
      setTextColor(Color.WHITE)
      textSize = 18f
      typeface = Typeface.DEFAULT_BOLD
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }
    topBar.addView(title)

    muteBtn = Button(this).apply {
      text = "Mute"
      setOnClickListener { toggleMute() }
    }
    topBar.addView(muteBtn)

    val stopBtn = Button(this).apply {
      text = "End"
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.parseColor("#c0392b"))
      setOnClickListener { stopLesson("Lesson stopped") }
    }
    topBar.addView(stopBtn)
    lessonLayout.addView(topBar)

    // Status
    statusText = TextView(this).apply {
      setPadding(24, 8, 24, 8)
      setTextColor(Color.parseColor("#8fbc8f"))
      setBackgroundColor(Color.parseColor("#0d1f13"))
      textSize = 12f
    }
    lessonLayout.addView(statusText)

    // Participants section
    val participantLabel = TextView(this).apply {
      text = "Participants"
      setPadding(24, 16, 24, 8)
      setTextColor(Color.parseColor("#a0c4a0"))
      textSize = 13f
      typeface = Typeface.DEFAULT_BOLD
      setBackgroundColor(Color.parseColor("#0d1f13"))
    }
    lessonLayout.addView(participantLabel)

    participantList = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(24, 0, 24, 8)
      setBackgroundColor(Color.parseColor("#0d1f13"))
    }
    lessonLayout.addView(participantList)

    // Chat section
    val chatLabel = TextView(this).apply {
      text = "Chat"
      setPadding(24, 12, 24, 8)
      setTextColor(Color.parseColor("#a0c4a0"))
      textSize = 13f
      typeface = Typeface.DEFAULT_BOLD
      setBackgroundColor(Color.parseColor("#111111"))
    }
    lessonLayout.addView(chatLabel)

    chatScroll = ScrollView(this).apply {
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
      setBackgroundColor(Color.parseColor("#111111"))
    }
    chatMessages = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(24, 4, 24, 4)
    }
    chatScroll.addView(chatMessages)
    lessonLayout.addView(chatScroll)

    // Chat input
    val inputRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(16, 8, 16, 16)
      setBackgroundColor(Color.parseColor("#1a1a1a"))
      gravity = Gravity.CENTER_VERTICAL
    }
    chatInput = EditText(this).apply {
      hint = "Type a message…"
      setHintTextColor(Color.parseColor("#666666"))
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.parseColor("#222222"))
      setPadding(24, 16, 24, 16)
      inputType = InputType.TYPE_CLASS_TEXT
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }
    inputRow.addView(chatInput)
    val sendBtn = Button(this).apply {
      text = "Send"
      setOnClickListener { sendChatMessage() }
    }
    inputRow.addView(sendBtn)
    lessonLayout.addView(inputRow)
  }

  private fun showLessonUI() {
    setupLayout.visibility = View.GONE
    lessonLayout.visibility = View.VISIBLE
    updateParticipants()
  }

  private fun showSetupUI() {
    lessonLayout.visibility = View.GONE
    setupLayout.visibility = View.VISIBLE
  }

  private fun updateParticipants() {
    participantList.removeAllViews()
    // Teacher (self)
    val micOn = room?.localParticipant?.isMicrophoneEnabled == true
    addParticipantRow("You (Teacher)", micOn, isTeacher = true)
    // Remote participants
    room?.remoteParticipants?.values?.forEach { p ->
      val name = p.name ?: p.identity?.value ?: "Student"
      val pMicOn = p.isMicrophoneEnabled
      addParticipantRow(name, pMicOn, isTeacher = false)
    }
  }

  private fun addParticipantRow(name: String, micOn: Boolean, isTeacher: Boolean) {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(0, 6, 0, 6)
      gravity = Gravity.CENTER_VERTICAL
    }
    val dot = TextView(this).apply {
      text = "●"
      setTextColor(if (micOn) Color.parseColor("#2ecc71") else Color.parseColor("#e74c3c"))
      textSize = 14f
      setPadding(0, 0, 12, 0)
    }
    row.addView(dot)
    val label = TextView(this).apply {
      text = name
      setTextColor(Color.WHITE)
      textSize = 14f
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }
    row.addView(label)
    val micStatus = TextView(this).apply {
      text = if (micOn) "🎤" else "🔇"
      textSize = 16f
    }
    row.addView(micStatus)
    if (isTeacher) {
      val badge = TextView(this).apply {
        text = "  HOST"
        setTextColor(Color.parseColor("#f1c40f"))
        textSize = 10f
        typeface = Typeface.DEFAULT_BOLD
      }
      row.addView(badge)
    }
    participantList.addView(row)
  }

  private fun addChatMessage(sender: String, content: String) {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, 4, 0, 4)
    }
    val nameView = TextView(this).apply {
      text = sender
      setTextColor(Color.parseColor("#2ecc71"))
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
    }
    row.addView(nameView)
    val msgView = TextView(this).apply {
      text = content
      setTextColor(Color.parseColor("#dddddd"))
      textSize = 14f
    }
    row.addView(msgView)
    chatMessages.addView(row)
    chatScroll.post { chatScroll.fullScroll(View.FOCUS_DOWN) }
  }

  private fun sendChatMessage() {
    val text = chatInput.text.toString().trim()
    if (text.isEmpty() || socket == null) return
    socket?.emit("message", JSONObject()
      .put("conversationId", "classroom")
      .put("content", text)
      .put("type", "text")
    )
    chatInput.setText("")
  }

  private fun setupSocketListeners() {
    socket?.on("message") { args ->
      val msg = args.firstOrNull() as? JSONObject ?: return@on
      val sender = msg.optJSONObject("sender")?.optString("displayName") ?: "Unknown"
      val content = msg.optString("content", "")
      val type = msg.optString("type", "text")
      if (type == "text" && content.isNotEmpty()) {
        runOnUiThread { addChatMessage(sender, content) }
      }
    }
  }

  private fun setupRoomListeners() {
    val handler = android.os.Handler(mainLooper)
    val updater = object : Runnable {
      override fun run() {
        if (sharing) { updateParticipants(); handler.postDelayed(this, 3000) }
      }
    }
    handler.postDelayed(updater, 3000)
  }

  private fun field(root: LinearLayout, label: String, hint: String): EditText {
    root.addView(TextView(this).apply { text = label })
    return EditText(this).also { it.setText(hint); root.addView(it, LinearLayout.LayoutParams(-1, -2)) }
  }

  private val permissionsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results: Map<String, Boolean> ->
    if (results[Manifest.permission.RECORD_AUDIO] != true) { statusText.text = "Microphone permission is required"; return@registerForActivityResult }
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
      statusText.text = "Signing in…"
      val identity = joinClass()
      authToken = identity.getString("token")
      userId = identity.getJSONObject("user").getString("id")
      connectSocket(authToken!!)
      setupSocketListeners()
      socket?.on("wb_started") { data ->
        val started = data.firstOrNull() as? JSONObject ?: return@on
        runOnUiThread {
          if (started.optString("presenterId") == userId) lifecycleScope.launch { connectLessonMedia() }
          else statusText.text = "Another teacher already has an active lesson."
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
      PeerConnectionFactory.initialize(
        PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
      )
      room = LiveKit.create(applicationContext)
      room!!.connect(credentials.getString("url"), credentials.getString("token"))
      room!!.localParticipant.setMicrophoneEnabled(true)
      setupRoomListeners()
      val projection = getSystemService(MediaProjectionManager::class.java)
      screenCapture.launch(projection.createScreenCaptureIntent())
    } catch (error: Exception) { stopLesson("Could not connect. Check the website URL and lesson configuration.") }
  }

  private fun toggleMute() = lifecycleScope.launch {
    val enabled = room?.localParticipant?.isMicrophoneEnabled == true
    room?.localParticipant?.setMicrophoneEnabled(!enabled)
    muteBtn.text = if (enabled) "Unmute" else "Mute"
    updateParticipants()
  }

  private fun stopLesson(message: String) = lifecycleScope.launch {
    if (!sharing && room == null) { statusText.text = message; return@launch }
    sharing = false
    try { room?.localParticipant?.setScreenShareEnabled(false); room?.disconnect(); room?.release() } catch (_: Exception) { }
    socket?.emit("wb_end", JSONObject().put("conversationId", "classroom")); socket?.disconnect(); socket = null; room = null
    showSetupUI()
    statusText.text = message
  }

  private suspend fun joinClass(): JSONObject = withContext(Dispatchers.IO) {
    val base = baseUrl()
    val body = JSONObject().put("classCode", classCode.text.toString()).put("visitorId", visitorId()).put("displayName", displayName.text.toString())
    request("$base/api/auth/join", body, null)
  }

  private suspend fun getCredentials(token: String): JSONObject = withContext(Dispatchers.IO) {
    request("${baseUrl()}/api/livekit/token", JSONObject().put("conversationId", "classroom"), token)
  }

  private fun connectSocket(token: String) {
    socket = IO.socket(baseUrl(), IO.Options().apply { auth = mapOf("token" to token); transports = arrayOf("websocket") })
  }

  private fun baseUrl() = serverUrl.text.toString().trim().removeSuffix("/")

  private fun visitorId(): String {
    val p = getSharedPreferences("teacher", Context.MODE_PRIVATE)
    return p.getString("visitorId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("visitorId", it).apply() }
  }

  private fun request(url: String, body: JSONObject, token: String?): JSONObject {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.setRequestProperty("Content-Type", "application/json")
    if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
    connection.doOutput = true
    connection.outputStream.use { it.write(body.toString().toByteArray()) }
    val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
    val response = stream.bufferedReader().use { it.readText() }
    if (connection.responseCode !in 200..299) throw IllegalStateException(response)
    return JSONObject(response)
  }

  override fun onDestroy() { if (sharing) stopLesson("Lesson stopped"); super.onDestroy() }
}
