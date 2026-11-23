// Search across sessions from the phone: the daemon's own search, titles first, then what was said
// and done, one hit a session, the words found in bold. A hit opens its session.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.SearchHit
import dev.avifenesh.keel.SearchResult
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.ago
import dev.avifenesh.keel.snippetParts
import kotlinx.coroutines.delay

// The words and what they found, kept while the app runs: back from a hit's session, the list is
// where the owner left it.
private val kept = mutableStateOf("")
private val keptResult = mutableStateOf<SearchResult?>(null)

/** `find`: the search (the daemon's; a screen test gives its own). `onOpen`: a hit's session. */
@Composable
fun SearchScreen(find: suspend (String) -> SearchResult = { Hub.search(it) }, onOpen: (String) -> Unit = { Ui.route.value = Route.Session(it, back = Route.Search) }) {
    val k = k()
    var q by kept
    var result by keptResult
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    // Asked a moment after the typing stops: a word typed letter by letter is one search.
    var asked by remember { mutableStateOf(if (result != null) q else "") }
    LaunchedEffect(q) {
        if (q.isBlank()) { result = null; error = ""; return@LaunchedEffect }
        if (q == asked && result != null) return@LaunchedEffect
        delay(300)
        asked = q
        busy = true
        runCatching { find(q.trim()) }.onSuccess { result = it; error = "" }
            .onFailure { error = dev.avifenesh.keel.reach(it).let { w -> if (w == dev.avifenesh.keel.OUT_OF_REACH) "The computer is out of reach: the search runs there." else w } }
        busy = false
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
        Head("Search", lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = Route.Tabs(0) }) })
        Box(Modifier.padding(horizontal = S.md, vertical = S.sm)) {
            Field(q, { q = it }, "Words, or state:failed, since:yesterday", tag = "search-q")
        }
        Rule()
        val r = result
        when {
            error.isNotBlank() -> Notice(error, modifier = Modifier.padding(S.md))
            q.isBlank() -> Empty("Search every session", "Titles first, then what was said and done. Every word must match; the last one may be its start.")
            r == null -> Empty(if (busy) "Searching" else "", "")
            r.hits.isEmpty() -> Empty("Nothing found", if (r.limits.isEmpty()) "No session holds all of these words." else "Limited to: ${r.limits.joinToString(", ")}.")
            else -> LazyColumn(Modifier.fillMaxSize()) {
                if (r.limits.isNotEmpty()) item { Txt("Limited to: ${r.limits.joinToString(", ")}", T.meta, k.faint, Modifier.padding(horizontal = S.lg, vertical = S.sm)) }
                items(r.hits, key = { it.chatId + ":" + it.kind + ":" + it.eventId }) { h -> HitRow(h) { onOpen(h.chatId) }; Rule(Modifier.padding(start = S.lg)) }
            }
        }
    }
}

@Composable
private fun HitRow(h: SearchHit, onOpen: () -> Unit) {
    val k = k()
    Column(Modifier.fillMaxWidth().press(onOpen).semantics { contentDescription = "hit-${h.title}" }.padding(horizontal = S.lg, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Txt(h.title, T.uiStrong, k.fg, Modifier.weight(1f), maxLines = 1)
            Spacer(Modifier.width(S.sm))
            if (h.ts > 0) Txt(ago(h.ts), T.meta, k.faint)
        }
        if (h.kind != "title") {
            Txt(h.where.uppercase(), T.label, k.faint, Modifier.padding(top = 4.dp))
            // The words found in bold, in the text's own color; the rest muted.
            val text = buildAnnotatedString {
                for ((part, found) in snippetParts(h.snippet.replace(Regex("\\s+"), " ")))
                    if (found) withStyle(SpanStyle(color = k.fg, fontWeight = FontWeight(600))) { append(part) } else append(part)
            }
            BasicText(text, style = T.small.copy(color = k.muted), maxLines = 3, modifier = Modifier.padding(top = 2.dp).semantics { contentDescription = "snippet-${h.title}" })
        }
    }
}
