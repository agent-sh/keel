// Needs you, Usage and Settings.
package dev.avifenesh.keel.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import dev.avifenesh.keel.Api
import dev.avifenesh.keel.ApiError
import dev.avifenesh.keel.BuildConfigLike
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.MainActivity
import dev.avifenesh.keel.Me
import dev.avifenesh.keel.Prefs
import dev.avifenesh.keel.Pulse
import dev.avifenesh.keel.Push
import dev.avifenesh.keel.State
import dev.avifenesh.keel.nextLook
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.unpaired
import kotlinx.coroutines.launch

@Composable
fun NeedsScreen(act: MainActivity) {
    val k = k()
    val cards by Hub.cards.collectAsState()
    val chats by Hub.chats.collectAsState()
    val open = nextLook(cards.values.filter { it.pending })
    Column(Modifier.fillMaxSize()) {
        Head("Needs you", sub = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StateMark(if (open.isEmpty()) State.DONE else State.NEEDS, 8.dp); Spacer(Modifier.width(6.dp))
                Txt(if (open.isEmpty()) "Nothing waits" else "${open.size} waiting", T.meta, k.muted)
            }
        })
        if (open.isEmpty()) { Empty("Nothing waits for you", "Approvals and questions from every session land here, and on the lock screen when push is on."); return }
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = S.md), verticalArrangement = Arrangement.spacedBy(S.md)) {
            items(open, key = { it.id }) { c ->
                CardView(act, c, title = chats[c.chatId]?.title ?: "A session", onOpen = { Ui.open(c.chatId) })
            }
            item { Spacer(Modifier.height(S.xl)) }
        }
    }
}

