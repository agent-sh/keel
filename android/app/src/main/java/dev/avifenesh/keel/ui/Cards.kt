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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
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
import dev.avifenesh.keel.Attach
import dev.avifenesh.keel.Unsent
import dev.avifenesh.keel.Card
import dev.avifenesh.keel.Seen
import dev.avifenesh.keel.MainActivity
import dev.avifenesh.keel.Prefs
import dev.avifenesh.keel.Question
import dev.avifenesh.keel.State
import dev.avifenesh.keel.ago
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.nextAfterAnswer

private fun closedWords(c: Card): Pair<State, String> = when (c.state) {
    "approved" -> State.DONE to when {
        c.plan -> if (c.choice == "once") "Approved: each change asks" else "Approved: edits run"
        c.question -> "Answered"
        c.choice == "session" -> "Allowed for this session"
        c.choice == "always" -> "Allowed always"
        else -> "Allowed once"
    }
    "denied" -> State.FAILED to if (c.plan) "Sent back to planning" else if (c.question) "Dismissed" else "Denied"
    "expired" -> State.STOPPED to "Closed without an answer"
    else -> State.IDLE to c.state
}

/**
 * Whether every line of a card's text has been on the screen. Each time the box's content is placed
 * (the list moves, the box scrolls, the keyboard opens) the part of it drawn in the window, cut by the
 * box, the list and the window, is added to what was seen; the text is read once those parts cover all
 * of it. A jump (the list sent to its end at a send, a fling) draws nothing between where it left and
 * where it lands, so what it skipped is still owed. Fitting its box is not enough either: in the
 * transcript (a list opened at its end) a card taller than the list shows its last lines and its
 * buttons while its first lines sit above the top.
 */
class Reading {
    var read by mutableStateOf(false)
        private set
    private val seen = Seen()

    /** The box's scrolled content was placed: `c` is its coordinates (the modifier after verticalScroll). */
    fun saw(c: androidx.compose.ui.layout.LayoutCoordinates) {
        if (read || !c.isAttached) return
        val height = c.size.height.toFloat()
        if (height <= 0f) return
        val shown = c.boundsInWindow()
        if (shown.height <= 0f) return
        val y = c.positionInWindow().y
        seen.add(shown.top - y, shown.bottom - y)
        if (seen.covers(height)) read = true
    }
}

