// What broke on the daemon, on the phone: the open errors the page's Errors panel lists, each kind of
// failure once with its whole message, where it came from, how often and when. A row opens the session it
// last happened in; read takes it out of the count, resolve takes it off the list, on the page too.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.ErrorRow
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.ago
import dev.avifenesh.keel.reach
import kotlinx.coroutines.launch

/** The way to the Errors view from the list's head: the mark, and the count the page's badge shows. */
@Composable
fun ErrorsBtn() {
    val k = k()
    val list by Hub.errors.collectAsState()
    val unread = list?.unread ?: 0
    val tint = if (unread > 0) k.fail else k.muted
    Row(
        Modifier.heightIn(min = 40.dp).widthIn(min = 40.dp).clip(RoundedCornerShape(S.r)).press({ Ui.route.value = Route.Errors })
            .semantics { contentDescription = if (unread > 0) "Errors, $unread unread" else "Errors" }.padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        KIcon(Ic.TriangleAlert, tint, 20.dp)
        if (unread > 0) { Spacer(Modifier.width(4.dp)); Txt("$unread", T.uiStrong, k.fail, maxLines = 1) }
    }
}

@Composable
fun ErrorsScreen() {
    val k = k()
    val list by Hub.errors.collectAsState()
    var note by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        runCatching { Hub.errorList() }.onSuccess { note = "" }.onFailure { note = reach(it) }
        busy = false
    }
    fun act(row: ErrorRow, action: String) {
        scope.launch { runCatching { Hub.markError(row.id, action) }.onFailure { note = reach(it) } }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        val l = list
        Head(
            "Errors",
            sub = { if (l != null) Txt(if (l.open.isEmpty()) "Nothing open" else "${l.open.size} open · ${l.unread} unread", T.meta, k.muted) },
            lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = Route.Tabs(0) }) },
        )
        if (note.isNotBlank()) Notice(note, modifier = Modifier.padding(horizontal = S.lg, vertical = S.sm))
        Rule()
        when {
            l == null -> Empty(if (busy) "Reading the errors" else "The errors were not read", if (busy) "" else "They are read from the computer when it is in reach.")
            l.rows.isEmpty() -> Empty("Nothing open has failed", "What breaks on the computer shows here, as on the page's Errors panel.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(l.open, key = { it.id }) { r -> ErrorItem(r, ::act); Rule(Modifier.padding(start = S.lg)) }
                if (l.healed.isNotEmpty()) {
                    item(key = "h-healed") { SectionLabel("Healed by a retry", l.healed.size, k.muted, Modifier.padding(top = S.md)) }
                    items(l.healed, key = { it.id }) { r -> ErrorItem(r, ::act); Rule(Modifier.padding(start = S.lg)) }
                }
                item { Spacer(Modifier.padding(bottom = S.xl)) }
            }
        }
    }
}

/** "11m ago", and when it happened more than once over time, "11m ago, first 3h ago". */
private fun whenText(r: ErrorRow): String {
    fun at(t: Double) = ago(t).let { if (it == "now") it else "$it ago" }
    val last = at(r.last); val first = at(r.first)
    return if (r.count > 1 && first != last) "$last, first $first" else last
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ErrorItem(r: ErrorRow, act: (ErrorRow, String) -> Unit) {
    val k = k()
    val open = if (r.chatId.isNotBlank()) ({ Ui.route.value = Route.Session(r.chatId, back = Route.Errors) }) else null
    Column(
        Modifier.fillMaxWidth().then(if (open != null) Modifier.press(open) else Modifier)
            .semantics { contentDescription = "error-${r.id}" }.padding(start = S.lg, end = S.md, top = 12.dp, bottom = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            // Unread: the failure's mark, as the session list marks a failed session; read: a hairline ring.
            Box(Modifier.padding(top = 6.dp, end = 10.dp)) {
                Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(if (r.unread) k.fail else if (r.recovered) k.done else k.lineStrong))
            }
            Column(Modifier.weight(1f)) {
                // Where from and how often, and when it last happened: wrapped, never cut.
                FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                    Txt(r.meta, T.uiStrong.copy(fontSize = T.small.fontSize), if (r.unread) k.fail else k.muted, Modifier.semantics { contentDescription = "error-meta-${r.id}" })
                    Txt(whenText(r), T.meta, k.faint)
                }
                Spacer(Modifier.padding(top = 4.dp))
                // The whole message: the page shows it whole when opened, the phone always.
                Txt(r.message, T.ui, if (r.unread) k.fg else k.muted, Modifier.semantics { contentDescription = "error-message-${r.id}" })
                if (r.where.isNotBlank()) Txt(r.where, T.meta, k.muted, Modifier.padding(top = 4.dp))
                if (r.recovered) Txt("Every time, a retry of the request passed.", T.meta, k.done, Modifier.padding(top = 4.dp))
                // The buttons' own padding lines their words up with the message.
                FlowRow(Modifier.padding(top = 4.dp).offset(x = (-12).dp), horizontalArrangement = Arrangement.spacedBy(S.xs)) {
                    if (!r.recovered) Btn(if (r.read) "Mark unread" else "Mark read", { act(r, if (r.read) "unread" else "read") }, Tone.QUIET, compact = true, tag = "error-read-${r.id}")
                    Btn("Resolve", { act(r, "resolve") }, Tone.QUIET, compact = true, tag = "error-resolve-${r.id}")
                    if (open != null) Btn("Open session", open, Tone.QUIET, compact = true, tag = "error-open-${r.id}")
                }
            }
        }
    }
}
