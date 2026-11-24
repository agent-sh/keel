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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.derivedStateOf
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import dev.avifenesh.keel.ApiError
import dev.avifenesh.keel.Attach
import dev.avifenesh.keel.Unsent
import dev.avifenesh.keel.Up
import dev.avifenesh.keel.Earlier
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.MainActivity
import dev.avifenesh.keel.Msg
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.Wire
import dev.avifenesh.keel.earlierAfter
import dev.avifenesh.keel.elapsed
import dev.avifenesh.keel.newestTs
import dev.avifenesh.keel.sendArrived
import dev.avifenesh.keel.stateOf
import kotlinx.coroutines.launch

@Composable
fun SessionScreen(act: MainActivity, id: String, back: Route? = null) {
    val k = k()
    val chats by Hub.chats.collectAsState()
    val all by Hub.msgs.collectAsState()
    val cards by Hub.cards.collectAsState()
    val working by Hub.working.collectAsState()
    val drafts by Hub.drafts.collectAsState()
    val older by Hub.older.collectAsState()
    val reloads by Hub.reloads.collectAsState()
    val scope = rememberCoroutineScope()
    var error by remember(id) { mutableStateOf("") }
    // A photo of the transcript seen whole.
    var viewing by remember(id) { mutableStateOf<dev.avifenesh.keel.Attachment?>(null) }
    var usage by remember(id) { mutableStateOf<String?>(null) }
    // Earlier messages: a read that failed says so and offers the way on. What is shown stays as it is.
    var earlierBusy by remember(id) { mutableStateOf(false) }
    var earlierFail by remember(id) { mutableStateOf<Pair<Earlier, String>?>(null) }
    fun earlier() {
        if (earlierBusy) return
        val reload = earlierFail?.first == Earlier.RELOAD
        earlierBusy = true
        scope.launch {
            runCatching { if (reload) Hub.open(id) else Hub.loadOlder(id) }
                .onSuccess { earlierFail = null }
                .onFailure { earlierFail = (if (reload) Earlier.RELOAD else earlierAfter((it as? ApiError)?.code)) to (it.message ?: "no answer from the daemon") }
            earlierBusy = false
        }
    }
    val chat = chats[id]
    val msgs = all[id].orEmpty()
    val pending = cards.values.any { it.chatId == id && it.pending }
    val isWorking = id in working
    val state = chat?.let { stateOf(it, pending, isWorking) } ?: State.IDLE
    val now = nowTick()
    val draft = drafts[id].orEmpty()

    // Again when the app dropped what it held and read the daemon whole (its cursor could not be caught up from).
    // Offline, what the phone last synced of it stays, and says it is that.
    LaunchedEffect(id, reloads) {
        runCatching { Hub.open(id) }.onSuccess { error = "" }.onFailure {
            val why = dev.avifenesh.keel.reach(it)
            error = if (why == dev.avifenesh.keel.OUT_OF_REACH && Hub.msgs.value[id].orEmpty().isNotEmpty()) "Offline. This is what the phone last synced; it catches up when the computer is in reach." else why
        }
    }
    // Back in reach: read it again.
    val c by Hub.conn.collectAsState()
    LaunchedEffect(id, c) { if (c == dev.avifenesh.keel.Conn.LIVE && error.isNotBlank()) runCatching { Hub.open(id) }.onSuccess { error = "" } }
    // Read as it arrives while open.
    LaunchedEffect(id, msgs.size) { if (msgs.isNotEmpty()) runCatching { dev.avifenesh.keel.Api.post("/v1/chats/$id/read") } }

    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        Head(chat?.title ?: "Session", sub = {
            StateTag(state, when (state) { State.WORKING -> working[id]?.let { elapsed(it, now) }.orEmpty(); else -> "" })
        }, lead = { IconBtn(Ic.ArrowLeft, "Back", { Ui.route.value = back ?: Route.Tabs(0) }) }) {
            IconBtn(Ic.FileDiff, "Changes", { Ui.route.value = Route.Changes(id) }, tint = k.muted)
            IconBtn(Ic.ChartColumn, "Session usage", {
                if (usage != null) usage = null
                else scope.launch { usage = runCatching { Hub.usage(id) }.getOrElse { "Usage not available: ${it.message}" } }
            }, tint = if (usage != null) k.fg else k.muted)
        }
        Rule()
        // Its agents, and its starter when it is one: one line until opened.
        AgentsBar(id, chats, cards.values.filter { it.pending }.map { it.chatId }.toSet(), working, now) { Ui.openFrom(it, Route.Session(id, back)) }
        usage?.let { Txt(it, T.meta, k.muted, Modifier.fillMaxWidth().background(k.panel).padding(horizontal = S.lg, vertical = 8.dp)) }
        // Offline is a state, not a failure: said in the quiet color.
        if (error.isNotBlank()) Notice(error, color = if (error.startsWith("Offline.")) k.muted else k.danger, modifier = Modifier.padding(S.md))
        val items = msgs.filter { it.kind != "deleted" }
        val newest = items.lastOrNull()
        // The last reply, for the way to its start when a long one opens at its end.
        val replyAt = lastReplyAt(items.asReversed(), lead = if (isWorking || draft.isNotBlank()) 1 else 0)
        FollowingList(newest?.id, newest?.mine == true, draft.length, Modifier.weight(1f).fillMaxWidth(), replyAt = replyAt) {
            if (isWorking || draft.isNotBlank()) item(key = "live") {
                Column(Modifier.padding(horizontal = S.lg, vertical = 6.dp)) {
                    if (draft.isNotBlank()) Markdown(draft)
                    Spacer(Modifier.height(6.dp))
                    if (isWorking && !pending) StateTag(State.WORKING, working[id]?.let { elapsed(it, now) }.orEmpty())
                }
            }
            items(items.asReversed(), key = { it.id }) { m -> MsgView(act, m, cards[m.approvalId]) { viewing = it } }
            if (older[id] != null || earlierFail != null) item(key = "older") {
                Column(Modifier.fillMaxWidth().padding(S.md), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(S.sm)) {
                    earlierFail?.let { (way, why) ->
                        Notice(
                            if (way == Earlier.RELOAD) "This conversation shows another branch now, so the earlier messages here are no longer its own. Reload it to read on."
                            else "The earlier messages did not load: $why",
                            modifier = Modifier.testTag("earlier-failed"),
                        )
                    }
                    val label = when { earlierBusy -> "Loading"; earlierFail?.first == Earlier.RELOAD -> "Reload the conversation"; earlierFail != null -> "Try again"; else -> "Earlier messages" }
                    Btn(label, { earlier() }, Tone.LINE, compact = true, enabled = !earlierBusy, tag = "earlier")
                }
            }
            if (items.isEmpty() && !isWorking) item(key = "empty") { Empty("Nothing here yet", "Write the first message below. The session runs on the computer.") }
        }
        Composer(id, isWorking, chat?.archived == true) { error = it }
    }
    viewing?.let { Viewer(it) { viewing = null } }
    }
}

