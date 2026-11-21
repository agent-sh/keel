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
import kotlinx.coroutines.launch

/** Seconds now, ticking once a second while shown: elapsed times stay current. */
@Composable
fun nowTick(): Double {
    var now by remember { mutableDoubleStateOf(System.currentTimeMillis() / 1000.0) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() / 1000.0 } }
    return now
}

/** The connection, in a line: which machine, and whether the stream is live. */
@Composable
fun ConnLine() {
    val k = k()
    val c by Hub.conn.collectAsState()
    val note by Hub.note.collectAsState()
    val name = Prefs.server ?: "Keel"
    val (s, word) = when (c) {
        Conn.LIVE -> State.DONE to "Live"
        Conn.CONNECTING, Conn.OFF -> State.WORKING to "Connecting"
        Conn.RETRYING -> State.STOPPED to "Reconnecting"
        Conn.REVOKED -> State.FAILED to "Unpaired by the daemon"
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics { contentDescription = "conn-$word" }) {
        StateMark(s, 8.dp)
        Spacer(Modifier.width(6.dp))
        Txt("$name · $word", T.meta, if (c == Conn.REVOKED) k.fail else k.muted, maxLines = 1)
        if (c == Conn.RETRYING && note.isNotBlank()) Txt("  $note", T.meta, k.faint, maxLines = 1)
    }
}

data class Row3(val chat: Chat, val state: State, val since: Double?)

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
    fun create() {
        if (creating) return
        creating = true; error = ""
        scope.launch {
            runCatching { Hub.newChat() }.onSuccess { Ui.open(it) }.onFailure { error = it.message ?: "Could not start a session" }
            creating = false
        }
    }
    val now = nowTick()
    val pendingBy = cards.values.filter { it.pending }.groupBy { it.chatId }
    val rows = chats.values.filter { !it.archived }
        .map { Row3(it, stateOf(it, pendingBy[it.id] != null, it.id in working), working[it.id]) }
        // A subagent's session shows under its parent's work; it is listed only when it needs the owner.
        .filter { it.chat.parentId == null || it.state == State.NEEDS }
    val needs = rows.filter { it.state == State.NEEDS }.sortedByDescending { it.chat.updated }
    val work = rows.filter { it.state == State.WORKING }.sortedBy { it.since ?: it.chat.updated }
    val rest = rows.filter { it.state != State.NEEDS && it.state != State.WORKING }.sortedWith(compareByDescending<Row3> { it.chat.pinned }.thenByDescending { it.chat.updated })

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
        LazyColumn(Modifier.fillMaxSize()) {
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
                val line = when {
                    r.state == State.FAILED -> "Failed: ${c.failure.ifBlank { "the last turn did not finish" }}"
                    c.preview.isBlank() -> "No messages yet"
                    c.lastRole == "user" -> "You: ${c.preview}"
                    else -> c.preview
                }
                Txt(line, T.small, if (r.state == State.FAILED) k.fail else k.muted, Modifier.weight(1f), maxLines = 2)
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
