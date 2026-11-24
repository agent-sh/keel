// What a session changed in its folder, read-only: the files since its first turn, then each turn's
// files, newest first; a file opens its diff. The phone reads one file's diff at a time.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.ChangeTurn
import dev.avifenesh.keel.Changes
import dev.avifenesh.keel.DiffLine
import dev.avifenesh.keel.FileChange
import dev.avifenesh.keel.FileDiff
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.ago

/** `load`: where the changes come from (the daemon; a screen test gives its own). */
@Composable
fun ChangesScreen(id: String, load: suspend () -> Changes = { Hub.changes(id) }) {
    val k = k()
    val chats by Hub.chats.collectAsState()
    val working by Hub.working.collectAsState()
    var data by remember(id) { mutableStateOf<Changes?>(null) }
    var error by remember(id) { mutableStateOf("") }
    var again by remember(id) { mutableIntStateOf(0) }
    // Read again when asked, and when a turn of the session ends (it may have changed more).
    val running = id in working
    LaunchedEffect(id, again, running) {
        runCatching { load() }.onSuccess { data = it; error = "" }.onFailure { error = it.message ?: "The changes did not load" }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Head("Changes", sub = { Txt(chats[id]?.title ?: "Session", T.meta, k.muted, maxLines = 1) },
            lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = Route.Session(id) }) }) {
            IconBtn(Ic.RotateCw, "Refresh", { again++ }, tint = k.muted)
        }
        Rule()
        if (error.isNotBlank()) Notice(error, modifier = Modifier.padding(S.md).testTag("changes-error"))
        val d = data ?: run { if (error.isBlank()) Empty("Reading the changes", "From the session's checkpoints on the computer."); return@Column }
        if (d.unavailable.isNotBlank()) { Empty("No changes to show", d.unavailable); return@Column }
        if (d.session.isEmpty() && d.turns.isEmpty()) { Empty("Nothing changed", "This session has changed no file in its folder."); return@Column }
        LazyColumn(Modifier.fillMaxSize().testTag("changes"), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = S.xl)) {
            if (d.session.isNotEmpty()) {
                item(key = "h-session") { Section("Since the first turn", d.session.sumOf { it.added }, d.session.sumOf { it.removed }, d.session.size) }
                items(d.session, key = { "s-" + it.path }) { f -> FileRow(f) { Ui.route.value = Route.Diff(id, f.path, null, "Since the first turn") } }
            }
            for (t in d.turns) {
                item(key = "h-${t.turn}") { TurnHead(t) }
                items(t.files, key = { "${t.turn}-" + it.path }) { f -> FileRow(f) { Ui.route.value = Route.Diff(id, f.path, t.turn, turnName(t)) } }
            }
            if (d.expired > 0) item(key = "expired") {
                Txt("${d.expired} older turn${if (d.expired == 1) "" else "s"} no longer kept.", T.small, k.faint, Modifier.padding(horizontal = S.lg, vertical = S.md))
            }
        }
    }
}

private fun turnName(t: ChangeTurn) = if (t.n != null) "Turn ${t.n}" else "A turn"

@Composable
private fun Counts(added: Int, removed: Int) {
    val k = k()
    Row {
        // A count of none is quiet: the eye goes to what changed.
        Txt("+$added", T.meta, if (added > 0) k.doneInk else k.faint)
        Spacer(Modifier.width(6.dp))
        Txt("−$removed", T.meta, if (removed > 0) k.failInk else k.faint)
    }
}

@Composable
private fun Section(title: String, added: Int, removed: Int, files: Int) {
    val k = k()
    Row(Modifier.fillMaxWidth().padding(start = S.lg, end = S.lg, top = S.lg, bottom = S.xs), verticalAlignment = Alignment.CenterVertically) {
        Txt(title.uppercase(), T.label, k.muted)
        Spacer(Modifier.width(8.dp))
        Txt("$files", T.label, k.faint)
        Spacer(Modifier.weight(1f))
        Counts(added, removed)
    }
}

@Composable
private fun TurnHead(t: ChangeTurn) {
    val k = k()
    Column(Modifier.fillMaxWidth().padding(start = S.lg, end = S.lg, top = S.lg, bottom = S.xs).semantics { contentDescription = "turn-${t.n ?: t.turn}" }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Txt(turnName(t).uppercase(), T.label, k.muted)
            Spacer(Modifier.width(8.dp))
            if (t.ts > 0) Txt(ago(t.ts), T.label, k.faint)
            Spacer(Modifier.weight(1f))
            Counts(t.added, t.removed)
        }
        if (t.prompt.isNotBlank()) Txt(t.prompt, T.small, k.fg, Modifier.padding(top = 2.dp), maxLines = 2)
    }
}

