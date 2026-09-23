package org.classroom.teacher

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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
import android.view.inputmethod.EditorInfo
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.lifecycle.lifecycleScope
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.socket.client.Ack
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import livekit.org.webrtc.PeerConnectionFactory
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

// Wraps its content like a normal list but never grows past a share of the screen, so a large
// class still leaves room for the chat below it.
private class CappedScrollView(context: Context, private val screenShare: Float) : ScrollView(context) {
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val maxHeight = (resources.displayMetrics.heightPixels * screenShare).toInt()
    super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST))
  }
}

class MainActivity : AppCompatActivity() {
  companion object {
    const val STOP_LESSON_ACTION = "org.classroom.teacher.STOP_LESSON"
    private const val DEFAULT_SERVER_URL = "https://nurturing-dedication-production-9379.up.railway.app"
    private const val CONVERSATION_ID = "classroom"
    private const val PREF_SERVER_URL = "serverUrl"
    private const val PREF_CLASS_CODE = "classCode"
    private const val PREF_DISPLAY_NAME = "displayName"
    private const val ALERTS_CHANNEL_ID = "lesson_alerts"
    private const val HAND_NOTIFICATION_ID = 301
    private const val CHAT_NOTIFICATION_ID = 302
  }

  private data class ParticipantRow(val identity: String?, val name: String, val micOn: Boolean, val teacher: Boolean, val handRaised: Boolean)

  private lateinit var setupLayout: LinearLayout
  private lateinit var serverUrl: EditText
  private lateinit var classCode: EditText
  private lateinit var displayName: EditText