/**
 * The transcript's list, newest at the bottom. While the owner is at the end, what arrives (a
 * message, the streamed reply growing: `growth`) stays on the screen; the owner's own send always
 * brings the view down. Read further up, the view stays where it is, and a button leads back down.
 * (A list keeps its place by the item it shows: a message added after it would land below the screen.)
 */
/** One item the list shows: its place in the list, and where it sits counted up from the list's foot (px). */
data class Shown(val index: Int, val offset: Int, val size: Int)

/**
 * Where the conversation's last reply is in the transcript's list (newest first, `lead` items under the
 * messages, such as a running turn's live line), or -1: there is none, or the owner wrote after it.
 */
fun lastReplyAt(newestFirst: List<Msg>, lead: Int): Int {
    for ((i, m) in newestFirst.withIndex()) {
        if (m.mine) return -1
        if (m.kind != "approval" && m.kind != "trace" && m.kind != "status" && m.content.isNotBlank()) return lead + i
    }
    return -1
}

/**
 * Whether the start (the top line) of the item at `reply` is above what the list shows. The list runs
 * from its foot: `shown` are its visible items with offsets counted up from the foot, `viewEnd` is where the
 * view ends at the top. An item not shown is above when only newer (lower) items are shown.
 */
fun replyStartAbove(reply: Int, shown: List<Shown>, viewEnd: Int): Boolean {
    if (reply < 0 || shown.isEmpty()) return false
    val it = shown.firstOrNull { it.index == reply } ?: return shown.maxOf { it.index } < reply
    return it.offset + it.size > viewEnd
}

/** How far to scroll (px, toward older items) so a shown reply's top line sits at the top of the view, under its padding `pad`. */
fun toReplyStart(reply: Shown, viewEnd: Int, pad: Int): Int = (reply.offset + reply.size - (viewEnd - pad)).coerceAtLeast(0)

/**
 * Room kept at the foot of a list that has a last reply: the button to that reply's start floats over the
 * foot (a button of 44 dp and the gap above it), and the last line, such as a tool's label, must not lie under it.
 * It does not depend on where the owner reads, so showing or hiding the button moves nothing.
 */
