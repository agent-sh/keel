package dev.avifenesh.keel

import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.Root
import kotlinx.coroutines.launch

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Cache.init(this)
        Face.init(this)
        Notify.channels(this)
        if (Prefs.paired && Prefs.pushState != "on") Push.schedule(this)
    }
}

sealed class Route {
    data class Tabs(val tab: Int) : Route()
    /** `back`: where Back leads (the session it was opened from, for an agent's), else the list. */
    data class Session(val id: String, val back: Route? = null) : Route()
    /** The search across sessions. */
    object Search : Route()
    /** What broke on the daemon: its open errors, as the page's Errors panel lists them. */
    object Errors : Route()
    /** What a session changed. */
    data class Changes(val id: String) : Route()
    /** One file's diff, of one turn (`turn`) or since the session's first (null); `label` names which. */
    data class Diff(val id: String, val path: String, val turn: Long?, val label: String) : Route()
    /** The helper's memory. */
    object Memory : Route()
    companion object {
        /** Where a notification's `to` leads: needs (the Needs you tab), errors (the Errors view), else the sessions. */
        fun of(to: String): Route = when (to) { "needs" -> Tabs(1); "errors" -> Errors; else -> Tabs(0) }
    }
}

object BuildConfigLike {
    fun version(c: android.content.Context): String = runCatching { c.packageManager.getPackageInfo(c.packageName, 0).versionName }.getOrNull() ?: ""
}

/** UI state that outlives a screen. */
object Ui {
    val paired = mutableStateOf(false)
    val route = mutableStateOf<Route>(Route.Tabs(0))
    val link = mutableStateOf<Wire.PairLink?>(null)
    val linkError = mutableStateOf("")
    /** How the last unpairing ended, said on the pairing screen until a new pairing starts. */
    val unpaired = mutableStateOf<Unpaired?>(null)
    val theme = mutableIntStateOf(0)
    /** The start sheet is open. */
    val starting = mutableStateOf(false)
    /** The app is on the screen (it shows what runs itself; the lasting notification is for the back). */
    @Volatile var inFront = false
    fun open(chat: String) { route.value = Route.Session(chat) }
    /** An agent's session (or its starter's) opened from a session: Back returns there. */
    fun openFrom(chat: String, from: Route.Session) { route.value = Route.Session(chat, back = from) }
}

class MainActivity : FragmentActivity() {
    private val net = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = Hub.nudge()
        override fun onCapabilitiesChanged(network: Network, caps: android.net.NetworkCapabilities) = Hub.nudge()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Ui.paired.value = Prefs.paired
        Ui.theme.intValue = Prefs.theme
        // What the phone last held, at once: the stream catches up from there.
        Hub.scope.launch { Hub.restore() }
        // The link or notification that opened the app is taken once. A screen made again (the text size,
        // the theme or the turn of the phone changed) is handed the same intent: taken again, it asked to
        // pair once more after a cancel, and opened again a session the owner had left.
        if (savedInstanceState == null) handle(intent)
        setContent { KeelTheme(Ui.theme.intValue) { Root(this) } }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handle(intent) }

    private fun handle(i: Intent?) {
        val data = i?.data
        if (data != null && data.scheme == "keel") {
            val l = Wire.parsePair(data.toString())
            if (l == null) Ui.linkError.value = "That pairing link is not complete. Show a new code on the computer."
            else { Ui.link.value = l; Ui.linkError.value = "" }
        }
        i?.getStringExtra("chat")?.let { if (Prefs.paired) Ui.open(it) }
        // A notification that names no session leads to a list: what needs the owner, the Errors view, or the sessions.
        i?.getStringExtra("to")?.let { if (Prefs.paired && i.getStringExtra("chat") == null) Ui.route.value = Route.of(it) }
    }

    // The owner's last touch, told to the daemon at most every 20 s (a page reports as often): the phone
    // in use ends an absence, so the away digest counts only the time the owner was at neither.
    @Volatile private var touched = 0L
    @Volatile private var told = 0L
    override fun onUserInteraction() {
        super.onUserInteraction()
        touched = System.currentTimeMillis()
        if (Prefs.paired && touched - told >= 20_000) {
            told = touched
            Hub.scope.launch { runCatching { Hub.present(System.currentTimeMillis() - touched) } }
        }
    }

    override fun onStart() {
        super.onStart()
        Ui.inFront = true
        Notify.hideLive(this)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(net)
        if (Prefs.paired) onPaired(first = false)
    }

    override fun onStop() {
        super.onStop()
        Ui.inFront = false
        // What runs as the app goes to the back stays told: pushes (or the check) carry it on from here.
        if (Prefs.paired) Notify.live(this, Live.of(Hub.working.value, Hub.cards.value.values, Hub.chats.value, Hub.errors.value?.unread ?: 0))
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(net) }
        Hub.stop()
    }

    /** Starts the live connection and push; asks for the notification permission once paired. */
    fun onPaired(first: Boolean) {
        Ui.paired.value = true
        Hub.start(); Hub.nudge()
        Hub.scope.launch {
            val on = runCatching { Push.refresh(applicationContext) }.getOrDefault(false)
            if (on) Push.unschedule(applicationContext) else Push.schedule(applicationContext)
        }
        if (first && Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    /** Forgets this pairing here; the daemon was told first, and `how` says whether it confirmed. */
    fun unpaired(how: Unpaired) {
        Ui.unpaired.value = how
        Api.generation++
        Hub.reset(); Attach.reset()
        Push.unschedule(this)
        Prefs.clear(); Keys.reset()
        Ui.paired.value = false
        Ui.route.value = Route.Tabs(0)
    }
}