@Composable
fun UsageScreen() {
    val k = k()
    var data by remember { mutableStateOf<Pulse?>(null) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    fun load() { scope.launch { runCatching { Hub.pulse() }.onSuccess { data = it; error = "" }.onFailure { error = it.message ?: "Not available" } } }
    LaunchedEffect(Unit) { load() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Head("Usage", sub = { Txt(data?.tz?.takeIf { it.isNotBlank() }?.let { "Days in $it" } ?: "From this machine's turns", T.meta, k.muted) }) {
            IconBtn(Ic.RotateCw, "Refresh", { load() }, tint = k.muted, modifier = Modifier.semantics { contentDescription = "refresh" })
        }
        if (error.isNotBlank()) Notice(error, modifier = Modifier.padding(S.lg))
        val d = data ?: return@Column
        Column(Modifier.padding(horizontal = S.md), verticalArrangement = Arrangement.spacedBy(S.md)) {
            Panel {
                Column(Modifier.padding(S.lg)) {
                    Txt("TODAY", T.label, k.muted)
                    Spacer(Modifier.height(6.dp))
                    Txt(d.spendToday?.let { money(it) } ?: "Not priced", T.display.copy(fontSize = T.display.fontSize * 1.25f))
                    val unpriced = d.unpricedToday
                    if (unpriced > 0) Txt("$unpriced turn${if (unpriced == 1) "" else "s"} had no price", T.meta, k.faint)
                    Spacer(Modifier.height(S.lg))
                    Row {
                        Stat("Turns", "${d.runsToday}", k.fg, Modifier.weight(1f))
                        val f = d.failuresToday
                        Stat("Failed runs", "$f", if (f > 0) k.fail else k.fg, Modifier.weight(1f))
                        val w = d.cards.size
                        Stat("Waiting", "$w", if (w > 0) k.need else k.fg, Modifier.weight(1f))
                    }
                }
            }
            Panel {
                Column(Modifier.padding(S.lg)) {
                    Txt("SEVEN DAYS", T.label, k.muted)
                    Spacer(Modifier.height(S.md))
                    val v = d.week
                    Bars(v)
                    Spacer(Modifier.height(8.dp))
                    Row(Modifier.fillMaxWidth()) {
                        val days = (6 downTo 0).map { java.time.LocalDate.now().minusDays(it.toLong()).dayOfWeek.name.take(2).lowercase().replaceFirstChar { c -> c.uppercase() } }
                        days.forEach { Txt(it, T.meta, k.faint, Modifier.weight(1f)) }
                    }
                    Spacer(Modifier.height(6.dp))
                    Txt("${money(v.sum())} this week", T.meta, k.muted)
                }
            }
            val sessions = d.sessions.sortedByDescending { it.cost ?: 0.0 }.take(8)
            if (sessions.isNotEmpty()) Panel {
                Column(Modifier.padding(vertical = S.sm)) {
                    Txt("SESSIONS BY SPEND", T.label, k.muted, Modifier.padding(horizontal = S.lg, vertical = S.sm))
                    for (s in sessions) {
                        Row(Modifier.fillMaxWidth().press({ Ui.open(s.id) }).padding(horizontal = S.lg, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Txt(s.title.ifBlank { "New chat" }, T.uiStrong, maxLines = 1)
                                Txt("${s.model.substringAfter(':')} · ${tok(s.tokensIn)} in · ${tok(s.tokensOut)} out", T.meta, k.faint, maxLines = 1)
                            }
                            Txt(s.cost?.let { money(it) } ?: "n/p", T.meta, k.fg)
                        }
                    }
                }
            }
            Spacer(Modifier.height(S.xl))
        }
    }
}

private fun money(v: Double) = if (v >= 100) "$%.0f".format(v) else if (v >= 1) "$%.2f".format(v) else "$%.3f".format(v)
private fun tok(v: Long) = if (v >= 1_000_000) "%.1fM".format(v / 1e6) else if (v >= 1000) "%.1fk".format(v / 1e3) else "$v"

@Composable
private fun Stat(label: String, value: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier) = Column(modifier) {
    Txt(value, T.title, color); Txt(label, T.meta, k().faint)
}

@Composable
private fun Bars(v: List<Double>) {
    val k = k()
    val max = (v.maxOrNull() ?: 0.0).coerceAtLeast(0.0001)
    Canvas(Modifier.fillMaxWidth().height(96.dp)) {
        val n = v.size.coerceAtLeast(1)
        val slot = size.width / n
        val w = slot * 0.56f
        drawRect(k.line, Offset(0f, size.height - 1f), Size(size.width, 1f))
        v.forEachIndexed { i, x ->
            val h = ((x / max) * (size.height - 6f)).toFloat().coerceAtLeast(if (x > 0) 3f else 0f)
            drawRoundRect(if (i == n - 1) k.ink else k.lineStrong, Offset(i * slot, size.height - h - 1f), Size(w, h), CornerRadius(3f))
        }
    }
}

@Composable
fun SettingsScreen(act: MainActivity) {
    val k = k()
    val scope = rememberCoroutineScope()
    val push by Push.state.collectAsState()
    var confirm by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var me by remember { mutableStateOf<Me?>(null) }
    LaunchedEffect(Unit) { me = runCatching { Hub.me() }.getOrNull() }
    val notifOn = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Head("Settings", sub = { ConnLine() })
            Column(Modifier.padding(horizontal = S.md), verticalArrangement = Arrangement.spacedBy(S.md)) {
                Panel {
                    Column(Modifier.padding(S.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Txt("MACHINE", T.label, k.muted)
                        Kv("Name", Prefs.server ?: "Keel")
                        Kv("Address", Prefs.base.orEmpty(), mono = true)
                        me?.model?.takeIf { it.isNotBlank() }?.let { Kv("Default model", it, mono = true) }
                    }
                }
                Panel {
                    Column(Modifier.padding(S.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Txt("THIS PHONE", T.label, k.muted)
                        me?.device?.takeIf { it.isNotBlank() }?.let { Kv("Paired as", it) }
                        Kv("Device", Prefs.deviceId?.take(12).orEmpty(), mono = true)
                        if (Prefs.noLock) Notice("This phone has no screen lock, so approvals are once only and sessions that run unasked cannot be prompted from it. Set a screen lock, then pair again.", k.work)
                        else Txt("Approvals ask for your fingerprint or screen lock, and the daemon checks that signature.", T.small, k.muted)
                    }
                }
                Panel {
                    Column(Modifier.padding(S.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Txt("ALERTS", T.label, k.muted)
                        val on = push == "on"
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StateMark(if (on) State.DONE else State.STOPPED, 9.dp); Spacer(Modifier.width(8.dp))
                            Txt(if (on) "Push is on" else "Push is off", T.uiStrong)
                        }
                        Txt(if (on) "Approvals, questions and failures arrive on the lock screen. Pushes wait while you are at the computer." else push?.removePrefix("off:") ?: "Not checked yet.", T.small, k.muted)
                        if (!notifOn) Btn("Allow notifications", { act.askNotifications() }, Tone.LINE, compact = true)
                        Btn(if (busy) "Checking" else "Check again", {
                            busy = true
                            scope.launch {
                                val r = runCatching { Push.refresh(act.applicationContext) }
                                note = r.exceptionOrNull()?.message.orEmpty()
                                if (r.getOrDefault(false)) Push.unschedule(act) else Push.schedule(act)
                                busy = false
                            }
                        }, Tone.QUIET, compact = true, enabled = !busy)
                        if (note.isNotBlank()) Notice(note)
                    }
                }
                HelperPanel()
                Panel {
                    Column(Modifier.padding(S.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Txt("LOOK", T.label, k.muted)
                        Segmented(listOf("0" to "System", "1" to "Light", "2" to "Dark"), "${Ui.theme.intValue}") { v ->
                            Ui.theme.intValue = v.toInt(); Prefs.theme = v.toInt()
                        }
                    }
                }
                Panel {
                    Column(Modifier.padding(S.lg), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Txt("PAIRING", T.label, k.muted)
                        Txt("Unpairing deletes this phone's keys here and asks the daemon to revoke it. If the daemon cannot be reached, this phone says so and you revoke it on the computer.", T.small, k.muted)
                        Btn("Unpair this phone", { confirm = true }, Tone.DANGER, tag = "unpair")
                    }
                }
                Txt("Keel ${BuildConfigLike.version(act)} · MIT. Fonts: Martian Mono, IBM Plex Sans, JetBrains Mono (OFL). Icons: Lucide (ISC).", T.meta, k.faint, Modifier.padding(horizontal = S.sm))
                Spacer(Modifier.height(S.xl))
            }
        }
        if (confirm) Dialog(
            title = "Unpair this phone?",
            body = "This phone's keys are deleted and the daemon is asked to stop accepting it. If the daemon does not confirm, you are told to revoke the phone on the computer. Pairing again needs a new code from the computer.",
            action = "Unpair", danger = true, onCancel = { confirm = false },
            onAction = {
                confirm = false
                scope.launch {
                    // Revoke on the daemon first. A daemon out of reach still loses this phone's
                    // keys here, and the pairing screen says the daemon did not confirm.
                    val server = Prefs.server.orEmpty()
                    val r = runCatching { Api.delete("/v1/devices/${Prefs.deviceId}") }
                    val refused = r.exceptionOrNull() as? ApiError
                    act.unpaired(unpaired(r.getOrNull(), refused?.code, refused?.message, server))
                }
            },
        )
    }
}

@Composable
private fun Kv(key: String, value: String, mono: Boolean = false) = Row {
    val k = k()
    Txt(key, T.small, k.muted, Modifier.width(112.dp))
    Txt(value, if (mono) T.code else T.ui, k.fg, Modifier.weight(1f), maxLines = 2)
}