/** A changed file: how it changed, its name over its folder, the lines added and removed. */
@Composable
private fun FileRow(f: FileChange, onOpen: () -> Unit) {
    val k = k()
    val (word, color) = when (f.status.take(1)) {
        "A" -> "A" to k.doneInk
        "D" -> "D" to k.failInk
        else -> f.status.take(1).ifBlank { "M" } to k.workInk
    }
    Row(
        Modifier.fillMaxWidth().press(onOpen).semantics { contentDescription = "file-${f.path}" }.padding(horizontal = S.lg, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(22.dp)) { Txt(word, T.code.copy(fontSize = T.meta.fontSize), color) }
        Column(Modifier.weight(1f)) {
            Txt(f.name, T.ui, k.fg, maxLines = 1)
            if (f.dir.isNotBlank() || f.outside) Txt(listOfNotNull(f.dir.ifBlank { null }, if (f.outside) "changed outside the session" else null).joinToString(" · "), T.meta, k.faint, maxLines = 1)
        }
        Spacer(Modifier.width(S.sm))
        Counts(f.added, f.removed)
    }
}

@Composable
fun DiffScreen(r: Route.Diff, load: suspend () -> FileDiff = { Hub.fileDiff(r.id, r.path, r.turn) }) {
    val k = k()
    var data by remember(r) { mutableStateOf<FileDiff?>(null) }
    var error by remember(r) { mutableStateOf("") }
    LaunchedEffect(r) { runCatching { load() }.onSuccess { data = it; error = "" }.onFailure { error = it.message ?: "The diff did not load" } }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        Head(r.path.substringAfterLast('/'), sub = { Txt(listOf(r.label, r.path.substringBeforeLast('/', "")).filter { it.isNotBlank() }.joinToString(" · "), T.meta, k.muted, maxLines = 1) },
            lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = Route.Changes(r.id) }) }) {
            data?.let { Box(Modifier.padding(end = S.sm)) { Counts(it.added, it.removed) } }
        }
        Rule()
        if (error.isNotBlank()) Notice(error, modifier = Modifier.padding(S.md))
        val d = data ?: run { if (error.isBlank()) Empty("Reading the diff", "From the session's checkpoints on the computer."); return@Column }
        val lines = d.lines
        if (lines.isEmpty()) { Empty("No lines to show", if (d.truncated) "The diff is too long to send; read it on the computer." else "The file changed in a way a diff does not show (its mode, or it is not text)."); return@Column }
        // A long line wraps under its numbers: a phone is read without scrolling sideways.
        val digits = (lines.maxOfOrNull { maxOf(it.old ?: 0, it.new ?: 0) } ?: 0).toString().length.coerceAtLeast(2)
        SelectionContainer {
            LazyColumn(Modifier.fillMaxSize().background(k.raised).testTag("diff")) {
                items(lines.size) { i -> Line(lines[i], digits) }
                if (d.truncated) item { Txt("The rest of the diff is too long to send; read it on the computer.", T.small, k.muted, Modifier.padding(S.lg)) }
            }
        }
    }
}

@Composable
private fun Line(l: DiffLine, digits: Int) {
    val k = k()
    val tint = when (l.kind) { '+' -> k.addTint; '-' -> k.delTint; '@' -> k.sunken; else -> androidx.compose.ui.graphics.Color.Transparent }
    val num = T.code.copy(fontSize = T.meta.fontSize)
    Row(Modifier.fillMaxWidth().background(tint).semantics { contentDescription = "line-${l.kind}" }) {
        if (l.kind == '@' || l.kind == '\\') {
            Txt(l.text, num, k.muted, Modifier.padding(horizontal = S.md, vertical = 4.dp))
            return@Row
        }
        Row(Modifier.padding(start = 6.dp)) {
            Txt((l.old?.toString() ?: "").padStart(digits), num, k.faint)
            Spacer(Modifier.width(6.dp))
            Txt((l.new?.toString() ?: "").padStart(digits), num, k.faint)
        }
        Row(Modifier.weight(1f).padding(start = 6.dp, end = S.md)) {
            Txt(when (l.kind) { '+' -> "+"; '-' -> "−"; else -> " " }, T.code, if (l.kind == '+') k.doneInk else if (l.kind == '-') k.failInk else k.faint)
            Spacer(Modifier.width(6.dp))
            // As written: no ligature turns => into an arrow in a diff.
            Txt(l.text, T.code.copy(fontFeatureSettings = "liga 0, calt 0"), k.fg, Modifier.weight(1f))
        }
    }
}
