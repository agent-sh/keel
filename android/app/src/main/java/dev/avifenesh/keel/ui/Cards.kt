// Cards that need the owner: a tool call to allow or deny, a question to answer.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Approvals
import dev.avifenesh.keel.Card
import dev.avifenesh.keel.MainActivity
import dev.avifenesh.keel.Prefs
import dev.avifenesh.keel.Question
import dev.avifenesh.keel.State
import dev.avifenesh.keel.ago

private fun closedWords(c: Card): Pair<State, String> = when (c.state) {
    "approved" -> State.DONE to when {
        c.question -> "Answered"
        c.choice == "session" -> "Allowed for this session"
        c.choice == "always" -> "Allowed always"
        else -> "Allowed once"
    }
    "denied" -> State.FAILED to if (c.question) "Dismissed" else "Denied"
    "expired" -> State.STOPPED to "Closed without an answer"
    else -> State.IDLE to c.state
}

/** A card, live while it waits; closed, it says what was decided. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CardView(act: MainActivity, c: Card, title: String? = null, onOpen: (() -> Unit)? = null) {
    val k = k()
    var busy by remember(c.id) { mutableStateOf(false) }
    var error by remember(c.id) { mutableStateOf("") }
    val picks = remember(c.id) { mutableStateMapOf<String, List<String>>() }
    val other = remember(c.id) { mutableStateMapOf<String, String>() }
    // A permission is allowed only for what was read: every line of its text has been on screen
    // (it fits its box, or the owner scrolled to its end). The daemon holds an allow without that word.
    val scroll = rememberScrollState()
    var read by remember(c.id) { mutableStateOf(false) }
    LaunchedEffect(c.id) { snapshotFlow { scroll.maxValue != Int.MAX_VALUE && scroll.value >= scroll.maxValue }.collect { if (it) read = true } }
    fun act(choice: String, answers: Map<String, Any>?) {
        busy = true; error = ""
        Approvals.run(act, c.id, choice, c.command.ifBlank { c.description }, answers, seen = read && !c.question) { err ->
            busy = false
            if (!err.isNullOrEmpty()) error = err
        }
    }
    Panel(accent = if (c.pending) k.need else null, modifier = Modifier.semantics { contentDescription = "card-${c.id}" }) {
        Column(Modifier.padding(start = 16.dp, end = 14.dp, top = 12.dp, bottom = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (c.pending) StateTag(State.NEEDS, if (c.question) "question" else "permission")
                else closedWords(c).let { (s, w) -> StateTag(s, w, only = true) }
                Spacer(Modifier.weight(1f))
                if (c.ts > 0) Txt(ago(c.ts), T.meta, k.faint)
            }
            // Where a closed permission was answered, when the daemon says: "from the phone (Pixel 8)".
            if (!c.pending && !c.question && c.from.isNotBlank()) { Spacer(Modifier.height(4.dp)); Txt("Answered from ${c.from}", T.meta, k.faint) }
            if (title != null) {
                Spacer(Modifier.height(6.dp))
                Txt(title, T.uiStrong, k.fg, if (onOpen != null) Modifier.press(onOpen) else Modifier, maxLines = 1)
            }
            Spacer(Modifier.height(10.dp))
            if (c.question) Questions(c, picks, other, enabled = c.pending && !busy)
            else {
                if (c.description.isNotBlank()) { Txt(c.description, T.small, k.muted); Spacer(Modifier.height(8.dp)) }
                // Why it is asked, where it runs, what in the text can mislead, that only its start is kept.
                for (n in c.notes) { Txt(n, T.small, k.need, Modifier.semantics { contentDescription = "note-${c.id}" }); Spacer(Modifier.height(6.dp)) }
                // The whole request, drawn left to right in the order it is written. A held one gets more room to read in.
                if (c.shown.isNotBlank()) Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(k.code).border(1.dp, k.line, RoundedCornerShape(S.r))
                        .heightIn(max = if (c.held) 360.dp else 180.dp).verticalScroll(scroll).padding(horizontal = 12.dp, vertical = 10.dp)
                        .semantics { contentDescription = "request-${c.id}" },
                ) { Txt(c.shown, T.code.copy(textDirection = TextDirection.Ltr), k.fg) }
                if (c.pending && !c.mayAllow(read)) { Spacer(Modifier.height(8.dp)); Txt(c.readFirst, T.small, k.muted, Modifier.semantics { contentDescription = "read-first-${c.id}" }) }
            }
            if (c.pending) {
                Spacer(Modifier.height(14.dp))
                if (c.question) {
                    val answers = c.questions.associate { q ->
                        q.id to ((picks[q.id].orEmpty()) + listOfNotNull(other[q.id]?.trim()?.takeIf { it.isNotEmpty() }))
                    }
                    val ready = c.questions.isNotEmpty() && answers.values.all { it.isNotEmpty() }
                    Row(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                        Btn(if (busy) "Sending" else "Answer", {
                            act("once", answers.mapValues { (id, v) -> if (c.questions.first { it.id == id }.multi) v else v.first() })
                        }, Tone.NEED, enabled = ready && !busy, tag = "answer-${c.id}")
                        Btn("Dismiss", { act("deny", null) }, Tone.QUIET, enabled = !busy, tag = "dismiss-${c.id}")
                    }
                } else FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm), verticalArrangement = Arrangement.spacedBy(S.sm)) {
                    // The daemon offers the session choice where it is safe; a phone with no screen lock approves once only.
                    for (a in c.actions.filter { !(Prefs.noLock && (it.choice == "session" || it.choice == "always")) }) {
                        val label = when (a.choice) { "once" -> "Allow once"; "session" -> "Allow for session"; "deny" -> "Deny"; else -> a.label }
                        // Deny is taken at once; an allow waits for the text to have been read.
                        Btn(label, { act(a.choice, null) }, when (a.style) { "primary" -> Tone.INK; "danger" -> Tone.DANGER; else -> Tone.LINE },
                            enabled = !busy && (a.choice == "deny" || c.mayAllow(read)), compact = true, tag = "${a.choice}-${c.id}")
                    }
                }
            }
            if (error.isNotBlank()) { Spacer(Modifier.height(10.dp)); Notice(error) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Questions(c: Card, picks: MutableMap<String, List<String>>, other: MutableMap<String, String>, enabled: Boolean) {
    val k = k()
    if (c.questions.isEmpty()) { Txt(c.command, T.body); return }
    // Closed: the question and what was answered, no choices.
    if (!c.pending) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (q in c.questions) Column {
                Txt(q.question, T.bodyStrong)
                val a = c.answers[q.id].orEmpty()
                if (a.isNotEmpty()) { Spacer(Modifier.height(4.dp)); Txt(a.joinToString(", "), T.ui, k.ownerInk) }
            }
        }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        for (q in c.questions) Column {
            Txt(q.question, T.bodyStrong)
            if (q.multi) Txt("Pick any", T.meta, k.faint)
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm), verticalArrangement = Arrangement.spacedBy(S.sm)) {
                for (o in q.options) Choice(q, o, picks, enabled)
            }
            if (c.pending) {
                Spacer(Modifier.height(8.dp))
                Field(other[q.id].orEmpty(), { other[q.id] = it }, "Or write an answer", tag = "other-${q.id}")
            }
        }
    }
}

@Composable
private fun Choice(q: Question, o: String, picks: MutableMap<String, List<String>>, enabled: Boolean) {
    val k = k()
    val on = o in picks[q.id].orEmpty()
    val shape = RoundedCornerShape(S.r)
    Box(
        Modifier.clip(shape).background(if (on) k.needSoft else k.raised).border(1.dp, if (on) k.need else k.lineStrong, shape)
            .press({
                val cur = picks[q.id].orEmpty()
                picks[q.id] = if (q.multi) (if (on) cur - o else cur + o) else (if (on) emptyList() else listOf(o))
            }, enabled).semantics { contentDescription = "option-$o" }.padding(horizontal = 12.dp, vertical = 8.dp),
    ) { Txt(o, T.ui, if (on) k.ownerInk else k.fg) }
}

/** A card the transcript names but the app holds no record of: what the message says. */
fun cardFromMessage(id: String, chat: String, kind: String, command: String, description: String, state: String, ts: Double) =
    Card(id, chat, kind.ifBlank { "permission" }, command, description, emptyList(), state.ifBlank { "expired" }, null, ts, emptyList())

@Composable fun Gap(h: Int) = Spacer(Modifier.height(h.dp).width(1.dp))