private val FOOT_BUTTONS = 52.dp

@Composable
fun FollowingList(newest: String?, newestMine: Boolean, growth: Int, modifier: Modifier = Modifier, replyAt: Int = -1, content: androidx.compose.foundation.lazy.LazyListScope.() -> Unit) {
    val k = k()
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Whether the owner is at the end: changed only by the owner's own scrolling, never by a layout.
    var follow by remember { mutableStateOf(true) }
    // A scroll of this list's own making (back to the end) says nothing of where the owner reads.
    var own by remember { mutableStateOf(false) }
    suspend fun toEnd(animate: Boolean) { own = true; try { if (animate) list.animateScrollToItem(0) else list.scrollToItem(0) } finally { own = false; follow = true } }
    LaunchedEffect(list) {
        snapshotFlow { list.isScrollInProgress to list.canScrollBackward }.collect { (moving, back) -> if (moving && !own) follow = !back }
    }
    // The owner's own send brings the view down once, when it arrives; the reply that streams after
    // it (growth) follows only while the owner stays at the end.
    var seen by remember { mutableStateOf(newest) }
    LaunchedEffect(newest, growth) {
        if (newest == null) return@LaunchedEffect
        val arrived = newest != seen
        seen = newest
        if ((arrived && newestMine) || follow) toEnd(false)
    }
    // The last reply starts above the view (a long one opens at its end): a way to its first line.
    val shown = { list.layoutInfo.visibleItemsInfo.map { Shown(it.index, it.offset, it.size) } }
    val startAbove by remember(replyAt) { derivedStateOf { replyStartAbove(replyAt, shown(), list.layoutInfo.viewportEndOffset) } }
    suspend fun toReply() {
        own = true
        try {
            // Not laid out yet (it is above all that is shown): brought to the foot first, then measured.
            if (shown().none { it.index == replyAt }) list.scrollToItem(replyAt)
            val at = shown().firstOrNull { it.index == replyAt } ?: return
            list.animateScrollBy(toReplyStart(at, list.layoutInfo.viewportEndOffset, list.layoutInfo.afterContentPadding).toFloat())
        } finally { own = false; follow = !list.canScrollBackward }
    }
    Box(modifier) {
        LazyColumn(Modifier.fillMaxSize(), state = list, reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(top = S.md, bottom = S.md + if (replyAt >= 0) FOOT_BUTTONS else 0.dp), content = content)
        Column(Modifier.align(Alignment.BottomCenter).padding(bottom = S.md), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(S.sm)) {
            if (startAbove) Row(
                Modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(S.rPill))
                    .background(k.raised).border(1.dp, k.lineStrong, RoundedCornerShape(S.rPill))
                    .press({ scope.launch { toReply() } })
                    .semantics { contentDescription = "Start of the reply" }.testTag("to-reply-start")
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KIcon(Ic.ArrowUp, k.fg, 18.dp)
                Spacer(Modifier.width(8.dp))
                Txt("Start of the reply", T.uiStrong, k.fg, maxLines = 1)
            }
            if (!follow && list.canScrollBackward) Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(S.rPill))
                    .background(k.raised).border(1.dp, k.lineStrong, RoundedCornerShape(S.rPill))
                    .press({ scope.launch { toEnd(true) } })
                    .semantics { contentDescription = "Latest" }.testTag("to-latest"),
                contentAlignment = Alignment.Center,
            ) { KIcon(Ic.ArrowDown, k.fg, 20.dp) }
        }
    }
}

@Composable
private fun MsgView(act: MainActivity, m: Msg, card: dev.avifenesh.keel.Card?, onView: (dev.avifenesh.keel.Attachment) -> Unit) {
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
            Txt(m.content, T.meta, if (s == State.FAILED) k.failInk else k.muted, maxLines = 4)
        }
        m.mine -> Row(Modifier.fillMaxWidth().padding(start = 56.dp, end = S.md, top = 8.dp, bottom = 8.dp), horizontalArrangement = Arrangement.End) {
            Column(horizontalAlignment = Alignment.End) {
                if (m.kind == "queued" || m.kind == "steer") Txt(if (m.kind == "queued") "QUEUED" else "STEER", T.label, k.workInk, Modifier.padding(bottom = 4.dp))
                // What the prompt carried, above its words: its photos as pictures, its files by name.
                SentFiles(m.attachments, onView)
                val shape = RoundedCornerShape(topStart = S.rLg, topEnd = S.rLg, bottomStart = S.rLg, bottomEnd = 2.dp)
                // A message of files alone has no words to show.
                if (m.content.isNotBlank() || m.attachments.isEmpty()) Box(Modifier.clip(shape).background(k.inkSoft).padding(horizontal = 14.dp, vertical = 10.dp).semantics { contentDescription = "mine-${m.content.take(40)}" }) {
                    Txt(m.content, T.body, k.fg)
                }
            }
        }
        else -> Reply(m)
    }
}

