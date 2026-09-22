package org.classroom.teacher

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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
import io.socket.client.Ack
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
  companion object {
    const val STOP_LESSON_ACTION = "org.classroom.teacher.STOP_LESSON"
    private const val DEFAULT_SERVER_URL = "https://nurturing-dedication-production-9379.up.railway.app"
    private const val DEFAULT_CLASS_CODE = "0000"
    private const val PREF_SERVER_URL = "serverUrl"
    private const val PREF_CLASS_CODE = "classCode"
    private const val PREF_DISPLAY_NAME = "displayName"
  }

  private lateinit var setupLayout: LinearLayout
  private lateinit var serverUrl: EditText
  private lateinit var classCode: EditText
  private lateinit var displayName: EditText

  private lateinit var lessonLayout: LinearLayout
  private lateinit var participantList: LinearLayout
  private lateinit var chatMessages: LinearLayout
  private lateinit var chatScroll: ScrollView
  private lateinit var chatInput: EditText
  private lateinit var muteBtn: Button
  private lateinit var statusText: TextView
  private lateinit var setupStatusText: TextView
  private lateinit var lessonStatusText: TextView

  private var authToken: String? = null
  private var userId: String? = null
  private var socket: Socket? = null
  private var room: Room? = null
  private var sharing = false
  private var lessonActive = false
  private lateinit var shareBtn: Button
  private val preferences by lazy { getSharedPreferences("teacher", Context.MODE_PRIVATE) }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

  private fun roundRect(color: String, radiusDp: Int = 12, strokeColor: String? = null, strokeWidthDp: Int = 1): GradientDrawable {
    return GradientDrawable().apply {
      shape = GradientDrawable.RECTANGLE
      cornerRadius = dp(radiusDp).toFloat()
      setColor(Color.parseColor(color))
      if (strokeColor != null) setStroke(dp(strokeWidthDp), Color.parseColor(strokeColor))
    }
  }

  private fun buildCaptureNotification(): android.app.Notification {
    val channelId = "lesson_capture"
    val manager = getSystemService(android.app.NotificationManager::class.java)
    manager.createNotificationChannel(
      android.app.NotificationChannel(
        channelId,
        getString(R.string.notification_channel_screen_share),
        android.app.NotificationManager.IMPORTANCE_LOW
      )
    )
    return androidx.core.app.NotificationCompat.Builder(this, channelId)
      .setSmallIcon(R.drawable.ic_screen_share)
      .setContentTitle(getString(R.string.notification_screen_share_title))
      .setContentText(getString(R.string.notification_screen_share_text))
      .setOngoing(true)
      .build()
  }

  private val screenCapture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
    if (result.resultCode != Activity.RESULT_OK || result.data == null) {
      statusText.text = getString(R.string.status_screen_share_cancelled)
      return@registerForActivityResult
    }
    lifecycleScope.launch {
      try {
        room?.localParticipant?.setScreenShareEnabled(true, ScreenCaptureParams(result.data!!,
          notificationId = 101,
          notification = buildCaptureNotification(),
          onStop = { runOnUiThread { onScreenShareStopped() } }
        ))
        sharing = true
        shareBtn.text = getString(R.string.action_stop_sharing)
        showLessonUI()
        statusText.text = getString(R.string.status_sharing)
      } catch (error: Exception) { stopLesson(getString(R.string.status_screen_share_failed)) }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.statusBarColor = Color.parseColor("#0f1a13")
    window.navigationBarColor = Color.parseColor("#111a14")
    buildUI()
    if (intent.action == STOP_LESSON_ACTION) stopLesson(getString(R.string.status_lesson_stopped))
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == STOP_LESSON_ACTION) stopLesson(getString(R.string.status_lesson_stopped))
  }

  private fun buildUI() {
    val root = FrameLayout(this).apply {
      setBackgroundColor(Color.parseColor("#0f1a13"))
      layoutDirection = View.LAYOUT_DIRECTION_RTL
      textDirection = View.TEXT_DIRECTION_LOCALE
    }

    setupLayout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(28), dp(72), dp(28), dp(28))
    }

    val titleText = TextView(this).apply {
      text = getString(R.string.setup_title)
      setTextColor(Color.WHITE)
      textSize = 28f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }
    setupLayout.addView(titleText, LinearLayout.LayoutParams(-1, -2).apply {
      bottomMargin = dp(4)
    })

    val subtitleText = TextView(this).apply {
      text = getString(R.string.setup_subtitle)
      setTextColor(Color.parseColor("#3fb950"))
      textSize = 15f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }
    setupLayout.addView(subtitleText, LinearLayout.LayoutParams(-1, -2).apply {
      bottomMargin = dp(36)
    })

    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundRect("#162b1d", 16)
      setPadding(dp(20), dp(24), dp(20), dp(24))
    }

    serverUrl = styledField(
      card,
      getString(R.string.field_server_url),
      preferences.getString(PREF_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
    ).apply {
      layoutDirection = View.LAYOUT_DIRECTION_LTR
      textDirection = View.TEXT_DIRECTION_LTR
      gravity = Gravity.START or Gravity.CENTER_VERTICAL
    }
    classCode = styledField(
      card,
      getString(R.string.field_class_code),
      preferences.getString(PREF_CLASS_CODE, DEFAULT_CLASS_CODE) ?: DEFAULT_CLASS_CODE
    )
    displayName = styledField(
      card,
      getString(R.string.field_teacher_name),
      preferences.getString(PREF_DISPLAY_NAME, "") ?: ""
    )

    setupLayout.addView(card, LinearLayout.LayoutParams(-1, -2).apply {
      bottomMargin = dp(24)
    })

    val startBtn = Button(this).apply {
      text = getString(R.string.action_start_lesson)
      setTextColor(Color.WHITE)
      textSize = 16f
      typeface = Typeface.DEFAULT_BOLD
      isAllCaps = false
      stateListAnimator = null
      background = roundRect("#2ea043", 12)
      setPadding(dp(24), dp(16), dp(24), dp(16))
      setOnClickListener { startLesson() }
    }
    setupLayout.addView(startBtn, LinearLayout.LayoutParams(-1, dp(54)))

    setupStatusText = TextView(this).apply {
      text = getString(R.string.setup_instruction)
      setTextColor(Color.parseColor("#8b949e"))
      textSize = 13f
      gravity = Gravity.CENTER
      setPadding(0, dp(20), 0, 0)
    }
    setupLayout.addView(setupStatusText)
    statusText = setupStatusText

    lessonLayout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      visibility = View.GONE
      setBackgroundColor(Color.parseColor("#0f1a13"))
    }
    buildLessonUI()

    root.addView(setupLayout, FrameLayout.LayoutParams(-1, -1))
    root.addView(lessonLayout, FrameLayout.LayoutParams(-1, -1))
    setContentView(root)
  }

  private fun styledField(parent: LinearLayout, label: String, defaultValue: String): EditText {
    val labelView = TextView(this).apply {
      text = label
      setTextColor(Color.parseColor("#8fbc8f"))
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.END
    }
    parent.addView(labelView, LinearLayout.LayoutParams(-1, -2).apply {
      bottomMargin = dp(6)
    })

    val input = EditText(this).apply {
      setText(defaultValue)
      setTextColor(Color.parseColor("#e6edf3"))
      setHintTextColor(Color.parseColor("#484f58"))
      textSize = 15f
      background = roundRect("#1d3a26", 10, "#2d5a3a")
      setPadding(dp(14), dp(12), dp(14), dp(12))
      inputType = InputType.TYPE_CLASS_TEXT
      isSingleLine = true
      gravity = Gravity.END or Gravity.CENTER_VERTICAL
    }
    parent.addView(input, LinearLayout.LayoutParams(-1, -2).apply {
      bottomMargin = dp(16)
    })

    return input
  }

  private fun buildLessonUI() {
    val topBar = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.parseColor("#162b1d"))
    }

    val titleRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(dp(20), dp(16), dp(20), dp(4))
      gravity = Gravity.CENTER_VERTICAL
    }
    val liveDot = TextView(this).apply {
      text = "●"
      setTextColor(Color.parseColor("#2ecc71"))
      textSize = 10f
      setPadding(0, 0, dp(8), 0)
    }
    titleRow.addView(liveDot)
    val title = TextView(this).apply {
      text = getString(R.string.lesson_title)
      setTextColor(Color.WHITE)
      textSize = 20f
      typeface = Typeface.DEFAULT_BOLD
    }
    titleRow.addView(title)
    topBar.addView(titleRow)

    val buttonRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(dp(16), dp(6), dp(16), dp(14))
    }

    shareBtn = Button(this).apply {
      text = getString(R.string.action_share)
      setTextColor(Color.WHITE)
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
      isAllCaps = false
      stateListAnimator = null
      background = roundRect("#238636", 8)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      setOnClickListener { toggleScreenShare() }
    }
    buttonRow.addView(shareBtn, LinearLayout.LayoutParams(0, dp(38), 1f).apply {
      marginEnd = dp(8)
    })

    muteBtn = Button(this).apply {
      text = getString(R.string.action_mute)
      setTextColor(Color.WHITE)
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
      isAllCaps = false
      stateListAnimator = null
      background = roundRect("#30363d", 8)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      setOnClickListener { toggleMute() }
    }
    buttonRow.addView(muteBtn, LinearLayout.LayoutParams(0, dp(38), 1f).apply {
      marginEnd = dp(8)
    })

    val stopBtn = Button(this).apply {
      text = getString(R.string.action_end)
      setTextColor(Color.WHITE)
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
      isAllCaps = false
      stateListAnimator = null
      background = roundRect("#da3633", 8)
      setPadding(dp(14), dp(8), dp(14), dp(8))
      setOnClickListener { stopLesson(getString(R.string.status_lesson_stopped)) }
    }
    buttonRow.addView(stopBtn, LinearLayout.LayoutParams(0, dp(38), 1f))

    topBar.addView(buttonRow)
    lessonLayout.addView(topBar)

    lessonStatusText = TextView(this).apply {
      setPadding(dp(20), dp(10), dp(20), dp(10))
      setTextColor(Color.parseColor("#3fb950"))
      setBackgroundColor(Color.parseColor("#0d2818"))
      textSize = 13f
      gravity = Gravity.END
    }
    lessonLayout.addView(lessonStatusText)

    val participantHeader = TextView(this).apply {
      text = getString(R.string.participants_title)
      setPadding(dp(20), dp(16), dp(20), dp(8))
      setTextColor(Color.parseColor("#8b949e"))
      textSize = 11f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.END
      setBackgroundColor(Color.parseColor("#0f1a13"))
    }
    lessonLayout.addView(participantHeader)

    participantList = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), 0, dp(16), dp(8))
      setBackgroundColor(Color.parseColor("#0f1a13"))
    }
    lessonLayout.addView(participantList)

    val divider = View(this).apply {
      setBackgroundColor(Color.parseColor("#1d3a26"))
    }
    lessonLayout.addView(divider, LinearLayout.LayoutParams(-1, dp(1)).apply {
      leftMargin = dp(20); rightMargin = dp(20)
    })

    val chatHeader = TextView(this).apply {
      text = getString(R.string.chat_title)
      setPadding(dp(20), dp(14), dp(20), dp(8))
      setTextColor(Color.parseColor("#8b949e"))
      textSize = 11f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.END
      setBackgroundColor(Color.parseColor("#0f1a13"))
    }
    lessonLayout.addView(chatHeader)

    chatScroll = ScrollView(this).apply {
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
      setBackgroundColor(Color.parseColor("#0f1a13"))
    }
    chatMessages = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(4), dp(16), dp(4))
    }
    chatScroll.addView(chatMessages)
    lessonLayout.addView(chatScroll)

    val inputBar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(dp(16), dp(12), dp(16), dp(16))
      setBackgroundColor(Color.parseColor("#111a14"))
      gravity = Gravity.CENTER_VERTICAL
    }
    chatInput = EditText(this).apply {
      hint = getString(R.string.chat_hint)
      setHintTextColor(Color.parseColor("#484f58"))
      setTextColor(Color.parseColor("#e6edf3"))
      textSize = 14f
      background = roundRect("#1d3a26", 22, "#2d5a3a")
      setPadding(dp(18), dp(12), dp(18), dp(12))
      inputType = InputType.TYPE_CLASS_TEXT
      isSingleLine = true
      gravity = Gravity.END or Gravity.CENTER_VERTICAL
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    }
    inputBar.addView(chatInput)

    val sendBtn = Button(this).apply {
      text = "↑"
      contentDescription = getString(R.string.action_send_message)
      setTextColor(Color.WHITE)
      textSize = 18f
      typeface = Typeface.DEFAULT_BOLD
      isAllCaps = false
      stateListAnimator = null
      background = roundRect("#2ea043", 22)
      setPadding(0, 0, 0, 0)
      gravity = Gravity.CENTER
      setOnClickListener { sendChatMessage() }
    }
    inputBar.addView(sendBtn, LinearLayout.LayoutParams(dp(44), dp(44)).apply {
      marginStart = dp(10)
    })

    lessonLayout.addView(inputBar)
  }

  private fun showLessonUI() {
    setupLayout.visibility = View.GONE
    lessonLayout.visibility = View.VISIBLE
    statusText = lessonStatusText
    updateParticipants()
  }

  private fun showSetupUI() {
    lessonLayout.visibility = View.GONE
    setupLayout.visibility = View.VISIBLE
    statusText = setupStatusText
  }

  private fun updateParticipants() {
    participantList.removeAllViews()
    val micOn = room?.localParticipant?.isMicrophoneEnabled == true
    addParticipantRow(getString(R.string.participant_teacher), micOn, isTeacher = true)
    room?.remoteParticipants?.values?.forEach { p ->
      val name = p.name ?: p.identity?.value ?: getString(R.string.participant_student)
      val pMicOn = p.isMicrophoneEnabled
      addParticipantRow(name, pMicOn, isTeacher = false)
    }
  }

  private fun addParticipantRow(name: String, micOn: Boolean, isTeacher: Boolean) {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(dp(14), dp(10), dp(14), dp(10))
      gravity = Gravity.CENTER_VERTICAL
      background = roundRect("#162b1d", 10)
    }

    val dot = TextView(this).apply {
      text = "●"
      setTextColor(if (micOn) Color.parseColor("#2ecc71") else Color.parseColor("#e74c3c"))
      textSize = 10f
      setPadding(0, 0, dp(10), 0)
    }
    row.addView(dot)

    val label = TextView(this).apply {
      text = name
      setTextColor(Color.parseColor("#e6edf3"))
      textSize = 14f
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
      gravity = Gravity.END
    }
    row.addView(label)

    val micIcon = TextView(this).apply {
      text = if (micOn) "🎤" else "🔇"
      textSize = 14f
    }
    row.addView(micIcon)

    if (isTeacher) {
      val badge = TextView(this).apply {
        text = getString(R.string.participant_host_badge)
        setTextColor(Color.parseColor("#f0c000"))
        textSize = 10f
        typeface = Typeface.DEFAULT_BOLD
        setPadding(dp(8), dp(3), dp(8), dp(3))
        background = roundRect("#3d3000", 6)
        gravity = Gravity.CENTER
      }
      row.addView(badge, LinearLayout.LayoutParams(-2, -2).apply {
        marginStart = dp(8)
      })
    }

    participantList.addView(row, LinearLayout.LayoutParams(-1, -2).apply {
      bottomMargin = dp(6)
    })
  }

  private fun addChatMessage(sender: String, content: String) {
    val wrapper = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, dp(3), 0, dp(3))
      gravity = Gravity.END
    }
    val bubble = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundRect("#162b1d", 12)
      setPadding(dp(14), dp(10), dp(14), dp(10))
    }
    val nameView = TextView(this).apply {
      text = sender
      setTextColor(Color.parseColor("#3fb950"))
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.END
    }
    bubble.addView(nameView)
    val msgView = TextView(this).apply {
      text = content
      setTextColor(Color.parseColor("#e6edf3"))
      textSize = 14f
      setPadding(0, dp(2), 0, 0)
      gravity = Gravity.END
    }
    bubble.addView(msgView)
    wrapper.addView(bubble, LinearLayout.LayoutParams(-2, -2))
    chatMessages.addView(wrapper)
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
      val sender = msg.optJSONObject("sender")?.optString("displayName")
        ?: getString(R.string.participant_unknown)
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
        if (lessonActive) { updateParticipants(); handler.postDelayed(this, 3000) }
      }
    }
    handler.postDelayed(updater, 3000)
  }

  private val permissionsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results: Map<String, Boolean> ->
    if (results[Manifest.permission.RECORD_AUDIO] != true) {
      statusText.text = getString(R.string.status_microphone_required)
      return@registerForActivityResult
    }
    lifecycleScope.launch { doStartLesson() }
  }

  private fun startLesson() {
    saveSettings()
    val needed = mutableListOf<String>()
    if (ActivityCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.RECORD_AUDIO)
    if (android.os.Build.VERSION.SDK_INT >= 33 && ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) needed.add(Manifest.permission.POST_NOTIFICATIONS)
    if (needed.isNotEmpty()) { permissionsLauncher.launch(needed.toTypedArray()); return }
    lifecycleScope.launch { doStartLesson() }
  }

  private suspend fun doStartLesson() {
    try {
      statusText.text = getString(R.string.status_signing_in)
      val identity = joinClass()
      authToken = identity.getString("token")
      userId = identity.getJSONObject("user").getString("id")
      connectSocket(authToken!!)
      setupSocketListeners()
      socket?.on("wb_started") { data ->
        val started = data.firstOrNull() as? JSONObject ?: return@on
        runOnUiThread {
          if (started.optString("presenterId") == userId) lifecycleScope.launch { connectLessonMedia() }
          else if (room != null) stopLesson(getString(R.string.status_another_teacher))
        }
      }
      // Only the first connection asks for the lesson, so a reconnect never starts one unprompted.
      socket?.once(Socket.EVENT_CONNECT) {
        socket?.emit("wb_start", JSONObject().put("conversationId", "classroom"), Ack { result ->
          val presenterId = (result.firstOrNull() as? JSONObject)?.optString("presenterId")
          if (presenterId != userId) runOnUiThread { stopLesson(getString(R.string.status_another_teacher)) }
        })
      }
      socket?.on(Socket.EVENT_CONNECT_ERROR) { _ ->
        runOnUiThread { stopLesson(getString(R.string.status_connection_error)) }
      }
      socket?.connect()
    } catch (error: Exception) { stopLesson(getString(R.string.status_connection_failed)) }
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
      val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      @Suppress("DEPRECATION") am.isSpeakerphoneOn = true
      lessonActive = true
      startForegroundService(Intent(this@MainActivity, LessonService::class.java))
      setupRoomListeners()
      val projection = getSystemService(MediaProjectionManager::class.java)
      Toast.makeText(this@MainActivity, getString(R.string.screen_share_picker_instruction), Toast.LENGTH_LONG).show()
      screenCapture.launch(projection.createScreenCaptureIntent())
    } catch (error: Exception) { stopLesson(getString(R.string.status_connection_failed)) }
  }

  private fun onScreenShareStopped() {
    sharing = false
    shareBtn.text = getString(R.string.action_share)
    statusText.text = getString(R.string.status_screen_share_stopped)
  }

  private fun toggleScreenShare() {
    if (sharing) {
      lifecycleScope.launch {
        try { room?.localParticipant?.setScreenShareEnabled(false) } catch (_: Exception) { }
        sharing = false
        shareBtn.text = getString(R.string.action_share)
        statusText.text = getString(R.string.status_screen_share_stopped)
      }
    } else {
      val projection = getSystemService(MediaProjectionManager::class.java)
      Toast.makeText(this, getString(R.string.screen_share_picker_instruction), Toast.LENGTH_LONG).show()
      screenCapture.launch(projection.createScreenCaptureIntent())
    }
  }

  private fun toggleMute() = lifecycleScope.launch {
    val enabled = room?.localParticipant?.isMicrophoneEnabled == true
    room?.localParticipant?.setMicrophoneEnabled(!enabled)
    muteBtn.text = getString(if (enabled) R.string.action_unmute else R.string.action_mute)
    updateParticipants()
  }

  private fun stopLesson(message: String) = lifecycleScope.launch {
    if (lessonActive || room != null) {
      sharing = false
      lessonActive = false
      stopService(Intent(this@MainActivity, LessonService::class.java))
      try {
        room?.localParticipant?.setScreenShareEnabled(false); room?.disconnect(); room?.release()
        val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
        @Suppress("DEPRECATION") am.isSpeakerphoneOn = false
        am.mode = android.media.AudioManager.MODE_NORMAL
      } catch (_: Exception) { }
      room = null
      showSetupUI()
    }
    // A failed or refused start must not leave a connected socket that still holds, or later claims, the lesson.
    socket?.emit("wb_end", JSONObject().put("conversationId", "classroom")); socket?.disconnect(); socket = null
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
    socket?.disconnect()
    socket = IO.socket(baseUrl(), IO.Options().apply { auth = mapOf("token" to token); transports = arrayOf("websocket") })
  }

  private fun baseUrl() = serverUrl.text.toString().trim().removeSuffix("/")

  private fun saveSettings() {
    preferences.edit()
      .putString(PREF_SERVER_URL, serverUrl.text.toString().trim())
      .putString(PREF_CLASS_CODE, classCode.text.toString().trim())
      .putString(PREF_DISPLAY_NAME, displayName.text.toString().trim())
      .apply()
  }

  private fun visitorId(): String {
    return preferences.getString("visitorId", null)
      ?: UUID.randomUUID().toString().also { preferences.edit().putString("visitorId", it).apply() }
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

  override fun onDestroy() { super.onDestroy() }
}
