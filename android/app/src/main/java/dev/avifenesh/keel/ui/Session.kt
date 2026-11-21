// One session: its transcript with the cards in place, and the composer that
// sends while idle, steers or queues while a turn runs, and stops it.
package dev.avifenesh.keel.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.MainActivity
import dev.avifenesh.keel.Msg
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.Wire
import dev.avifenesh.keel.elapsed
import dev.avifenesh.keel.stateOf
import dev.avifenesh.keel.str
import kotlinx.coroutines.launch

@Composable
fun SessionScreen(act: MainActivity, id: String) {
    val k = k()
    val chats by Hub.chats.collectAsState()
    val all by Hub.msgs.collectAsState()
    val cards by Hub.cards.collectAsState()
    val working by Hub.working.collectAsState()
    val drafts by Hub.drafts.collectAsState()
    val older by Hub.older.collectAsState()
    val scope = rememberCoroutineScope()
    var error by remember(id) { mutableStateOf("") }
    var usage by remember(id) { mutableStateOf<String?>(null) }
    val chat = chats[id]
    val msgs = all[id].orEmpty()
    val pending = cards.values.any { it.chatId == id && it.pending }
    val isWorking = id in working
    val state = chat?.let { stateOf(it, pending, isWorking) } ?: State.IDLE
    val now = nowTick()
    val draft = drafts[id].orEmpty()

    LaunchedEffect(id) { runCatching { Hub.open(id) }.onFailure { error = it.message ?: "Could not load the session" } }
    // Read as it arrives while open.
    LaunchedEffect(id, msgs.size) { if (msgs.isNotEmpty()) runCatching { dev.avifenesh.keel.Api.post("/v1/chats/$id/read") } }

    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Head(chat?.title ?: "Session", sub = {
            StateTag(state, when (state) { State.WORKING -> working[id]?.let { elapsed(it, now) }.orEmpty(); else -> "" })
        }, lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = Route.Tabs(0) }) }) {
            IconBtn(Ic.ChartColumn, "Session usage", {
                if (usage != null) usage = null
                else scope.launch { usage = runCatching { usageLine(Hub.usage(id)) }.getOrElse { "Usage not available: ${it.message}" } }
            }, tint = if (usage != null) k.fg else k.muted)
        }
        Rule()
        usage?.let { Txt(it, T.meta, k.muted, Modifier.fillMaxWidth().background(k.panel).padding(horizontal = S.lg, vertical = 8.dp)) }
        if (error.isNotBlank()) Notice(error, modifier = Modifier.padding(S.md))
        val list = rememberLazyListState()
        val items = msgs.filter { it.kind != "deleted" }
        // Newest at the bottom: the list runs reversed, so a new message keeps the view at the end.
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = S.md)) {
            if (isWorking || draft.isNotBlank()) item(key = "live") {
                Column(Modifier.padding(horizontal = S.lg, vertical = 6.dp)) {
                    if (draft.isNotBlank()) Markdown(draft)
                    Spacer(Modifier.height(6.dp))
                    if (isWorking && !pending) StateTag(State.WORKING, working[id]?.let { elapsed(it, now) }.orEmpty())
                }
            }
            items(items.asReversed(), key = { it.id }) { m -> MsgView(act, m, cards[m.approvalId]) }
            if (older[id] != null) item(key = "older") {
                Box(Modifier.fillMaxWidth().padding(S.md), contentAlignment = Alignment.Center) {
                    Btn("Earlier messages", { scope.launch { runCatching { Hub.loadOlder(id) } } }, Tone.LINE, compact = true)
                }
            }
            if (items.isEmpty() && !isWorking) item(key = "empty") { Empty("Nothing here yet", "Write the first message below. The session runs on the computer.") }
        }
        Composer(id, isWorking, chat?.archived == true) { error = it }
    }
}