/** A card, live while it waits; closed, it says what was decided. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CardView(act: androidx.fragment.app.FragmentActivity, c: Card, title: String? = null, onOpen: (() -> Unit)? = null) {
    val k = k()
    var busy by remember(c.id) { mutableStateOf(false) }
    var error by remember(c.id) { mutableStateOf("") }
    val picks = remember(c.id) { mutableStateMapOf<String, List<String>>() }
    val other = remember(c.id) { mutableStateMapOf<String, String>() }
    // A permission or a plan is allowed only for what was read: every line of its text has been on
    // the screen (Reading). The daemon holds an allow without that word.
    // (Remembered for this text of this card: another text under the same id was not read.)
    val scroll = rememberScrollState()
    val reading = remember(c.id, c.shown) { Reading() }
    val read = reading.read
    // A plan sent back: what to change, written under it.
    var back by remember(c.id) { mutableStateOf(false) }
    var feedback by remember(c.id) { mutableStateOf("") }
    fun act(choice: String, answers: Map<String, Any>?) {
        busy = true; error = ""
        val prompt = if (c.plan && choice != "deny") (if (choice == "once") "Approve the plan: each change asks" else "Approve the plan: edits run") else null
        Approvals.run(act, c.id, choice, answers, seen = read && !c.question, rule = c.grants.joinToString(", "), feedback = feedback.takeIf { c.plan && choice == "deny" }, heading = prompt) { err ->
            busy = false
            if (!err.isNullOrEmpty()) error = err
            // Answered in its session's screen: on to the next session that waits (the Needs you tab lists the rest already),
            // unless the owner has begun a message in its box.
            if (err == null && (Ui.route.value as? Route.Session)?.id == c.chatId) {
                val holds = Unsent.of(c.chatId).isNotEmpty() || Attach.pending.value[c.chatId].orEmpty().isNotEmpty()
                nextAfterAnswer(c, Hub.cards.value.values, Hub.chats.value, holds)?.let { Ui.open(it) }
            }
        }
    }
    Panel(accent = if (c.pending) k.need else null, modifier = Modifier.semantics { contentDescription = "card-${c.id}" }) {
        Column(Modifier.padding(start = 16.dp, end = 14.dp, top = 12.dp, bottom = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (c.pending) StateTag(State.NEEDS, if (c.plan) "plan" else if (c.question) "question" else "permission")
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
            // What the wait costs: why it stands where it does in the list.
            if (c.pending && c.waitLine.isNotBlank()) { Spacer(Modifier.height(4.dp)); Txt(c.waitLine, T.meta, k.muted, maxLines = 2) }
            Spacer(Modifier.height(10.dp))
            if (c.plan) {
                // The plan's title, then the whole plan as the model wrote it, in a box that scrolls.
                Txt(c.command, T.bodyStrong)
                Spacer(Modifier.height(8.dp))
                Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(k.sunken).border(1.dp, k.line, RoundedCornerShape(S.r))
                        .heightIn(max = if (c.pending) 420.dp else 160.dp).verticalScroll(scroll).onGloballyPositioned { reading.saw(it) }.padding(horizontal = 12.dp, vertical = 10.dp)
                        .semantics { contentDescription = "plan-${c.id}" },
                ) { Markdown(c.text.ifBlank { c.command }, T.ui) }
                if (c.pending && !c.mayAllow(read)) { Spacer(Modifier.height(8.dp)); Txt(c.readFirst, T.small, k.muted, Modifier.semantics { contentDescription = "read-first-${c.id}" }) }
            } else if (c.question) Questions(c, picks, other, enabled = c.pending && !busy)
            else {
                if (c.description.isNotBlank()) { Txt(c.description, T.small, k.muted); Spacer(Modifier.height(8.dp)) }
                // Why it is asked, where it runs, what in the text can mislead, that only its start is kept.
                for (n in c.notes) { Txt(n, T.small, k.need, Modifier.semantics { contentDescription = "note-${c.id}" }); Spacer(Modifier.height(6.dp)) }
                // The whole request, drawn left to right in the order it is written. A held one gets more room to read in.
                if (c.shown.isNotBlank()) Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(k.code).border(1.dp, k.line, RoundedCornerShape(S.r))
                        .heightIn(max = if (c.held) 360.dp else 180.dp).verticalScroll(scroll).onGloballyPositioned { reading.saw(it) }.padding(horizontal = 12.dp, vertical = 10.dp)
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
                } else if (c.plan && back) Column(verticalArrangement = Arrangement.spacedBy(S.sm)) {
                    Field(feedback, { feedback = it }, "What should change? (optional)", singleLine = false, tag = "feedback-${c.id}", minLines = 2)
                    Row(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                        Btn(if (busy) "Sending" else "Send back", { act("deny", null) }, Tone.LINE, enabled = !busy, compact = true, tag = "send-back-${c.id}")
                        Btn("Cancel", { back = false }, Tone.QUIET, enabled = !busy, compact = true)
                    }
                } else FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm), verticalArrangement = Arrangement.spacedBy(S.sm)) {
                    // The daemon offers the session choice where it is safe; a phone with no screen lock approves once only.
                    for (a in c.actions.filter { !(Prefs.noLock && (it.choice == "session" || it.choice == "always")) }) {
                        // (A phone with no screen lock approves a plan only into the mode where each change asks.)
                        // (A standing answer's button names the rule it stores.)
                        val label = c.label(a.choice, a.label)
                        // Deny is taken at once; an allow waits for the text to have been read.
                        // Keep planning opens the box for what to change; the rest go at once.
                        Btn(label, { if (c.plan && a.choice == "deny") back = true else act(a.choice, null) },
                            when { c.plan && a.choice == "deny" -> Tone.QUIET; a.style == "primary" -> Tone.INK; a.style == "danger" -> Tone.DANGER; else -> Tone.LINE },
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
            if (q.header.isNotBlank()) { Txt(q.header.uppercase(), T.meta, k.faint); Spacer(Modifier.height(2.dp)) }
            Txt(q.question, T.bodyStrong)
            if (q.multi) Txt("Pick any", T.meta, k.faint)
            Spacer(Modifier.height(8.dp))
            // Choices the model explained are rows, each with what it means under its label; bare labels are chips.
            if (q.details.any { it.isNotBlank() }) Column(verticalArrangement = Arrangement.spacedBy(S.sm)) {
                q.options.forEachIndexed { i, o -> Choice(q, o, picks, enabled, q.detail(i), Modifier.fillMaxWidth()) }
            } else FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm), verticalArrangement = Arrangement.spacedBy(S.sm)) {
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
private fun Choice(q: Question, o: String, picks: MutableMap<String, List<String>>, enabled: Boolean, detail: String = "", modifier: Modifier = Modifier) {
    val k = k()
    val on = o in picks[q.id].orEmpty()
    val shape = RoundedCornerShape(S.r)
    Column(
        modifier.clip(shape).background(if (on) k.needSoft else k.raised).border(1.dp, if (on) k.need else k.lineStrong, shape)
            .press({
                val cur = picks[q.id].orEmpty()
                picks[q.id] = if (q.multi) (if (on) cur - o else cur + o) else (if (on) emptyList() else listOf(o))
            }, enabled).semantics { contentDescription = "option-$o" }.padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Txt(o, T.ui, if (on) k.ownerInk else k.fg)
        if (detail.isNotBlank()) Txt(detail, T.small, k.muted)
    }
}

/** A card the transcript names but the app holds no record of: what the message says. */
fun cardFromMessage(id: String, chat: String, kind: String, command: String, description: String, state: String, ts: Double) =
    Card(id, chat, kind.ifBlank { "permission" }, command, description, emptyList(), state.ifBlank { "expired" }, null, ts, emptyList())

@Composable fun Gap(h: Int) = Spacer(Modifier.height(h.dp).width(1.dp))

/**
 * What a notification's Allow once opens, over the lock screen: the session and the whole line of the
 * request, then Allow once (which asks for the fingerprint) and Close. Nothing is cut here.
 */
@Composable
fun ConfirmSheet(title: String, body: String, onAllow: () -> Unit, onClose: () -> Unit) {
    val k = k()
    Box(Modifier.fillMaxSize().background(k.bg.copy(alpha = 0.92f)).padding(20.dp), contentAlignment = Alignment.Center) {
        Panel(accent = k.need, modifier = Modifier.reading()) {
            Column(Modifier.padding(start = 16.dp, end = 14.dp, top = 14.dp, bottom = 14.dp)) {
                StateTag(State.NEEDS, "permission")
                if (title.isNotBlank()) { Spacer(Modifier.height(8.dp)); Txt(title, T.uiStrong, k.fg) }
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(k.code).border(1.dp, k.line, RoundedCornerShape(S.r))
                        .heightIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp)
                        .semantics { contentDescription = "confirm-request" },
                ) { Txt(body, T.code.copy(textDirection = TextDirection.Ltr), k.fg) }
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                    Btn("Allow once", onAllow, Tone.INK, tag = "confirm-allow")
                    Btn("Close", onClose, Tone.QUIET, tag = "confirm-close")
                }
            }
        }
    }
}
