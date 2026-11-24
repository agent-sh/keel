// A branch that waits to land, as one card of the work board's facts: the checks on its head, the review's
// verdict, the proof line of its agent's report, its size by area, and what of the evidence is missing. The
// owner lands it (the landing queue; the approval key signs the card's print) or sends it back to its agent with
// words. The diff is a tap away (the agent's changes), never in the way.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.LandCard
import dev.avifenesh.keel.Landings
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.reach
import kotlinx.coroutines.launch

/** One fact of the card: its name in the label's type, its value, words of someone's under it, and a mark of whether it holds. */
@Composable
private fun Fact(name: String, value: String, ok: Boolean?, tag: String, quote: String = "") {
    val k = k()
    Row(verticalAlignment = Alignment.Top, modifier = Modifier.semantics { contentDescription = tag }) {
        Box(Modifier.padding(top = 6.dp).size(7.dp).clip(RoundedCornerShape(2.dp)).background(when (ok) { true -> k.done; false -> k.fail; null -> k.lineStrong }))
        Spacer(Modifier.width(10.dp))
        Column {
            Txt(name.uppercase(), T.label, k.faint)
            Txt(value, T.small, k.fg)
            if (quote.isNotBlank()) Txt("\u201c$quote\u201d", T.small, k.muted, Modifier.padding(top = 2.dp))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LandingCardView(act: androidx.fragment.app.FragmentActivity, c: LandCard) {
    val k = k()
    var busy by remember(c.fp) { mutableStateOf(false) }
    var note by remember(c.key) { mutableStateOf("") }
    var back by remember(c.key) { mutableStateOf(false) }
    var words by remember(c.key) { mutableStateOf("") }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    fun said(o: dev.avifenesh.keel.LandOutcome?, err: String?) {
        busy = false
        when {
            o == null && err.isNullOrEmpty() -> {} // the owner cancelled the prompt
            o == null -> note = err!!
            // Refused: the card shown again as it is now, with the daemon's words.
            !o.ok -> note = o.error
            else -> { note = ""; back = false }
        }
    }
    Panel(accent = if (c.ready) k.done else k.need, modifier = Modifier.semantics { contentDescription = "land-${c.key}" }) {
        Column(Modifier.padding(start = 16.dp, end = 14.dp, top = 12.dp, bottom = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StateTag(if (c.ready) State.DONE else State.NEEDS, if (c.ready) "ready to land" else "to land", only = true)
                Spacer(Modifier.weight(1f))
                Txt(c.short, T.code.copy(fontSize = T.meta.fontSize), k.faint)
            }
            Spacer(Modifier.height(6.dp))
            Txt(c.agentTitle.ifBlank { c.branch }, T.uiStrong, k.fg, Modifier.press({ Ui.route.value = Route.Session(c.agentChat, back = Route.Tabs(1)) }))
            Txt(listOf(c.branch, c.against, "in ${c.title}").filter { it.isNotBlank() }.joinToString(" · "), T.meta, k.muted)
            Spacer(Modifier.height(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Fact("Checks", c.checksLine, when (c.checksState) { "known" -> c.failed.isEmpty() && c.notRun.isEmpty() && c.passed.isNotEmpty(); "none" -> null; else -> false }, "land-checks-${c.key}")
                Fact("Review", c.reviewLineShort, if (c.verdict.isBlank()) false else c.verdict == "approved" && c.reviewCurrent != false, "land-review-${c.key}", quote = c.reviewLine)
                if (c.proof.isNotBlank()) Fact("Proof", c.proof.removePrefix("(").removeSuffix(")"), null, "land-proof-${c.key}")
                if (c.areas.isNotEmpty()) Fact("Size", c.size, null, "land-size-${c.key}")
                if (c.queueState.isNotBlank()) Fact("Queue", "Last entry ${c.queueState}${if (c.queueWhy.isNotBlank()) ": ${c.queueWhy}" else ""}", c.queueState != "left", "land-queue-${c.key}")
            }
            if (c.missing.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Txt("Missing: ${c.missing.joinToString("; ")}", T.small, k.need, Modifier.semantics { contentDescription = "land-missing-${c.key}" })
            }
            Spacer(Modifier.height(14.dp))
            if (back) Column(verticalArrangement = Arrangement.spacedBy(S.sm)) {
                Field(words, { words = it }, "What should change before it lands?", singleLine = false, tag = "land-words-${c.key}", minLines = 2)
                Row(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                    Btn(if (busy) "Sending" else "Send back", {
                        busy = true; note = ""
                        scope.launch { val r = runCatching { Hub.sendBack(c, words.trim()) }; said(r.getOrNull(), r.exceptionOrNull()?.let { reach(it) }) }
                    }, Tone.LINE, enabled = !busy && words.isNotBlank(), compact = true, tag = "land-send-${c.key}")
                    Btn("Cancel", { back = false }, Tone.QUIET, enabled = !busy, compact = true)
                }
            } else FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm), verticalArrangement = Arrangement.spacedBy(S.sm)) {
                Btn(if (busy) "Landing" else "Land", { busy = true; note = ""; Landings.run(act, c, ::said) }, if (c.ready) Tone.INK else Tone.LINE, enabled = !busy, compact = true, tag = "land-go-${c.key}")
                Btn("Send back", { back = true }, Tone.LINE, enabled = !busy, compact = true, tag = "land-back-${c.key}")
                Btn("Changes", { Ui.route.value = Route.Changes(c.agentChat) }, Tone.QUIET, enabled = !busy, compact = true, tag = "land-changes-${c.key}")
            }
            if (note.isNotBlank()) { Spacer(Modifier.height(10.dp)); Notice(note) }
        }
    }
}
