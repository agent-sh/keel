// The owner's helper on the phone (GET /v1/helper): turned on and off, what it was told lately,
// its conversation (a chat of the list, pinned above the sessions), and its memory, seen, found by
// words and pruned. The page has the same: its helper panel.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.ApiError
import dev.avifenesh.keel.HelperView
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.MemoryList
import dev.avifenesh.keel.MemoryRecord
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.ago
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What the helper was told, at most this many on the settings panel; the conversation has the rest. */
private const val LATELY = 4

/** The helper's panel in Settings. Nothing shows on a daemon that runs no helper. */
@Composable
fun HelperPanel() {
    val k = k()
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf<HelperView?>(null) }
    var none by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        runCatching { Hub.helper() }.onSuccess { view = it }
            .onFailure { if ((it as? ApiError)?.code == 409) none = true else error = dev.avifenesh.keel.reach(it) }
    }
    if (none) return
    val v = view
    Panel {
        Column(Modifier.padding(S.lg).semantics { contentDescription = "helper-panel" }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Txt("HELPER", T.label, k.muted)
            if (v == null) { if (error.isNotBlank()) Notice(error) else Txt("Reading the helper.", T.small, k.muted); return@Column }
            Row(verticalAlignment = Alignment.CenterVertically) {
                StateMark(if (v.on) State.DONE else State.STOPPED, 9.dp); Spacer(Modifier.width(8.dp))
                Txt(if (v.on) "The helper is on" else "The helper is off", T.uiStrong)
            }
            Txt(
                if (v.on) "It follows your sessions, checks your mail and keeps what is worth remembering. Its conversation is first in Sessions."
                else "One conversation that never ends: it follows your sessions, checks your mail and keeps what is worth remembering.",
                T.small, k.muted,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                fun set(on: Boolean) {
                    busy = true; error = ""
                    scope.launch {
                        runCatching { Hub.setHelper(on) }.onSuccess { view = it; if (on) it.chatId?.let(Ui::open) }.onFailure { error = dev.avifenesh.keel.reach(it) }
                        busy = false
                    }
                }
                if (v.on && v.chatId != null) Btn("Open", { Ui.open(v.chatId) }, compact = true, tag = "helper-open")
                if (v.on) Btn(if (busy) "Turning off" else "Turn off", { set(false) }, Tone.QUIET, compact = true, enabled = !busy, tag = "helper-off")
                else Btn(if (busy) "Turning on" else "Turn on", { set(true) }, compact = true, enabled = !busy, tag = "helper-on")
                Btn("Memory · ${v.memory}", { Ui.route.value = Route.Memory }, Tone.LINE, compact = true, tag = "helper-memory")
            }
            if (error.isNotBlank()) Notice(error)
            if (v.events.isNotEmpty()) {
                Spacer(Modifier.height(2.dp))
                Txt("LATELY", T.label, k.faint)
                val now = nowTick()
                for (e in v.events.take(LATELY)) Row(
                    Modifier.fillMaxWidth().press({ e.chatId?.let(Ui::open) }, enabled = e.chatId != null).semantics { contentDescription = "helper-event-${e.title}" },
                    verticalAlignment = Alignment.Top,
                ) {
                    Txt(if (e.body.isBlank()) e.title else "${e.title}: ${e.body}", T.small, k.fg, Modifier.weight(1f), maxLines = 2)
                    Spacer(Modifier.width(S.sm))
                    Txt(ago(e.ts, now), T.meta, k.faint, maxLines = 1)
                }
            }
        }
    }
}

/** The helper's memory: every record, or those the words find, each one forgotten on its own. */
@Composable
fun MemoryScreen(list: suspend (String) -> MemoryList = { Hub.memory(it) }, forget: suspend (String) -> Unit = { Hub.forget(it) }) {
    val k = k()
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var shown by remember { mutableStateOf<MemoryList?>(null) }
    var error by remember { mutableStateOf("") }
    // What became of the last forget when it did not go as asked; the list is read again either way.
    var note by remember { mutableStateOf("") }
    var noteBad by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<MemoryRecord?>(null) }
    var round by remember { mutableStateOf(0) }
    LaunchedEffect(q, round) {
        if (q.isNotBlank()) delay(300)
        runCatching { list(q.trim()) }.onSuccess { shown = it; error = "" }.onFailure { error = dev.avifenesh.keel.reach(it) }
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Head("Memory", lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = Route.Tabs(3) }) })
            Box(Modifier.padding(horizontal = S.md, vertical = S.sm)) { Field(q, { q = it }, "Find by key, name, topic or words", tag = "memory-q") }
            Rule()
            if (note.isNotBlank()) Notice(note, if (noteBad) k.danger else k.muted, Modifier.padding(S.md))
            val m = shown
            when {
                error.isNotBlank() -> Notice(error, modifier = Modifier.padding(S.md))
                m == null -> Empty("Reading the memory", "")
                m.items.isEmpty() -> Empty(if (q.isBlank()) "Nothing kept yet" else "No record matches", if (q.isBlank()) "The helper keeps your preferences, decisions, people and commitments here as it learns them." else "Try a key, a name it is known by, or a topic.")
                else -> LazyColumn(Modifier.fillMaxSize()) {
                    item { Txt(if (q.isBlank()) "${m.total} records" else "${m.total} found", T.meta, k.faint, Modifier.padding(horizontal = S.lg, vertical = S.sm)) }
                    items(m.items, key = { it.key }) { r -> RecordRow(r) { asking = r }; Rule(Modifier.padding(start = S.lg)) }
                }
            }
        }
        asking?.let { r ->
            Dialog(
                title = "Forget this?", body = "${r.key}: ${r.value}\n\nThe helper will not know it any more. It can learn it again.",
                action = "Forget", danger = true, onCancel = { asking = null },
                onAction = {
                    asking = null
                    note = ""
                    scope.launch {
                        runCatching { forget(r.key) }.onFailure {
                            noteBad = !(it is dev.avifenesh.keel.ApiError && it.code == 404)
                            note = if (it is dev.avifenesh.keel.ApiError && it.code == 404) "${r.key}: it was forgotten already." else "${r.key} was not forgotten: ${dev.avifenesh.keel.reach(it)}"
                        }
                        round++
                    }
                },
            )
        }
    }
}

@Composable
private fun RecordRow(r: MemoryRecord, onForget: () -> Unit) {
    val k = k()
    Row(Modifier.fillMaxWidth().padding(start = S.lg, end = 4.dp, top = 10.dp, bottom = 10.dp).semantics { contentDescription = "memory-${r.key}" }, verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Txt(r.key, T.code.copy(fontSize = T.meta.fontSize), k.ownerInk, maxLines = 1)
            Spacer(Modifier.height(2.dp))
            Txt(r.value, T.ui, k.fg)
            if (r.topics.isNotEmpty()) { Spacer(Modifier.height(4.dp)); Txt(r.topics.joinToString("  ") { "#$it" }, T.meta, k.muted, maxLines = 1) }
        }
        IconBtn(Ic.Trash, "Forget ${r.key}", onForget, tint = k.muted)
    }
}
