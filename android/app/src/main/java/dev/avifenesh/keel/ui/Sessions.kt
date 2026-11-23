package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Chat
import dev.avifenesh.keel.Conn
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.Prefs
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.ago
import dev.avifenesh.keel.elapsed
import dev.avifenesh.keel.stateOf
import kotlinx.coroutines.delay
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch

/** Seconds now, ticking once a second while shown: elapsed times stay current. */
@Composable
fun nowTick(): Double {
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis() / 1000.0) }
    // Only while the app is on the screen: a clock that ticks in the back keeps the phone's main
    // thread awake once a second for nothing (0.5% of a core, measured over an hour in the back).
    val life = androidx.compose.ui.platform.LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(life) {
        life.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            while (true) { now = System.currentTimeMillis() / 1000.0; delay(1000) }
        }
    }
    return now
}

/** The connection, in a line: which machine, and whether the stream is live. */
@Composable
fun ConnLine() {
    val k = k()
    val c by Hub.conn.collectAsState()
    val note by Hub.note.collectAsState()
    val level by Hub.levelAt.collectAsState()
    val name = Prefs.server ?: "Keel"
    // Not live: a try failed (note) is offline, else it is still connecting. What it shows meanwhile is the
    // last sync, and when it was.
    val (s, word) = when {
        c == Conn.LIVE -> State.DONE to "Live"
        c == Conn.REVOKED -> State.FAILED to "Unpaired by the daemon"
        note.isNotBlank() && c == Conn.RETRYING -> State.STOPPED to "Offline"
        else -> State.WORKING to "Connecting"
    }
    val since = if (c != Conn.LIVE && c != Conn.REVOKED && level > 0) " · last synced ${dev.avifenesh.keel.syncedAt(level)}" else ""
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics { contentDescription = "conn-$word" }) {
        StateMark(s, 8.dp)
        Spacer(Modifier.width(6.dp))
        Txt("$name · $word$since", T.meta, if (c == Conn.REVOKED) k.fail else k.muted, maxLines = 1)
        // Why, when it is more than being out of reach (which "Offline" says).
        if (c == Conn.RETRYING && note.isNotBlank() && note != dev.avifenesh.keel.OUT_OF_REACH) Txt("  $note", T.meta, k.faint, maxLines = 1)
    }
}

/** `ask`: what it waits on the owner for, in a line (askLine); empty when nothing waits. */
data class Row3(val chat: Chat, val state: State, val since: Double?, val ask: String = "")

@Composable
fun SessionsScreen() {
    val k = k()
    val chats by Hub.chats.collectAsState()
    val cards by Hub.cards.collectAsState()
    val working by Hub.working.collectAsState()
    val synced by Hub.synced.collectAsState()
    val scope = rememberCoroutineScope()
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    // Both "New session" buttons start one here: a second tap while the first is on its way starts nothing,
    // and a refusal shows under the header and gives both buttons back.
    // Both "New session" buttons open the start sheet: what to do, where, on which model.
    fun create() { error = ""; Ui.starting.value = true }
    val now = nowTick()
    val rows = sessionRows(chats, cards, working)
    // What happened while the owner was away (read by the Hub each time the phone is level again).
    val away by Hub.away.collectAsState()

    Column(Modifier.fillMaxSize()) {
        Head("Sessions", sub = { ConnLine() }) {
            IconBtn(Ic.Plus, "New session", { create() }, enabled = !creating)
        }
        if (error.isNotBlank()) Notice(error, modifier = Modifier.padding(horizontal = S.lg, vertical = S.sm))
        if (synced && rows.isEmpty()) {
            Empty("No sessions yet", "Start one here or on the computer. It shows up on both.") {
                Btn(if (creating) "Starting" else "New session", { create() }, icon = Ic.Plus, enabled = !creating, tag = "New session")
            }
            return
        }
        if (!synced) { Empty("Reaching the daemon", "Sessions appear as soon as the first sync arrives."); return }
        SessionList(rows, now, away = away, onSeen = { Hub.seenAway() })
    }
}

/** The rows the list shows: every session not archived with its state, an agent's only while it needs the owner. */
fun sessionRows(chats: Map<String, Chat>, cards: Map<String, dev.avifenesh.keel.Card>, working: Map<String, Double>): List<Row3> {
    val pendingBy = cards.values.filter { it.pending }.groupBy { it.chatId }
    return chats.values.filter { !it.archived }
        .map { Row3(it, stateOf(it, pendingBy[it.id] != null, it.id in working), working[it.id], dev.avifenesh.keel.askLine(it.id, cards.values, chats)) }
        // An agent's session shows under the session that started it; it is listed only while a card of its
        // own waits (the agents between it and the root wait on it, not on the owner: their root says so).
        .filter { it.chat.parentId == null || pendingBy[it.chat.id] != null }
}

