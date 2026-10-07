package com.samycc777.majlis

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Point
import android.graphics.RectF
import android.graphics.Typeface
import android.hardware.display.DisplayManager
import android.hardware.input.InputManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.Display
import android.view.View
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.core.graphics.toColorInt
import androidx.core.net.toUri
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min

// While the teacher shares his tablet's screen, students can point at it and draw on it from the
// website. His own copy of the page sends their pointers and drawings here, and this plugin draws
// them in a see-through window on top of every app, so he sees them over the book he is reading.
// Because that window is part of the screen being shared, everyone else sees the same marks too.
// It also saves a picture of the shared screen to the gallery, which a page inside an app cannot do.
@CapacitorPlugin(
  name = "Board",
  permissions = [Permission(alias = "storage", strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE])],
)
class BoardPlugin : Plugin() {
  private val main = Handler(Looper.getMainLooper())
  private var board: BoardView? = null
  private var windowManager: WindowManager? = null
  // Whether drawing over other apps was allowed when we last looked, so coming back from Android's
  // settings can tell the page when the answer changed. Null until the page first asks.
  private var knownAllowed: Boolean? = null

  @PluginMethod
  fun canDraw(call: PluginCall) {
    val allowed = Settings.canDrawOverlays(context)
    knownAllowed = allowed
    call.resolve(JSObject().put("allowed", allowed))
  }