private fun usageLine(o: org.json.JSONObject): String {
    val s = o.optJSONObject("session") ?: return "No usage yet"
    fun n(v: Long) = if (v >= 1_000_000) "%.1fM".format(v / 1e6) else if (v >= 1000) "%.1fk".format(v / 1e3) else "$v"
    val cost = if (s.isNull("cost")) "not priced" else "$%.4f".format(s.optDouble("cost"))
    return "${s.str("model")} · in ${n(s.optLong("prompt_tokens"))} · out ${n(s.optLong("output_tokens"))} · cached ${n(s.optLong("cache_read_tokens"))} · $cost"
}

@Composable
private fun MsgView(act: MainActivity, m: Msg, card: dev.avifenesh.keel.Card?) {
    val k = k()
    when {
        m.kind == "approval" -> Box(Modifier.padding(horizontal = S.md, vertical = 6.dp)) {
            CardView(act, card ?: cardFromMessage(m.approvalId ?: m.id, m.chatId, m.cardKind, m.cardCommand, m.content, m.cardState, m.ts))
        }
        m.kind == "trace" -> Trace(m)
        m.kind == "status" -> Row(Modifier.fillMaxWidth().padding(horizontal = S.lg, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            val s = when { m.outcome == "error" || m.content.startsWith("Failed") -> State.FAILED; m.outcome.isNotBlank() -> State.STOPPED; else -> State.IDLE }
            StateMark(s, 8.dp)
            Spacer(Modifier.width(8.dp))
            Txt(m.content, T.meta, if (s == State.FAILED) k.fail else k.muted, maxLines = 4)
        }
        m.mine -> Row(Modifier.fillMaxWidth().padding(start = 56.dp, end = S.md, top = 8.dp, bottom = 8.dp), horizontalArrangement = Arrangement.End) {
            Column(horizontalAlignment = Alignment.End) {
                if (m.kind == "queued" || m.kind == "steer") Txt(if (m.kind == "queued") "QUEUED" else "STEER", T.label, k.work, Modifier.padding(bottom = 4.dp))
                val shape = RoundedCornerShape(topStart = S.rLg, topEnd = S.rLg, bottomStart = S.rLg, bottomEnd = 2.dp)
                Box(Modifier.clip(shape).background(k.inkSoft).padding(horizontal = 14.dp, vertical = 10.dp).semantics { contentDescription = "mine-${m.content.take(40)}" }) {
                    Txt(m.content, T.body, k.fg)
                }
            }
        }
        else -> Column(Modifier.fillMaxWidth().padding(horizontal = S.lg, vertical = 8.dp).semantics { contentDescription = "agent-${m.content.take(40)}" }) {
            if (m.origin.isNotBlank() && m.origin != "agent") Txt(m.origin.uppercase(), T.label, k.faint, Modifier.padding(bottom = 4.dp))
            Markdown(m.content)
            if (m.model.isNotBlank()) Txt(m.model.substringAfterLast('/').substringAfter(':'), T.meta, k.faint, Modifier.padding(top = 6.dp))
        }
    }
}

/** The tool calls of one reply, folded into one line; open, one row each. */
@Composable
private fun Trace(m: Msg) {
    val k = k()
    var open by rememberSaveable(m.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = S.md, vertical = 2.dp).clip(RoundedCornerShape(S.r)).press({ open = !open }).animateContentSize().padding(horizontal = 4.dp, vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            KIcon(if (open) Ic.ChevronDown else Ic.ChevronRight, k.faint, 16.dp)
            Spacer(Modifier.width(6.dp))
            val tools = m.steps.map { it.tool }.distinct()
            Txt("${tools.joinToString(", ")}  ·  ${m.steps.size} step${if (m.steps.size == 1) "" else "s"}", T.meta, k.muted, maxLines = 1)
        }
        if (open) Column(Modifier.padding(start = 22.dp, top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            for (s in m.steps) Row {
                Txt(s.tool, T.code.copy(fontSize = T.meta.fontSize), k.fg)
                Spacer(Modifier.width(8.dp))
                Txt(s.what, T.code.copy(fontSize = T.meta.fontSize), k.muted, maxLines = 3)
            }
        }
    }
}

@Composable
private fun Composer(id: String, working: Boolean, archived: Boolean, onError: (String) -> Unit) {
    val k = k()
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(id) { mutableStateOf("") }
    var mode by rememberSaveable(id) { mutableStateOf("steer") }
    var busy by remember { mutableStateOf(false) }
    // The send in hand: its id stays with the words until the daemon answers,
    // so sending them again after a lost answer makes no second prompt.
    var keptId by rememberSaveable(id) { mutableStateOf("") }
    var keptText by rememberSaveable(id) { mutableStateOf("") }
    fun send() {
        val t = text.trim(); if (t.isEmpty()) return
        val cid = Wire.sendId(keptId, keptText, t)
        keptId = cid; keptText = t
        busy = true
        scope.launch {
            runCatching { Hub.send(id, t, if (working) mode else "send", cid) }
                .onSuccess { text = ""; keptId = ""; keptText = ""; onError("") }.onFailure { onError(it.message ?: "Not sent") }
            busy = false
        }
    }
    fun stop() { scope.launch { runCatching { Hub.stopTurn(id) }.onFailure { onError(it.message ?: "Could not stop") } } }
    Column(Modifier.fillMaxWidth().background(k.panel).navigationBarsPadding()) {
        Rule()
        if (archived) { Txt("This session is archived. Unarchive it on the computer to write here.", T.small, k.muted, Modifier.padding(S.lg)); return }
        if (working) Row(Modifier.padding(start = S.md, end = S.md, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Segmented(listOf("steer" to "Steer", "queue" to "Queue"), mode) { mode = it }
            Spacer(Modifier.width(S.md))
            Txt(if (mode == "steer") "Joins the running turn" else "Runs after this turn", T.meta, k.faint, maxLines = 1)
        }
        Row(Modifier.fillMaxWidth().padding(S.md), verticalAlignment = Alignment.Bottom) {
            val shape = RoundedCornerShape(S.rLg)
            Box(Modifier.weight(1f).clip(shape).background(k.raised).border(1.dp, k.line, shape).padding(horizontal = 14.dp, vertical = 11.dp)) {
                if (text.isEmpty()) Txt(if (working) (if (mode == "steer") "Steer the running turn" else "Queue the next message") else "Message Keel", T.body, k.faint, maxLines = 1)
                BasicTextField(text, { text = it }, Modifier.fillMaxWidth().semantics { contentDescription = "composer" }, textStyle = T.body.copy(color = k.fg),
                    maxLines = 6, cursorBrush = SolidColor(k.fg))
            }
            Spacer(Modifier.width(S.sm))
            val stopNow = working && text.isBlank()
            Box(
                Modifier.size(46.dp).clip(RoundedCornerShape(S.rPill)).background(if (stopNow) k.dangerSoft else if (text.isBlank() || busy) k.inkSoft else k.ink)
                    .press({ if (stopNow) stop() else send() }, enabled = stopNow || (text.isNotBlank() && !busy))
                    .semantics { contentDescription = if (stopNow) "stop" else "send" },
                contentAlignment = Alignment.Center,
            ) {
                if (stopNow) Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(k.danger))
                else KIcon(Ic.ArrowUp, if (text.isBlank() || busy) k.faint else k.inkFg, 22.dp)
            }
        }
    }
}

@Composable
fun Segmented(options: List<Pair<String, String>>, value: String, onPick: (String) -> Unit) {
    val k = k()
    val shape = RoundedCornerShape(S.r)
    Row(Modifier.clip(shape).background(k.sunken).border(1.dp, k.line, shape).padding(2.dp)) {
        for ((v, label) in options) {
            val on = v == value
            Box(Modifier.clip(RoundedCornerShape(S.r - 1.dp)).background(if (on) k.raised else androidx.compose.ui.graphics.Color.Transparent)
                .press({ onPick(v) }).semantics { contentDescription = "mode-$v" }.padding(horizontal = 12.dp, vertical = 5.dp)) {
                Txt(label, T.label, if (on) k.fg else k.muted)
            }
        }
    }
}