/** The list: what needs the owner first, then what works, then the rest, pinned first. */
@Composable
fun SessionList(rows: List<Row3>, now: Double, away: dev.avifenesh.keel.Away? = null, onSeen: () -> Unit = {}) {
    val k = k()
    val needs = rows.filter { it.state == State.NEEDS }.sortedByDescending { it.chat.updated }
    val work = rows.filter { it.state == State.WORKING }.sortedBy { it.since ?: it.chat.updated }
    val rest = rows.filter { it.state != State.NEEDS && it.state != State.WORKING }.sortedWith(compareByDescending<Row3> { it.chat.pinned }.thenByDescending { it.chat.updated })
    // The digest arrives after the list: a list keeps its place by the row it shows, which would leave the
    // digest above the screen. At the top, it comes into view.
    val state = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(away?.span) { if (away != null && state.firstVisibleItemIndex <= 1) state.scrollToItem(0) }
    LazyColumn(Modifier.fillMaxSize(), state = state) {
        if (away != null) item(key = "away") { AwayCard(away, onOpen = { Ui.open(it) }, onSeen = onSeen) }
        fun section(label: String, list: List<Row3>, color: androidx.compose.ui.graphics.Color) {
            if (list.isEmpty()) return
            item(key = "h-$label") { SectionLabel(label, list.size, color, Modifier.padding(top = S.sm)) }
            items(list, key = { it.chat.id }) { r -> SessionRow(r, now) }
        }
        section("Needs you", needs, k.need)
        section("Working", work, k.work)
        section("Recent", rest, k.muted)
        item { Spacer(Modifier.height(S.xl)) }
    }
}

@Composable
private fun SessionRow(r: Row3, now: Double) {
    val k = k()
    val c = r.chat
    Row(
        Modifier.fillMaxWidth().press({ Ui.open(c.id) }).semantics { contentDescription = "session-${c.title}" }.padding(horizontal = S.lg, vertical = 12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.padding(top = 6.dp, end = 12.dp)) { StateMark(r.state, 10.dp) }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Txt(c.title, T.uiStrong.copy(fontSize = T.body.fontSize * 0.95f), k.fg, Modifier.weight(1f), maxLines = 1)
                Spacer(Modifier.width(S.sm))
                val right = when (r.state) {
                    State.WORKING -> r.since?.let { elapsed(it, now) } ?: "working"
                    else -> ago(c.updated, now)
                }
                Txt(right, T.meta, when (r.state) { State.WORKING -> k.work; State.NEEDS -> k.need; else -> k.faint }, maxLines = 1)
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                // What it asks, when it waits on the owner: the reason it is at the top of the list.
                val asks = r.state == State.NEEDS && r.ask.isNotBlank()
                val line = when {
                    asks -> r.ask
                    r.state == State.FAILED -> "Failed: ${c.failure.ifBlank { "the last turn did not finish" }}"
                    c.preview.isBlank() -> "No messages yet"
                    c.lastRole == "user" -> "You: ${c.preview}"
                    else -> c.preview
                }
                Txt(line, T.small, when { asks -> k.ownerInk; r.state == State.FAILED -> k.fail; else -> k.muted }, Modifier.weight(1f).semantics { contentDescription = "line-of-${c.title}" }, maxLines = 2)
                // Agents at work under it, at any depth: the session is busy even between its own turns.
                if (c.agents > 0) {
                    Spacer(Modifier.width(S.sm))
                    Txt("${c.agents} agent${if (c.agents == 1) "" else "s"}", T.meta, k.work, maxLines = 1, modifier = Modifier.semantics { contentDescription = "agents-of-${c.title}" })
                }
                if (c.unread > 0) {
                    Spacer(Modifier.width(S.sm))
                    Box(Modifier.clip(RoundedCornerShape(S.rPill)).background(k.ink).padding(horizontal = 7.dp, vertical = 1.dp)) { Txt("${c.unread}", T.label, k.inkFg) }
                }
                if (c.pinned) { Spacer(Modifier.width(S.sm)); Box(Modifier.size(6.dp).clip(RoundedCornerShape(1.dp)).background(k.lineStrong)) }
            }
        }
    }
    Rule(Modifier.padding(start = 38.dp))
}
