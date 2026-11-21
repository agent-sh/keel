// What the app holds of the daemon and how the daemon's answers change it, as
// plain state with no Android in it: the unit tests run it on the JVM with the
// frames the daemon sends.
package dev.avifenesh.keel

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject

class Feed {
    val chats = MutableStateFlow<Map<String, Chat>>(emptyMap())
    val msgs = MutableStateFlow<Map<String, List<Msg>>>(emptyMap())
    val older = MutableStateFlow<Map<String, String?>>(emptyMap())
    val cards = MutableStateFlow<Map<String, Card>>(emptyMap())
    val working = MutableStateFlow<Map<String, Double>>(emptyMap())
    val drafts = MutableStateFlow<Map<String, String>>(emptyMap())
    val synced = MutableStateFlow(false)
    /** Counts the times everything held was dropped and read whole again: the session on screen loads its page again. */
    val reloads = MutableStateFlow(0)
    /** Called with each card that opens. */
    var onCard: ((Card) -> Unit)? = null

    /**
     * The place in the daemon's event sequence up to which everything is
     * applied here. The stream opens from it. It moves only on the daemon's
     * word (a sync answer's `seq`, a frame's `cursor`), never on a frame that
     * merely names a newer place: what lies between may not have arrived.
     */
    @Volatile var cursor = 0L
        private set

    // A catch-up is in flight (an older daemon sends none with the stream):
    // frames wait, so its answer never lands on top of newer state.
    private var catching = false
    private val held = ArrayList<JSONObject>()
    // Whether this stream brings its own catch-up (`hello` with `sync`).
    private var streamSyncs = false

    @Synchronized fun clear() {
        cursor = 0; catching = false; held.clear(); streamSyncs = false
        chats.value = emptyMap(); msgs.value = emptyMap(); older.value = emptyMap(); cards.value = emptyMap()
        working.value = emptyMap(); drafts.value = emptyMap(); synced.value = false
    }

    /** A stream closed: what waited for its catch-up is dropped with it; the next stream starts from the cursor. */
    @Synchronized fun closed() { catching = false; held.clear(); streamSyncs = false }

    /**
     * One frame of the event stream. True when the caller must fetch a catch-up
     * (GET /v1/sync from the cursor, each answer to [sync], then [end]); frames
     * wait from then until [end].
     */
    @Synchronized fun frame(e: JSONObject): Boolean {
        if (catching) { held += e; return false }
        catching = apply(e)
        return catching
    }

    /** One /v1/sync answer. True when the daemon has more after it. */
    @Synchronized fun sync(o: JSONObject): Boolean {
        // "ahead" or "behind": the cursor cannot be caught up from. The answer is the whole state.
        val reload = o.str("reload").isNotBlank()
        val first = cursor == 0L || reload
        o.optJSONArray("chats")?.let { a ->
            val list = objs(a).map(Chat::of).associateBy { it.id }
            chats.value = if (o.optBoolean("complete")) list else chats.value + list
        }
        if (reload) { msgs.value = emptyMap(); older.value = emptyMap() }
        // `reset`: chats whose shown branch changed since the cursor. The answer's
        // messages for them are their newest page, in place of what is held.
        val resets = o.optJSONArray("reset")?.let { objs(it) }.orEmpty().associate { it.str("chat_id") to it.str("older").takeIf { s -> s.isNotBlank() } }
        val all = o.optJSONArray("messages")?.let { objs(it).map(Msg::of) }.orEmpty()
        for ((chat, olderId) in resets) branch(chat, all.filter { it.chatId == chat }, olderId)
        mergeMsgs(all.filter { it.chatId !in resets })
        o.optJSONArray("approvals")?.let { mergeCards(objs(it).map(Card::of), replacePending = first) }
        o.optJSONArray("working")?.let { setWorking(it) }
        o.optJSONArray("drafts")?.let { a -> drafts.value = objs(a).associate { it.str("chat_id") to it.str("text") }.filterValues { it.isNotEmpty() } }
        cursor = o.optLong("seq", cursor)
        synced.value = true
        if (reload) reloads.update { it + 1 }
        return o.optBoolean("more")
    }

    /** The catch-up is done: the frames that waited are applied on top of it. True when one of them asks for another. */
    @Synchronized fun end(): Boolean {
        catching = false
        val waited = held.toList()
        held.clear()
        for ((i, e) in waited.withIndex()) if (apply(e)) {
            catching = true
            held += waited.drop(i + 1)
            break
        }
        return catching
    }