  @PluginMethod
  fun askToDraw(call: PluginCall) {
    knownAllowed = Settings.canDrawOverlays(context)
    val forThisApp = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, ("package:" + context.packageName).toUri())
    try {
      activity.startActivity(forThisApp)
    } catch (error: ActivityNotFoundException) {
      // Some phones only have the list of all apps, not the page for one app.
      try {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
      } catch (missing: ActivityNotFoundException) {
        call.reject("This device cannot allow drawing over other apps", "UNAVAILABLE")
        return
      }
    }
    call.resolve()
  }

  override fun handleOnResume() {
    val before = knownAllowed ?: return
    if (reportIfChanged(before)) return
    // Android 8 says "not allowed" for a moment after the switch is turned on, so look again shortly.
    if (Build.VERSION.SDK_INT in 26..27) main.postDelayed({ reportIfChanged(before) }, 1000)
  }

  private fun reportIfChanged(before: Boolean): Boolean {
    val allowed = Settings.canDrawOverlays(context)
    if (allowed == before || knownAllowed != before) return false
    knownAllowed = allowed
    notifyListeners("drawPermission", JSObject().put("allowed", allowed))
    return true
  }

  @PluginMethod
  fun show(call: PluginCall) {
    if (!Settings.canDrawOverlays(context)) {
      call.reject("Drawing over other apps is not allowed", "NOT_ALLOWED")
      return
    }
    // The page sends the whole board up to twenty times a second, so it is read here, off the main
    // thread, and the main thread only swaps it in and redraws.
    val strokes = readStrokes(call)
    val pointers = readPointers(call)
    val speakers = readTexts(call, "speakers")
    val notices = readTexts(call, "notices")
    main.post {
      try {
        val view = board ?: addBoard()
        view.strokes = strokes
        view.pointers = pointers
        view.speakers = speakers
        view.notices = notices
        view.invalidate()
        call.resolve()
      } catch (error: Exception) {
        // Android refuses the window when the permission was taken away a moment ago.
        call.reject("The drawings could not be shown", "NOT_ALLOWED")
      }
    }
  }

  @PluginMethod
  fun hide(call: PluginCall) {
    main.post {
      removeBoard()
      call.resolve()
    }
  }

  // Android calls this on the main thread, so the window can go right away.
  override fun handleOnDestroy() {
    main.removeCallbacksAndMessages(null)
    removeBoard()
  }

  // The window belongs to the application, not to the screen of the app, so it stays on top while
  // the teacher is in his book app and Majlis is in the background.
  private fun addBoard(): BoardView {
    val windowContext = overlayContext()
    val manager = windowContext.getSystemService(WindowManager::class.java)
    val view = BoardView(windowContext, manager)
    @Suppress("DEPRECATION")
    val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
    val params = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
        WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
      PixelFormat.TRANSLUCENT,
    )
    params.title = "Majlis board"
    // The marks must reach the very edges, around a camera notch too, to land where students drew them.
    if (Build.VERSION.SDK_INT >= 30) {
      params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      params.fitInsetsTypes = 0
    } else if (Build.VERSION.SDK_INT >= 28) {
      params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }
    // Android 12 and newer stop touches from reaching another app through a window drawn over it
    // unless that window is at least partly see-through. Without this the teacher could no longer
    // turn the pages of his book while the marks are shown.
    if (Build.VERSION.SDK_INT >= 31) {
      params.alpha = windowContext.getSystemService(InputManager::class.java).maximumObscuringOpacityForTouch
    }
    manager.addView(view, params)
    board = view
    windowManager = manager
    return view
  }

  private fun removeBoard() {
    val view = board ?: return
    board = null
    try {
      windowManager?.removeViewImmediate(view)
    } catch (error: Exception) {
      // The window was already gone, for example after the permission was taken away.
    }
    windowManager = null
  }

  // Android 11 and newer want windows over other apps added through a context made for that kind of
  // window; it also reports the size of the whole screen in its current rotation.
  private fun overlayContext(): Context {
    val app = context.applicationContext
    if (Build.VERSION.SDK_INT < 30) return app
    val display = app.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
    return app.createDisplayContext(display).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
  }

  private fun readStrokes(call: PluginCall): List<Stroke> {
    val list = call.getArray("strokes") ?: return emptyList()
    val strokes = ArrayList<Stroke>(list.length())
    for (i in 0 until list.length()) {
      val item = list.optJSONObject(i) ?: continue
      val raw = item.optJSONArray("points") ?: continue
      val points = FloatArray(raw.length() - raw.length() % 2)
      for (j in points.indices) points[j] = raw.optDouble(j, 0.0).toFloat().takeIf { it.isFinite() } ?: 0f
      if (points.isNotEmpty()) strokes.add(Stroke(color(item.optString("color")), points))
    }
    return strokes
  }

  private fun readPointers(call: PluginCall): List<Pointer> {
    val list = call.getArray("pointers") ?: return emptyList()
    val pointers = ArrayList<Pointer>(list.length())
    for (i in 0 until list.length()) {
      val item = list.optJSONObject(i) ?: continue
      val x = item.optDouble("x").toFloat()
      val y = item.optDouble("y").toFloat()
      if (!x.isFinite() || !y.isFinite()) continue
      pointers.add(Pointer(x, y, color(item.optString("color")), item.optString("name")))
    }
    return pointers
  }

  // An app page from before these existed sends none, which shows nothing.
  private fun readTexts(call: PluginCall, key: String): List<String> {
    val list = call.getArray(key) ?: return emptyList()
    return (0 until list.length()).mapNotNull { i -> list.optString(i).trim().takeIf { it.isNotEmpty() } }
  }

  // An empty or unknown colour falls back to white rather than losing the whole board.
  private fun color(text: String): Int =
    try { text.toColorInt() } catch (error: Exception) { Color.WHITE }

  @PluginMethod
  fun savePicture(call: PluginCall) {
    if (call.getString("data").isNullOrBlank()) {
      call.reject("Missing picture")
      return
    }
    // Android 10 and newer let an app add pictures to the gallery without asking; older versions
    // need the storage permission first.
    if (Build.VERSION.SDK_INT < 29 && getPermissionState("storage") != PermissionState.GRANTED) {
      requestPermissionForAlias("storage", call, "onStorageAnswered")
      return
    }
    save(call)
  }

  @PermissionCallback
  private fun onStorageAnswered(call: PluginCall) {
    if (getPermissionState("storage") != PermissionState.GRANTED) {
      call.reject("Saving pictures was not allowed", "DENIED")
      return
    }
    // The answer arrives on the main thread; writing the file belongs elsewhere.
    bridge.execute { save(call) }
  }

  private fun save(call: PluginCall) {
    val bytes = try {
      Base64.decode(call.getString("data")!!.substringAfter("base64,"), Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      call.reject("The picture could not be read")
      return
    }
    val name = (call.getString("name") ?: "").replace(Regex("[\\\\/:*?\"<>|\\n\\r]"), "-").trim().ifEmpty { "Majlis" }
    try {
      if (Build.VERSION.SDK_INT >= 29) saveToGallery(bytes, name) else saveToFolder(bytes, name)
      call.resolve(JSObject().put("saved", true))
    } catch (error: Exception) {
      call.reject("The picture could not be saved to the gallery", "FAILED")
    }
  }

  // The picture stays hidden from the gallery while it is written, so a half-written file never shows.
  @RequiresApi(29)
  private fun saveToGallery(bytes: ByteArray, name: String) {
    val resolver = context.contentResolver
    val details = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, "$name.png")
      put(MediaStore.Images.Media.MIME_TYPE, "image/png")
      put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Majlis")
      put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), details)
      ?: throw IllegalStateException("The gallery refused the picture")
    try {
      val output = resolver.openOutputStream(uri) ?: throw IllegalStateException("The gallery refused the picture")
      output.use { it.write(bytes) }
      resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
    } catch (error: Exception) {
      resolver.delete(uri, null, null)
      throw error
    }
  }

  // Before Android 10 the gallery shows whatever is in the Pictures folder once the phone has looked
  // at the new file, which MediaScannerConnection asks it to do.
  private fun saveToFolder(bytes: ByteArray, name: String) {
    @Suppress("DEPRECATION")
    val folder = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Majlis")
    if (!folder.isDirectory && !folder.mkdirs()) throw IllegalStateException("No Pictures folder")
    var file = File(folder, "$name.png")
    var copy = 2
    while (file.exists()) file = File(folder, "$name (${copy++}).png")
    FileOutputStream(file).use { it.write(bytes) }
    MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf("image/png"), null)
  }

  private class Stroke(val color: Int, val points: FloatArray)

  private class Pointer(val x: Float, val y: Float, val color: Int, val name: String)

  // Draws the marks exactly as the website draws them over the shared screen: positions are shares of
  // the whole screen in its current rotation, and sizes are shares of its shorter side, so both copies
  // land on the same spot at the same size.
  private class BoardView(context: Context, private val manager: WindowManager) : View(context) {
    var strokes: List<Stroke> = emptyList()
    var pointers: List<Pointer> = emptyList()
    var speakers: List<String> = emptyList()
    var notices: List<String> = emptyList()

    private val path = Path()
    private val place = IntArray(2)
    private val screen = Point()
    private val label = RectF()
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
      textAlign = Paint.Align.CENTER
    }
    private val behindText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.FILL
      color = Color.argb(153, 0, 0, 0)
    }
    // The same soft green as the glow around someone talking in the call.
    private val talkingDot = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.FILL
      color = "#7cc79a".toColorInt()
    }
    private val density = context.resources.displayMetrics.density
    private val statusBarHeight = context.resources.getIdentifier("status_bar_height", "dimen", "android")
      .let { if (it > 0) context.resources.getDimensionPixelSize(it) else 0 }

    override fun onDraw(canvas: Canvas) {
      if (strokes.isEmpty() && pointers.isEmpty() && speakers.isEmpty() && notices.isEmpty()) return
      // Read every time, because the screen may have turned since the last drawing.
      readScreenSize()
      val width = screen.x.toFloat()
      val height = screen.y.toFloat()
      val u = min(width, height)
      getLocationOnScreen(place)
      val left = place[0].toFloat()
      val top = place[1].toFloat()

      line.strokeWidth = max(2f, 0.008f * u)
      for (stroke in strokes) {
        val points = stroke.points
        line.color = stroke.color
        if (points.size == 2) {
          canvas.drawPoint(points[0] * width - left, points[1] * height - top, line)
          continue
        }
        path.rewind()
        path.moveTo(points[0] * width - left, points[1] * height - top)
        for (i in 2 until points.size step 2) path.lineTo(points[i] * width - left, points[i + 1] * height - top)
        canvas.drawPath(path, line)
      }

      line.strokeWidth = 0.006f * u
      text.textSize = max(10f, 0.03f * u)
      val ascent = text.ascent()
      val descent = text.descent()
      for (pointer in pointers) {
        val x = pointer.x * width - left
        val y = pointer.y * height - top
        line.color = pointer.color
        fill.color = pointer.color
        canvas.drawCircle(x, y, 0.035f * u, line)
        canvas.drawCircle(x, y, 0.008f * u, fill)
        if (pointer.name.isEmpty()) continue
        val textTop = y + 0.035f * u + 0.012f * u
        val halfWidth = text.measureText(pointer.name) / 2
        label.set(
          x - halfWidth - 0.016f * u,
          textTop - 0.008f * u,
          x + halfWidth + 0.016f * u,
          textTop + (descent - ascent) + 0.008f * u,
        )
        canvas.drawRoundRect(label, 0.012f * u, 0.012f * u, behindText)
        canvas.drawText(pointer.name, x, textTop - ascent, text)
      }

      drawSigns(canvas, width, top, left)
    }

    // Who is talking, then who joined or left, in small labels at the top middle of the screen,
    // just below the phone's status bar, so they stay out of the way of the book being read.
    private fun drawSigns(canvas: Canvas, width: Float, top: Float, left: Float) {
      if (speakers.isEmpty() && notices.isEmpty()) return
      text.textSize = 13f * density
      val ascent = text.ascent()
      val descent = text.descent()
      val padX = 10f * density
      val padY = 5f * density
      val gap = 6f * density
      val dot = 4f * density
      val middle = width / 2 - left
      var y = statusBarHeight + 6f * density - top
      val lines = (if (speakers.isEmpty()) emptyList() else listOf(speakers.joinToString("  ·  "))) + notices
      lines.forEachIndexed { index, line ->
        val talking = index == 0 && speakers.isNotEmpty()
        val textWidth = text.measureText(line)
        val inner = textWidth + if (talking) dot * 2 + gap else 0f
        label.set(middle - inner / 2 - padX, y, middle + inner / 2 + padX, y + (descent - ascent) + padY * 2)
        canvas.drawRoundRect(label, label.height() / 2, label.height() / 2, behindText)
        var textMiddle = middle
        if (talking) {
          canvas.drawCircle(label.left + padX + dot, label.centerY(), dot, talkingDot)
          textMiddle += (dot * 2 + gap) / 2
        }
        canvas.drawText(line, textMiddle, y + padY - ascent, text)
        y = label.bottom + 4f * density
      }
    }

    private fun readScreenSize() {
      if (Build.VERSION.SDK_INT >= 30) {
        val bounds = manager.currentWindowMetrics.bounds
        screen.set(bounds.width(), bounds.height())
      } else {
        @Suppress("DEPRECATION")
        manager.defaultDisplay.getRealSize(screen)
      }
    }
  }
}
