package dev.nativeloc

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Debug-build helper: screenshot the current screen and tell NativeLoc which strings are
 * where, so localizers see each string highlighted in context.
 *
 * ```
 * if (BuildConfig.DEBUG) NativeLocCapture.capture(this, projectId = 1, pushToken = BuildConfig.NATIVELOC_PUSH, label = "Cart")
 * ```
 * Never ship a push token in release builds.
 */
object NativeLocCapture {
    fun capture(activity: Activity, projectId: Int, pushToken: String, label: String, onDone: (String) -> Unit = {}) {
        val root = activity.window.decorView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(bitmap))

        // Match on-screen TextViews against the text NativeLoc.t() produced for each key.
        val byText = NativeLoc.rendered.entries.groupBy({ it.value }, { it.key })
        val boxes = JSONArray()
        val loc = IntArray(2)
        walk(root) { v ->
            if (v is TextView && v.isShown) {
                byText[v.text?.toString()]?.forEach { key ->
                    v.getLocationInWindow(loc)
                    boxes.put(JSONObject().put("key", key).put("x", loc[0]).put("y", loc[1]).put("w", v.width).put("h", v.height))
                }
            }
        }

        thread(name = "nativeloc-capture") {
            val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            val msg = try {
                upload(projectId, pushToken, label, boxes.toString(), png)
            } catch (e: Exception) {
                "NativeLoc capture failed: ${e.message}"
            }
            activity.runOnUiThread { onDone(msg) }
        }
    }

    private fun walk(v: View, fn: (View) -> Unit) {
        fn(v)
        if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), fn)
    }

    private fun upload(projectId: Int, token: String, label: String, keys: String, png: ByteArray): String {
        val boundary = UUID.randomUUID().toString()
        val conn = URL("${NativeLoc.baseUrl()}/api/v1/projects/$projectId/screenshots").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        conn.outputStream.use { out ->
            fun field(name: String, value: String) =
                out.write("--$boundary\r\nContent-Disposition: form-data; name=\"$name\"\r\n\r\n$value\r\n".toByteArray())
            field("label", label)
            field("keys", keys)
            out.write("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"screen.png\"\r\nContent-Type: image/png\r\n\r\n".toByteArray())
            out.write(png)
            out.write("\r\n--$boundary--\r\n".toByteArray())
        }
        val code = conn.responseCode
        conn.disconnect()
        return if (code == 200) "Screenshot sent to NativeLoc" else "NativeLoc capture failed: HTTP $code"
    }
}
