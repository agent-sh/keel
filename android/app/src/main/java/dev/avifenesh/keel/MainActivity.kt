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
        Notify.channels(this)
        if (Prefs.paired && Prefs.pushState != "on") Push.schedule(this)
    }
}

sealed class Route {
    data class Tabs(val tab: Int) : Route()
    /** `back`: where Back leads (the session it was opened from, for an agent's), else the list. */
    data class Session(val id: String, val back: Route? = null) : Route()
    /** What a session changed. */
    data class Changes(val id: String) : Route()
    /** One file's diff, of one turn (`turn`) or since the session's first (null); `label` names which. */
    data class Diff(val id: String, val path: String, val turn: Long?, val label: String) : Route()
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
        handle(intent)
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
    }

    override fun onStart() {
        super.onStart()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(net)
        if (Prefs.paired) onPaired(first = false)
    }

    override fun onStop() {
        super.onStop()
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