  private lateinit var lessonLayout: LinearLayout
  private lateinit var participantHeader: TextView
  private lateinit var muteAllBtn: TextView
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
  private var roomEvents: Job? = null
  private var sharing = false
  private var lessonActive = false
  private var appVisible = false
  private var participantsShown = ""
  private val raisedHands = linkedSetOf<String>()
  private val chatBubbles = mutableMapOf<String, Pair<View, TextView>>()
  private val unseenChat = ArrayDeque<String>()
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
        statusText.text = getString(R.string.status_sharing)
      } catch (error: Exception) { stopLesson(getString(R.string.status_screen_share_failed)) }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.statusBarColor = Color.parseColor("#0f1a13")
    window.navigationBarColor = Color.parseColor("#111a14")
    createAlertsChannel()
    buildUI()
    if (intent.action == STOP_LESSON_ACTION) stopLesson(getString(R.string.status_lesson_stopped))
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == STOP_LESSON_ACTION) stopLesson(getString(R.string.status_lesson_stopped))
  }

  override fun onResume() {
    super.onResume()
    appVisible = true
    unseenChat.clear()
    getSystemService(NotificationManager::class.java).apply {
      cancel(CHAT_NOTIFICATION_ID)
      cancel(HAND_NOTIFICATION_ID)
    }
  }

  override fun onPause() {
    appVisible = false
    super.onPause()
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
      getString(R.string.field_teacher_code),
      preferences.getString(PREF_CLASS_CODE, "") ?: ""
    ).apply {
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      layoutDirection = View.LAYOUT_DIRECTION_LTR
      textDirection = View.TEXT_DIRECTION_LTR
    }
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

    val participantHeaderRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(20), dp(12), dp(16), dp(8))
      setBackgroundColor(Color.parseColor("#0f1a13"))
    }
    participantHeader = TextView(this).apply {
      text = getString(R.string.participants_title)
      setTextColor(Color.parseColor("#8b949e"))
      textSize = 11f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.START
    }
    participantHeaderRow.addView(participantHeader, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    // Shown while any student's microphone is open, for a class that has become noisy.
    muteAllBtn = TextView(this).apply {
      text = getString(R.string.action_mute_all)
      setTextColor(Color.parseColor("#ffb4ae"))
      textSize = 12f
      typeface = Typeface.DEFAULT_BOLD
      background = roundRect("#3a1d1b", 8)
      setPadding(dp(12), dp(6), dp(12), dp(6))
      visibility = View.GONE
      setOnClickListener { muteStudents(null) }
    }
    participantHeaderRow.addView(muteAllBtn)
    lessonLayout.addView(participantHeaderRow)

    participantList = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), 0, dp(16), dp(8))
    }
    val participantScroll = CappedScrollView(this, 0.35f).apply {
      setBackgroundColor(Color.parseColor("#0f1a13"))
      addView(participantList)
    }
    lessonLayout.addView(participantScroll)

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
      textSize = 15f
      background = roundRect("#1d3a26", 22, "#2d5a3a")
      setPadding(dp(18), dp(12), dp(18), dp(12))
      inputType = InputType.TYPE_CLASS_TEXT
      isSingleLine = true
      imeOptions = EditorInfo.IME_ACTION_SEND
      setOnEditorActionListener { _, actionId, _ ->
        if (actionId == EditorInfo.IME_ACTION_SEND) { sendChatMessage(); true } else false
      }
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
    updateParticipants(force = true)
  }

  private fun showSetupUI() {
    lessonLayout.visibility = View.GONE
    setupLayout.visibility = View.VISIBLE
    statusText = setupStatusText
  }

  // The list is rebuilt only when something visible changed, so a tap on a raised hand is never
  // lost to a refresh that replaced the row under the teacher's finger.
  private fun updateParticipants(force: Boolean = false) {
    val handOrder = raisedHands.toList()
    val students = room?.remoteParticipants?.values.orEmpty().map { participant ->
      val identity = participant.identity?.value
      ParticipantRow(
        identity,
        participant.name?.takeIf { it.isNotBlank() } ?: identity ?: getString(R.string.participant_student),
        participant.isMicrophoneEnabled,
        participant.attributes["role"] == "teacher",
        identity != null && identity in raisedHands,
      )
    }.sortedWith(compareBy<ParticipantRow>({ row -> handOrder.indexOf(row.identity).let { if (it < 0) Int.MAX_VALUE else it } }, { it.name }))
    val rows = listOf(ParticipantRow(null, getString(R.string.participant_teacher), room?.localParticipant?.isMicrophoneEnabled == true, true, false)) + students
    val shown = rows.joinToString("|")
    if (!force && shown == participantsShown) return
    participantsShown = shown
    participantList.removeAllViews()
    rows.forEach(::addParticipantRow)
    val hands = students.count { it.handRaised }
    participantHeader.text = getString(R.string.participants_count, rows.size) +
      if (hands == 0) "" else getString(R.string.participants_hands, hands)
    muteAllBtn.visibility = if (students.any { it.micOn && !it.teacher }) View.VISIBLE else View.GONE
  }

  private fun addParticipantRow(participant: ParticipantRow) {
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(dp(14), dp(10), dp(14), dp(10))
      gravity = Gravity.CENTER_VERTICAL
      background = roundRect(if (participant.handRaised) "#33401a" else "#162b1d", 10)
    }

    val dot = TextView(this).apply {
      text = "●"
      setTextColor(if (participant.micOn) Color.parseColor("#2ecc71") else Color.parseColor("#e74c3c"))
      textSize = 10f
      setPadding(0, 0, dp(10), 0)
    }
    row.addView(dot)

    val label = TextView(this).apply {
      text = participant.name
      setTextColor(Color.parseColor("#e6edf3"))
      textSize = 14f
      layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
      gravity = Gravity.END
    }
    row.addView(label)

    if (participant.handRaised && participant.identity != null) {
      val hand = TextView(this).apply {
        text = "✋"
        textSize = 18f
        contentDescription = getString(R.string.action_lower_hand)
        background = roundRect("#4a5a22", 8)
        setPadding(dp(8), dp(2), dp(8), dp(2))
        setOnClickListener { lowerHand(participant.identity) }
      }
      row.addView(hand, LinearLayout.LayoutParams(-2, -2).apply {
        marginStart = dp(8); marginEnd = dp(8)
      })
    }

    val micIcon = TextView(this).apply {
      text = if (participant.micOn) "🎤" else "🔇"
      textSize = 14f
      // The teacher taps a student's open microphone to mute it.
      if (participant.micOn && !participant.teacher && participant.identity != null) {
        background = roundRect("#1f4d2e", 8)
        setPadding(dp(6), dp(2), dp(6), dp(2))
        contentDescription = getString(R.string.action_mute_student, participant.name)
        setOnClickListener { muteStudents(participant.identity) }
      }
    }
    row.addView(micIcon)

    if (participant.teacher) {
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

  private fun createAlertsChannel() {
    // Silent on purpose: a notification sound would be picked up by the microphone and heard by the class.
    val channel = NotificationChannel(ALERTS_CHANNEL_ID, getString(R.string.notification_channel_alerts), NotificationManager.IMPORTANCE_HIGH).apply {
      setSound(null, null)
      enableVibration(true)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(this, 2,
    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  private fun postAlert(id: Int, notification: android.app.Notification) {
    // Without the notification permission the teacher still sees hands and messages in the app.
    try { getSystemService(NotificationManager::class.java).notify(id, notification) } catch (_: SecurityException) { }
  }

  // While the teacher is teaching in JNotes, raised hands and questions pop up over it.
  private fun announceHand(name: String) {
    if (appVisible) {
      Toast.makeText(this, getString(R.string.hand_raised_toast, name), Toast.LENGTH_SHORT).show()
      return
    }
    postAlert(HAND_NOTIFICATION_ID, NotificationCompat.Builder(this, ALERTS_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_hand)
      .setContentTitle(getString(R.string.notification_hand_title, name))
      .setContentText(getString(R.string.notification_hand_text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setContentIntent(openAppIntent())
      .setAutoCancel(true)
      .setTimeoutAfter(60_000)
      .build())
  }

  private fun announceChat(line: String) {
    unseenChat.addLast(line)
    while (unseenChat.size > 5) unseenChat.removeFirst()
    val lines = NotificationCompat.InboxStyle()
    unseenChat.forEach { lines.addLine(it) }
    postAlert(CHAT_NOTIFICATION_ID, NotificationCompat.Builder(this, ALERTS_CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_chat)
      .setContentTitle(getString(R.string.notification_chat_title))
      .setContentText(line)
      .setStyle(lines)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      // Only the first unread message pops up over JNotes; later ones update it quietly.
      .setOnlyAlertOnce(true)
      .setContentIntent(openAppIntent())
      .setAutoCancel(true)
      .build())
  }

  // The server keeps the raised hands, in the order they went up and with each student's name, so
  // a hand raised the moment a student joins is never lost the way a LiveKit message could be.
  private fun applyHands(hands: JSONArray) {
    val next = linkedMapOf<String, String>()
    for (index in 0 until hands.length()) hands.optJSONObject(index)?.let { next[it.optString("userId")] = it.optString("displayName") }
    val newlyRaised = next.filterKeys { it !in raisedHands }.values.lastOrNull()
    raisedHands.clear()
    raisedHands.addAll(next.keys)
    if (newlyRaised != null) announceHand(newlyRaised.ifBlank { getString(R.string.participant_student) })
    updateParticipants()
  }

  // Only a teacher may lower someone else's hand; the server then updates every app in the class.
  private fun lowerHand(identity: String) {
    raisedHands.remove(identity)
    updateParticipants()
    socket?.emit("lower_hand", JSONObject().put("conversationId", CONVERSATION_ID).put("userId", identity))
  }

  // Without an identity, mutes every student's microphone. Students can unmute themselves again.
  private fun muteStudents(identity: String?) {
    val token = authToken ?: return
    val body = JSONObject().apply { if (identity != null) put("identity", identity) }
    lifecycleScope.launch {
      val muted = runCatching { withContext(Dispatchers.IO) { request("${baseUrl()}/api/lesson/mute", body, token) } }.isSuccess
      if (!muted) Toast.makeText(this@MainActivity, R.string.mute_failed, Toast.LENGTH_SHORT).show()
    }
  }

  private fun watchRoom(activeRoom: Room) {
    roomEvents?.cancel()
    roomEvents = lifecycleScope.launch {
      activeRoom.events.collect { event ->
        when (event) {
          is RoomEvent.DataReceived -> Unit
          is RoomEvent.Reconnecting -> statusText.text = getString(R.string.status_reconnecting)
          is RoomEvent.Reconnected -> statusText.text = getString(if (sharing) R.string.status_sharing else R.string.status_screen_share_stopped)
          // LiveKit gives up only after its own reconnection attempts fail, or when the lesson's room is closed.
          is RoomEvent.Disconnected -> if (lessonActive && room === activeRoom) stopLesson(getString(R.string.status_lesson_disconnected))
          else -> updateParticipants()
        }
      }
    }
  }

  private fun messageText(message: JSONObject): String = when (message.optString("type")) {
    "image" -> getString(R.string.chat_image)
    "file" -> getString(R.string.chat_file, message.optString("fileName").ifBlank { message.optString("content") })
    else -> message.optString("content")
  }

  private fun showChatMessage(message: JSONObject, alert: Boolean) {
    val id = message.optString("id")
    if (id.isEmpty() || chatBubbles.containsKey(id) || message.optBoolean("deleted")) return
    val mine = message.optString("senderId") == userId
    val sender = message.optJSONObject("sender")
    val name = sender?.optString("displayName").orEmpty().ifBlank { getString(R.string.participant_unknown) }
    val teacher = sender?.optString("role") == "teacher"
    val text = messageText(message)

    val wrapper = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, dp(3), 0, dp(3))
      gravity = if (mine) Gravity.START else Gravity.END
    }
    val bubble = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = roundRect(if (mine) "#1f4d2e" else "#162b1d", 12)
      setPadding(dp(14), dp(10), dp(14), dp(10))
      setOnLongClickListener { confirmDelete(id); true }
    }
    if (!mine) {
      val nameView = TextView(this).apply {
        this.text = if (teacher) "$name · ${getString(R.string.chat_teacher_badge)}" else name
        setTextColor(Color.parseColor(if (teacher) "#f0c000" else "#3fb950"))
        textSize = 12f
        typeface = Typeface.DEFAULT_BOLD
        textDirection = View.TEXT_DIRECTION_FIRST_STRONG
      }
      bubble.addView(nameView)
    }
    val content = TextView(this).apply {
      this.text = text
      setTextColor(Color.parseColor("#e6edf3"))
      textSize = 16f
      setPadding(0, dp(2), 0, 0)
      textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    }
    bubble.addView(content)
    wrapper.addView(bubble, LinearLayout.LayoutParams(-2, -2))
    chatMessages.addView(wrapper)
    chatBubbles[id] = wrapper to content
    chatScroll.post { chatScroll.smoothScrollTo(0, chatMessages.bottom) }
    if (alert && !mine && !appVisible) announceChat("$name: $text")
  }

  private fun confirmDelete(messageId: String) {
    AlertDialog.Builder(this)
      .setMessage(R.string.chat_delete_prompt)
      .setPositiveButton(R.string.chat_delete) { _, _ -> socket?.emit("delete_message", JSONObject().put("messageId", messageId)) }
      .setNegativeButton(R.string.cancel, null)
      .show()
  }

  private fun clearChat() {
    chatMessages.removeAllViews()
    chatBubbles.clear()
    unseenChat.clear()
  }

  // Loads recent messages when the lesson opens and fills in any missed while reconnecting.
  private suspend fun loadChatHistory() {
    val token = authToken ?: return
    val history = runCatching {
      withContext(Dispatchers.IO) { JSONArray(request("${baseUrl()}/api/conversations/$CONVERSATION_ID/messages?limit=40", null, token)) }
    }.getOrNull() ?: return
    for (index in 0 until history.length()) history.optJSONObject(index)?.let { showChatMessage(it, alert = false) }
  }

  private fun sendChatMessage() {
    val text = chatInput.text.toString().trim()
    val activeSocket = socket ?: return
    if (text.isEmpty()) return
    chatInput.setText("")
    activeSocket.emit("send_message", JSONObject()
      .put("conversationId", CONVERSATION_ID)
      .put("content", text)
      .put("type", "text"), Ack { result ->
        val error = (result.firstOrNull() as? JSONObject)?.optString("error").orEmpty()
        if (error.isNotEmpty()) runOnUiThread {
          if (chatInput.text.isEmpty()) chatInput.setText(text)
          Toast.makeText(this, R.string.chat_send_failed, Toast.LENGTH_SHORT).show()
        }
      })
  }

  private fun setupSocketListeners() {
    socket?.on(Socket.EVENT_CONNECT) { _ ->
      runOnUiThread {
        if (lessonActive) statusText.text = getString(if (sharing) R.string.status_sharing else R.string.status_screen_share_stopped)
        lifecycleScope.launch { loadChatHistory() }
      }
    }
    socket?.on(Socket.EVENT_DISCONNECT) { _ ->
      runOnUiThread { if (lessonActive) statusText.text = getString(R.string.status_reconnecting) }
    }
    socket?.on(Socket.EVENT_CONNECT_ERROR) { _ ->
      runOnUiThread {
        // Before the lesson starts the server cannot be reached; once it runs, socket.io keeps retrying
        // on its own and the stream to the students carries on meanwhile.
        if (!lessonActive && room == null) stopLesson(getString(R.string.status_connection_error))
        else statusText.text = getString(R.string.status_reconnecting)
      }
    }
    socket?.on("wb_started") { data ->
      val started = data.firstOrNull() as? JSONObject ?: return@on
      runOnUiThread {
        if (started.optString("presenterId") == userId) lifecycleScope.launch { connectLessonMedia() }
        else if (room != null) stopLesson(getString(R.string.status_another_teacher))
      }
    }
    socket?.on("wb_ended") { _ ->
      runOnUiThread { if (lessonActive) stopLesson(getString(R.string.status_lesson_ended_elsewhere)) }
    }
    // Sent on every reconnection; a server restart forgets the lesson, which then has to be started again.
    socket?.on("lesson_state") { args ->
      val lesson = (args.firstOrNull() as? JSONObject)?.optJSONObject("lesson")
      runOnUiThread {
        if (!lessonActive) return@runOnUiThread
        if (lesson?.optString("presenterId") != userId) stopLesson(getString(R.string.status_lesson_interrupted))
        else lesson?.optJSONArray("hands")?.let(::applyHands)
      }
    }
    socket?.on("lesson_hands") { args ->
      val hands = (args.firstOrNull() as? JSONObject)?.optJSONArray("hands") ?: return@on
      runOnUiThread { applyHands(hands) }
    }
    socket?.on("new_message") { args ->
      val message = args.firstOrNull() as? JSONObject ?: return@on
      runOnUiThread { showChatMessage(message, alert = true) }
    }
    socket?.on("message_deleted") { args ->
      val messageId = (args.firstOrNull() as? JSONObject)?.optString("messageId") ?: return@on
      runOnUiThread { chatBubbles.remove(messageId)?.first?.let { chatMessages.removeView(it) } }
    }
    socket?.on("message_edited") { args ->
      val edit = args.firstOrNull() as? JSONObject ?: return@on
      runOnUiThread { chatBubbles[edit.optString("messageId")]?.second?.text = edit.optString("content") }
    }
  }

  private fun startParticipantRefresh() {
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
      if (identity.getJSONObject("user").optString("role") != "teacher") {
        stopLesson(getString(R.string.status_not_teacher_code)); return
      }
      authToken = identity.getString("token")
      userId = identity.getJSONObject("user").getString("id")
      clearChat()
      connectSocket(authToken!!)
      setupSocketListeners()
      // Only the first connection asks for the lesson, so a reconnect never starts one unprompted.
      socket?.once(Socket.EVENT_CONNECT) {
        socket?.emit("wb_start", JSONObject().put("conversationId", CONVERSATION_ID), Ack { result ->
          val reply = result.firstOrNull() as? JSONObject
          if (reply?.optString("presenterId") != userId) runOnUiThread {
            stopLesson(getString(if (reply?.has("error") == true) R.string.status_not_teacher_code else R.string.status_another_teacher))
          }
        })
      }
      socket?.connect()
    } catch (error: ServerException) {
      stopLesson(getString(when (error.status) {
        401 -> R.string.status_wrong_code
        429 -> R.string.status_too_many_attempts
        else -> R.string.status_connection_failed
      }))
    } catch (error: Exception) { stopLesson(getString(R.string.status_connection_failed)) }
  }

  private suspend fun connectLessonMedia() {
    try {
      if (room != null) return
      val credentials = getCredentials(authToken!!)
      PeerConnectionFactory.initialize(
        PeerConnectionFactory.InitializationOptions.builder(applicationContext).createInitializationOptions()
      )
      val lessonRoom = LiveKit.create(applicationContext)
      room = lessonRoom
      watchRoom(lessonRoom)
      lessonRoom.connect(credentials.getString("url"), credentials.getString("token"))
      lessonRoom.localParticipant.setMicrophoneEnabled(true)
      val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
      @Suppress("DEPRECATION") am.isSpeakerphoneOn = true
      lessonActive = true
      startForegroundService(Intent(this@MainActivity, LessonService::class.java))
      startParticipantRefresh()
      // The lesson screen opens before the capture prompt, so declining it still leaves the
      // teacher in the running lesson with a share button instead of on the setup screen.
      showLessonUI()
      statusText.text = getString(R.string.status_screen_share_stopped)
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
    roomEvents?.cancel(); roomEvents = null
    raisedHands.clear()
    participantsShown = ""
    getSystemService(NotificationManager::class.java).cancel(HAND_NOTIFICATION_ID)
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
      shareBtn.text = getString(R.string.action_share)
      muteBtn.text = getString(R.string.action_mute)
      showSetupUI()
    }
    // A failed or refused start must not leave a connected socket that still holds, or later claims, the lesson.
    socket?.emit("wb_end", JSONObject().put("conversationId", CONVERSATION_ID)); socket?.disconnect(); socket = null
    statusText.text = message
  }

  private suspend fun joinClass(): JSONObject = withContext(Dispatchers.IO) {
    val base = baseUrl()
    val body = JSONObject().put("classCode", classCode.text.toString()).put("visitorId", visitorId()).put("displayName", displayName.text.toString())
    JSONObject(request("$base/api/auth/join", body, null))
  }

  private suspend fun getCredentials(token: String): JSONObject = withContext(Dispatchers.IO) {
    JSONObject(request("${baseUrl()}/api/livekit/token", JSONObject().put("conversationId", CONVERSATION_ID), token))
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

  private class ServerException(val status: Int, message: String) : Exception(message)

  // Sends a JSON body as POST, or makes a GET request when there is no body.
  private fun request(url: String, body: JSONObject?, token: String?): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    // Without timeouts a stalled network would leave the teacher on "signing in" indefinitely.
    connection.connectTimeout = 15_000
    connection.readTimeout = 20_000
    connection.requestMethod = if (body == null) "GET" else "POST"
    if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
    if (body != null) {
      connection.setRequestProperty("Content-Type", "application/json")
      connection.doOutput = true
      connection.outputStream.use { it.write(body.toString().toByteArray()) }
    }
    val status = connection.responseCode
    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
    val response = stream?.bufferedReader()?.use { it.readText() } ?: ""
    if (status !in 200..299) throw ServerException(status, response)
    return response
  }

  override fun onDestroy() { super.onDestroy() }
}
