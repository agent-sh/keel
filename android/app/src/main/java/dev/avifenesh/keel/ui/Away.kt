// What happened while the owner was away, at the top of the session list: the page's own digest, in
// one line until opened, then each session in which something happened, the one that failed first.
// Seen, it is gone here and on the page.
package dev.avifenesh.keel.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Away
import dev.avifenesh.keel.AwaySession
import dev.avifenesh.keel.State

/** A digest's state word as the list's marks draw it. */
private fun stateOf(watch: String): State = when (watch) {
    "need" -> State.NEEDS
    "work", "wait", "resume" -> State.WORKING
    "fail", "declined" -> State.FAILED
    "stop" -> State.STOPPED
    "done" -> State.DONE
    else -> State.IDLE
}

@Composable
fun AwayCard(a: Away, onOpen: (String) -> Unit, onSeen: () -> Unit) {
    val k = k()
    // Open by itself when something failed: that is what the owner most needs to hear.
    var open by rememberSaveable(a.span) { mutableStateOf(a.failed > 0) }
    Box(Modifier.padding(horizontal = S.md, vertical = S.sm)) {
        Panel(accent = if (a.failed > 0) k.fail else null, modifier = Modifier.semantics { contentDescription = "away" }) {
            Column(Modifier.animateContentSize()) {
                Column(Modifier.fillMaxWidth().press({ open = !open }).semantics { contentDescription = "away-head" }.padding(start = 16.dp, end = 14.dp, top = 12.dp, bottom = 10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Txt("WHILE YOU WERE AWAY", T.label, k.muted, Modifier.weight(1f))
                        KIcon(if (open) Ic.ChevronDown else Ic.ChevronRight, k.faint, 16.dp)
                    }
                    Spacer(Modifier.padding(top = 4.dp))
                    Txt(a.brief.replaceFirstChar { it.uppercase() }, T.ui, k.fg, maxLines = if (open) Int.MAX_VALUE else 2)
                    Txt(a.span.substringAfter("away, ").replaceFirstChar { it.uppercase() }, T.meta, k.faint, Modifier.padding(top = 2.dp), maxLines = 1)
                }
                if (open) {
                    for (line in a.daemon) Txt(line, T.small, k.muted, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    for (r in a.sessions) { Rule(); AwayRow(r) { onOpen(r.chatId) } }
                    if (a.quiet > 0) Txt("${a.quiet} other session${if (a.quiet == 1) "" else "s"}: nothing happened.", T.small, k.faint, Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                    Rule()
                    Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), horizontalArrangement = Arrangement.End) {
                        Btn("Seen", onSeen, Tone.QUIET, compact = true, tag = "away-seen")
                    }
                }
            }
        }
    }
}

@Composable
private fun AwayRow(r: AwaySession, onOpen: () -> Unit) {
    val k = k()
    val s = stateOf(r.watch)
    Row(Modifier.fillMaxWidth().press(onOpen).semantics { contentDescription = "away-${r.title}" }.padding(start = 16.dp, end = 14.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 5.dp, end = 10.dp)) { StateMark(s, 9.dp) }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Txt(r.title, T.uiStrong, k.fg, Modifier.weight(1f), maxLines = 1)
                Spacer(Modifier.width(S.sm))
                Txt(r.state, T.meta, if (s == State.FAILED) k.failInk else k.faint, maxLines = 1)
            }
            // What went wrong in the color of a failure, the rest as it is.
            val text = buildAnnotatedString {
                val at = if (r.bad.isNotBlank()) r.text.indexOf(r.bad) else -1
                if (at < 0) append(r.text) else {
                    append(r.text.substring(0, at))
                    withStyle(SpanStyle(color = k.failInk)) { append(r.bad) }
                    append(r.text.substring(at + r.bad.length))
                }
            }
            androidx.compose.foundation.text.BasicText(text, style = T.small.copy(color = k.muted), modifier = Modifier.padding(top = 2.dp))
        }
    }
}
