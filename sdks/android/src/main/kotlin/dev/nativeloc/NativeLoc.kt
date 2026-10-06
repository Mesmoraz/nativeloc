package dev.nativeloc

import android.content.Context
import android.icu.text.MessageFormat
import android.icu.util.ULocale
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * NativeLoc runtime for Android screens.
 *
 * ```
 * NativeLoc.init(context, "https://loc.example.com", "pb_xxx", locale = "es")
 * textView.text = NativeLoc.t("welcome_back", "Sam")      // %1$s / {arg1}
 * cartView.text = NativeLoc.t("cart_items", 3)            // plurals pick the right form
 * NativeLoc.onChange { recreate() }                        // new strings published
 * ```
 *
 * Lookup order: downloaded bundle for the locale → downloaded source bundle → the app's own
 * `res/values*` strings (keys are resource names) → the key. `t` never throws.
 */
object NativeLoc {
    private lateinit var app: Context
    private lateinit var baseUrl: String
    private lateinit var bundleToken: String
    @Volatile var locale: String = Locale.getDefault().toLanguageTag()
        private set

    @Volatile var version: Int = 0
        private set

    @Volatile private var sourceLocale: String? = null
    @Volatile private var etag: String? = null

    private val bundles = ConcurrentHashMap<String, Map<String, String>>()
    private val shas = ConcurrentHashMap<String, String>()
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val formatters = ConcurrentHashMap<String, MessageFormat>()
    private val io = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "nativeloc").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private var poll: ScheduledFuture<*>? = null

    /** Text most recently produced for each key, so [NativeLocCapture] can find it on screen. */
    internal val rendered = ConcurrentHashMap<String, String>()

    private val cacheDir get() = File(app.filesDir, "nativeloc").apply { mkdirs() }

    @JvmStatic
    @JvmOverloads
    fun init(context: Context, baseUrl: String, bundleToken: String, locale: String = Locale.getDefault().toLanguageTag(), pollMinutes: Long = 15) {
        app = context.applicationContext
        this.baseUrl = baseUrl.trimEnd('/')
        this.bundleToken = bundleToken
        this.locale = locale
        loadCache()
        poll?.cancel(false)
        poll = io.scheduleWithFixedDelay({ safeRefresh() }, 0, pollMinutes, TimeUnit.MINUTES)
    }

    fun onChange(listener: () -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    fun setLocale(tag: String) {
        locale = tag
        formatters.clear()
        readCached(tag)
        io.execute { safeRefresh(); notifyChanged() }
    }

    /**
     * Translate [key]. Positional [args] map to `{arg1}`, `{arg2}`… (Android's `%1$s` style);
     * the first number also drives plural selection.
     */
    @JvmStatic
    fun t(key: String, vararg args: Any): String {
        val text = format(key, args)
        rendered[key] = text
        return text
    }

    private fun format(key: String, args: Array<out Any>): String {
        val wanted = locale
        val source = sourceLocale ?: wanted
        val (message, lang) = bundles[wanted]?.get(key)?.let { it to wanted }
            ?: bundles[source]?.get(key)?.let { it to source }
            ?: return resourceFallback(key, args)
        return try {
            val fmt = formatters.getOrPut("$lang\u0000$message") { MessageFormat(message, ULocale.forLanguageTag(lang)) }
            val map = HashMap<String, Any>()
            args.forEachIndexed { i, v -> map["arg${i + 1}"] = v }
            args.firstOrNull { it is Number }?.let { map["count"] = it }
            fmt.format(map)
        } catch (e: IllegalArgumentException) {
            message
        }
    }

    /** The strings compiled into the app (res/values-xx) are the offline fallback. */
    private fun resourceFallback(key: String, args: Array<out Any>): String {
        val res = app.resources
        val pkg = app.packageName
        return try {
            val str = res.getIdentifier(key, "string", pkg)
            if (str != 0) return if (args.isEmpty()) res.getString(str) else res.getString(str, *args)
            val plural = res.getIdentifier(key, "plurals", pkg)
            val n = (args.firstOrNull { it is Number } as? Number)?.toInt() ?: 0
            if (plural != 0) res.getQuantityString(plural, n, *args) else key
        } catch (e: Exception) {
            key
        }
    }

    // ---------------------------------------------------------------- network & cache

    /** Blocking check for a newer version; call off the main thread. Returns true if strings changed. */
    fun refresh(): Boolean {
        val haveAll = wanted().all { bundles.containsKey(it) }
        val conn = open("$baseUrl/b/$bundleToken/manifest.json", if (haveAll) etag else null)
        try {
            if (conn.responseCode == 304) return false
            if (conn.responseCode != 200) return false
            val manifest = JSONObject(conn.inputStream.bufferedReader().readText())
            sourceLocale = manifest.getString("sourceLocale")
            val locales = manifest.getJSONObject("locales")
            var changed = false
            for (loc in wanted()) {
                val info = locales.optJSONObject(loc) ?: continue
                val sha = info.getString("sha256")
                if (shas[loc] == sha && bundles.containsKey(loc)) continue
                val b = open(baseUrl + info.getString("url"), null)
                try {
                    if (b.responseCode != 200) continue
                    val raw = b.inputStream.bufferedReader().readText()
                    bundles[loc] = parseBundle(raw)
                    shas[loc] = sha
                    writeAtomic("bundle_$loc.json", JSONObject().put("sha256", sha).put("bundle", JSONObject(raw)).toString())
                    changed = true
                } finally {
                    b.disconnect()
                }
            }
            etag = conn.getHeaderField("ETag")
            version = manifest.getInt("version")
            writeAtomic("meta.json", JSONObject().put("sourceLocale", sourceLocale).put("version", version).put("etag", etag).toString())
            if (changed) {
                formatters.clear()
                notifyChanged()
            }
            return changed
        } finally {
            conn.disconnect()
        }
    }

    private fun safeRefresh() {
        try {
            refresh()
        } catch (e: Exception) {
            // Offline or server unreachable: cached and bundled strings keep working.
        }
    }

    private fun notifyChanged() = main.post { listeners.forEach { it() } }

    private fun wanted() = listOfNotNull(locale, sourceLocale).distinct()

    private fun open(url: String, ifNoneMatch: String?): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 5000
            readTimeout = 10000
            ifNoneMatch?.let { setRequestProperty("If-None-Match", it) }
        }

    private fun parseBundle(raw: String): Map<String, String> {
        val o = JSONObject(raw)
        return o.keys().asSequence().associateWith { o.getString(it) }
    }

    private fun loadCache() {
        File(cacheDir, "meta.json").takeIf { it.exists() }?.let {
            val m = JSONObject(it.readText())
            sourceLocale = m.optString("sourceLocale").ifEmpty { null }
            version = m.optInt("version")
            etag = m.optString("etag").ifEmpty { null }
        }
        wanted().forEach { readCached(it) }
    }

    private fun readCached(loc: String) {
        val f = File(cacheDir, "bundle_$loc.json")
        if (!f.exists()) return
        try {
            val entry = JSONObject(f.readText())
            bundles[loc] = parseBundle(entry.getJSONObject("bundle").toString())
            shas[loc] = entry.getString("sha256")
        } catch (e: Exception) {
            f.delete()
        }
    }

    private fun writeAtomic(name: String, content: String) {
        val tmp = File(cacheDir, "$name.tmp")
        tmp.writeText(content)
        tmp.renameTo(File(cacheDir, name))
    }

    internal fun baseUrl() = baseUrl
}