/**
 * The agent's words: who wrote them when not the agent itself, the reply, and under it the model
 * that answered and Copy (the reply as written, Markdown and all). A long press selects any part.
 */
@Composable
fun Reply(m: Msg) {
    val k = k()
    Column(Modifier.fillMaxWidth().padding(horizontal = S.lg, vertical = 8.dp).semantics { contentDescription = "agent-${m.content.take(40)}" }) {
        if (m.origin.isNotBlank() && m.origin != "agent") Txt(m.origin.uppercase(), T.label, k.faint, Modifier.padding(bottom = 4.dp))
        SelectionContainer { Markdown(m.content) }
        Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Txt(m.model.substringAfterLast('/').substringAfter(':'), T.meta, k.faint, Modifier.weight(1f), maxLines = 1)
            CopyBtn(m.content, "Copy the reply", "copy-reply")
        }
    }
}

/** Copies `text`; its mark turns to a check for a moment, so the tap is seen. */
@Composable
fun CopyBtn(text: String, label: String, tag: String) {
    val k = k()
    val clip = androidx.compose.ui.platform.LocalClipboardManager.current
    var done by remember { mutableStateOf(false) }
    LaunchedEffect(done) { if (done) { kotlinx.coroutines.delay(1500); done = false } }
    IconBtn(if (done) Ic.Check else Ic.Copy, label, { clip.setText(androidx.compose.ui.text.AnnotatedString(text)); done = true },
        tint = if (done) k.done else k.faint, modifier = Modifier.testTag(tag))
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
    val ctx = LocalContext.current
    // What is picked for this message; each file goes up as it is picked.
    val picked = Attach.pending.collectAsState().value[id].orEmpty()
    val files = picked.mapNotNull { if (it.state == Up.READY) it.upload else null }
    val uploading = picked.count { it.busy }
    val failed = picked.any { it.state == Up.FAILED }
    var menu by rememberSaveable(id) { mutableStateOf(false) }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { if (it.isNotEmpty()) Attach.add(ctx, id, it) }
    val docs = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { if (it.isNotEmpty()) Attach.add(ctx, id, it) }
    // The words begun here: kept with the session (Unsent), so a session left and opened again has them.
    var text by rememberSaveable(id) { mutableStateOf(Unsent.of(id)) }
    LaunchedEffect(id, text) { Unsent.put(id, text) }
    var mode by rememberSaveable(id) { mutableStateOf("steer") }
    var busy by remember { mutableStateOf(false) }
    // The send in hand: its id stays with the words until the daemon answers,
    // so sending them again after a lost answer makes no second prompt.
    var keptId by rememberSaveable(id) { mutableStateOf("") }
    var keptText by rememberSaveable(id) { mutableStateOf("") }
    // The words and the files of the send in hand: the same send only while both are the same.
    var keptKey by rememberSaveable(id) { mutableStateOf("") }
    // The newest message held when the send was first made (the daemon's clock).
    var keptAfter by rememberSaveable(id) { mutableStateOf(0.0) }
    // A send that failed, here or after the screen was left while it went: the owner is told why, and
    // the words it brought back to the box go again as the same send.
    val notSent = Unsent.notSent.collectAsState().value[id]
    LaunchedEffect(notSent) {
        val f = notSent ?: return@LaunchedEffect
        if (text.isEmpty()) text = Unsent.of(id)
        if (text.trim() == f.words) { keptId = f.id; keptText = f.words; keptKey = f.key; keptAfter = f.after }
        onError(f.why)
        Unsent.shown(id)
    }
    val held = Hub.msgs.collectAsState().value[id].orEmpty()
    // The send got no answer here, but its message came with the stream: it is done. The words
    // leave the box, and the same words sent again are a new prompt, not a retry of this one.
    val arrived = keptId.isNotEmpty() && !busy && sendArrived(held, keptText, keptAfter)
    LaunchedEffect(arrived) {
        if (arrived) {
            if (text.trim() == keptText) text = ""
            // The files of that send leave the row; any picked since stay.
            Attach.sent(id, keptKey)
            keptId = ""; keptText = ""; keptKey = ""; onError("")
        }
    }
    // Send waits for every picked file to be stored; one that failed is removed or picked again first.
    val ready = (text.isNotBlank() || files.isNotEmpty()) && uploading == 0 && !failed && !busy
    fun send() {
        val t = text.trim(); if (!ready) return
        val sending = files
        val key = Wire.sendKey(t, sending)
        val cid = Wire.sendId(keptId, keptKey, key)
        if (cid != keptId) keptAfter = newestTs(held)
        keptId = cid; keptText = t; keptKey = key
        busy = true
        val how = if (working) mode else "send"
        val why = { e: Throwable -> dev.avifenesh.keel.reach(e).let { w -> if (w == dev.avifenesh.keel.OUT_OF_REACH) "Not sent: the computer is out of reach. Send it again when it is." else w } }
        // (The send goes on when the screen is left; its failure comes back through Unsent.notSent.)
        val going = Unsent.send(Hub.scope, id, Unsent.NotSent(t, cid, key, keptAfter, ""), why) {
            Hub.send(id, t, how, cid, sending)
            Attach.sent(id, sending)
        }
        scope.launch {
            runCatching { going.await() }.onSuccess { text = ""; keptId = ""; keptText = ""; keptKey = ""; onError("") }
            busy = false
        }
    }
    fun stop() { scope.launch { runCatching { Hub.stopTurn(id) }.onFailure { onError(it.message ?: "Could not stop") } } }
    Column(Modifier.fillMaxWidth().background(k.panel).navigationBarsPadding()) {
        Rule()
        if (archived) { Txt("This session is archived. Unarchive it on the computer to write here.", T.small, k.muted, Modifier.padding(S.lg)); return }
        PickedRow(id, picked)
        if (menu) Row(Modifier.padding(start = S.md, end = S.md, top = 10.dp), horizontalArrangement = Arrangement.spacedBy(S.sm)) {
            Btn("Photos", { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, Tone.LINE, icon = Ic.Image, compact = true, tag = "attach-photos")
            Btn("Files", { menu = false; docs.launch(arrayOf("*/*")) }, Tone.LINE, icon = Ic.File, compact = true, tag = "attach-files")
        }
        if (working) Row(Modifier.padding(start = S.md, end = S.md, top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Segmented(listOf("steer" to "Steer", "queue" to "Queue"), mode) { mode = it }
            Spacer(Modifier.width(S.md))
            Txt(if (mode == "steer") "Joins the running turn" else "Runs after this turn", T.meta, k.faint, maxLines = 1)
        }
        Row(Modifier.fillMaxWidth().padding(S.md), verticalAlignment = Alignment.Bottom) {
            Box(Modifier.padding(bottom = 3.dp)) { IconBtn(Ic.Paperclip, "attach", { menu = !menu }, tint = if (menu) k.fg else k.muted) }
            Spacer(Modifier.width(4.dp))
            val shape = RoundedCornerShape(S.rLg)
            Box(Modifier.weight(1f).clip(shape).background(k.raised).border(1.dp, k.line, shape).padding(horizontal = 14.dp, vertical = 11.dp)) {
                if (text.isEmpty()) Txt(when {
                    uploading > 0 -> "Uploading ${if (uploading == 1) "a file" else "$uploading files"}"
                    working -> if (mode == "steer") "Steer the running turn" else "Queue the next message"
                    picked.size == 1 -> "Add words, or send it as it is"
                    picked.isNotEmpty() -> "Add words, or send them as they are"
                    else -> "Message Keel"
                }, T.body, k.faint, maxLines = 1)
                BasicTextField(text, { text = it }, Modifier.fillMaxWidth().semantics { contentDescription = "composer" }, textStyle = T.body.copy(color = k.fg),
                    maxLines = 6, cursorBrush = SolidColor(k.fg))
            }
            Spacer(Modifier.width(S.sm))
            val stopNow = working && text.isBlank() && picked.isEmpty()
            Box(
                Modifier.size(46.dp).clip(RoundedCornerShape(S.rPill)).background(if (stopNow) k.dangerSoft else if (!ready) k.inkSoft else k.ink)
                    .press({ if (stopNow) stop() else send() }, enabled = stopNow || ready)
                    .semantics { contentDescription = if (stopNow) "stop" else "send" },
                contentAlignment = Alignment.Center,
            ) {
                if (stopNow) Box(Modifier.size(14.dp).clip(RoundedCornerShape(3.dp)).background(k.danger))
                else KIcon(Ic.ArrowUp, if (!ready) k.faint else k.inkFg, 22.dp)
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