    private fun apply(e: JSONObject): Boolean {
        when (e.str("type")) {
            "hello" -> {
                val s = e.optJSONObject("sync")
                streamSyncs = s != null
                if (s != null) sync(s) else e.optJSONArray("working")?.let { setWorking(it) }
                advance(e)
                return s == null
            }
            "seq" -> { e.optJSONArray("working")?.let { setWorking(it) }; advance(e) }
            "message" -> {
                e.optJSONObject("chat")?.let { putChat(Chat.of(it)) }
                e.optJSONObject("message")?.let { mergeMsgs(listOf(Msg.of(it))) }
                advance(e)
            }
            "delta" -> { val c = e.str("chat_id"); val d = e.str("delta"); drafts.update { it + (c to (it[c].orEmpty() + d)) } }
            "chat" -> e.optJSONObject("chat")?.let { putChat(Chat.of(it)) }
            // Another branch is shown on the desktop: its newest page replaces the transcript.
            "chat_reset" -> {
                e.optJSONObject("chat")?.let { putChat(Chat.of(it)) }
                branch(e.str("chat_id"), objs(e.optJSONArray("messages") ?: JSONArray()).map(Msg::of), e.str("older").takeIf { it.isNotBlank() })
            }
            "chat_removed" -> { val c = e.str("chat_id"); chats.update { it - c }; msgs.update { it - c }; older.update { it - c } }
            "working" -> {
                val c = e.str("chat_id")
                if (e.optBoolean("working")) working.update { it + (c to e.optDouble("since", System.currentTimeMillis() / 1000.0)) }
                else { working.update { it - c }; drafts.update { it - c } }
            }
            "approval" -> e.optJSONObject("approval")?.let { mergeCards(listOf(Card.of(it))) }
            // Frames were dropped on the way. A stream that syncs sends `hello` with the catch-up next.
            "resync" -> return !streamSyncs
        }
        return false
    }

    private fun advance(e: JSONObject) { if (e.has("cursor")) cursor = maxOf(cursor, e.optLong("cursor")) }

    // A row older than the one held (a frame that waited behind a catch-up) changes nothing.
    private fun putChat(c: Chat) = chats.update { all -> if ((all[c.id]?.updated ?: 0.0) > c.updated) all else all + (c.id to c) }

    private fun setWorking(a: JSONArray) {
        val now = objs(a).associate { it.str("chat_id") to it.optDouble("since", 0.0) }
        working.value = now
        drafts.update { d -> d.filterKeys { it in now } }
    }

    @Synchronized fun mergeMsgs(list: List<Msg>) {
        if (list.isEmpty()) return
        msgs.update { all ->
            val out = all.toMutableMap()
            for ((chat, ms) in list.groupBy { it.chatId }) {
                val byId = LinkedHashMap<String, Msg>()
                out[chat]?.forEach { byId[it.id] = it }
                for (m in ms) if (m.kind == "deleted") byId.remove(m.id) else byId[m.id] = m
                out[chat] = byId.values.sortedBy { it.ts }
            }
            out
        }
        // A finished reply replaces its streamed draft.
        list.filter { it.role == "agent" && it.kind == "text" }.map { it.chatId }.toSet().forEach { c -> drafts.update { it - c } }
    }

    /**
     * A chat's newest page, read whole (GET /v1/chats/:id/messages?paged=1,
     * opening it): it replaces what is held for the chat. What arrived live
     * after the page's newest message stays, unless the page marks it as not
     * on the shown branch.
     */
    @Synchronized fun page(chat: String, o: JSONObject) {
        val list = objs(o.optJSONArray("messages") ?: JSONArray()).map(Msg::of)
        val olderId = o.str("older").takeIf { it.isNotBlank() }
        val shown = list.filter { it.kind != "deleted" }
        val gone = list.filter { it.kind == "deleted" }.map { it.id }.toSet()
        val newest = shown.maxOfOrNull { it.ts } ?: Double.NEGATIVE_INFINITY
        val ids = shown.map { it.id }.toSet()
        val later = msgs.value[chat].orEmpty().filter { it.ts > newest && it.id !in ids && it.id !in gone }
        msgs.update { it + (chat to (shown + later).sortedBy { m -> m.ts }) }
        older.update { it + (chat to olderId) }
    }

    /** The chat shows another branch now: nothing held for it stays, also what arrived live on the branch it left. */
    private fun branch(chat: String, list: List<Msg>, olderId: String?) {
        msgs.update { it + (chat to list.filter { m -> m.kind != "deleted" }.sortedBy { m -> m.ts }) }
        older.update { it + (chat to olderId) }
    }

    /** The page before the oldest one held (the same request with `before`). */
    @Synchronized fun olderPage(chat: String, o: JSONObject) {
        mergeMsgs(objs(o.optJSONArray("messages") ?: JSONArray()).map(Msg::of))
        older.update { it + (chat to o.str("older").takeIf { s -> s.isNotBlank() }) }
    }

    /** The daemon's answer to a prompt: the message it stored, or the one a retried send already was. */
    fun sent(o: JSONObject) { o.optJSONObject("message")?.let { mergeMsgs(listOf(Msg.of(it))) } }

    /** The daemon's answer to a card: the card as it stands now. */
    fun resolved(o: JSONObject): Card? = o.optJSONObject("approval")?.let(Card::of)?.also { mergeCards(listOf(it)) }

    /** A card that closed stays closed: an older frame that still calls it pending changes nothing. */
    @Synchronized fun mergeCards(list: List<Card>, replacePending: Boolean = false) {
        val before = cards.value
        val fresh = list.filter { !(it.pending && before[it.id]?.pending == false) }
        cards.update { all ->
            val base = if (replacePending) all.filterValues { !it.pending } else all
            base + fresh.associateBy { it.id }
        }
        fresh.filter { it.pending && before[it.id]?.pending != true }.forEach { c -> onCard?.invoke(c) }
    }

    private fun objs(a: JSONArray) = (0 until a.length()).mapNotNull { a.optJSONObject(it) }
}
