// What the app knows of the daemon, kept live: a sync from the global cursor,
// then the event stream. The stream runs while the app is in front; push (or
// the periodic check) covers the rest.
package dev.avifenesh.keel

import android.net.Uri
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

enum class Conn { OFF, CONNECTING, LIVE, RETRYING, REVOKED }

object Hub {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val chats = MutableStateFlow<Map<String, Chat>>(emptyMap())
    val msgs = MutableStateFlow<Map<String, List<Msg>>>(emptyMap())
    val older = MutableStateFlow<Map<String, String?>>(emptyMap())
    val cards = MutableStateFlow<Map<String, Card>>(emptyMap())
    val working = MutableStateFlow<Map<String, Double>>(emptyMap())
    val drafts = MutableStateFlow<Map<String, String>>(emptyMap())
    val conn = MutableStateFlow(Conn.OFF)
    val note = MutableStateFlow("")
    val synced = MutableStateFlow(false)
    @Volatile private var seq = 0L
    private var live: Job? = null
    private val kick = Channel<Unit>(Channel.CONFLATED)
    /** Called with each card that opens while the app is not in front. */
    var onCard: ((Card) -> Unit)? = null

    fun start() {
        if (!Prefs.paired || live?.isActive == true) return
        live = scope.launch { loop() }
    }
    fun stop() { live?.cancel(); live = null; if (conn.value != Conn.REVOKED) conn.value = Conn.OFF }
    /** The network came back or the app came to the front: retry now. */
    fun nudge() { kick.trySend(Unit) }

    fun reset() {
        stop(); seq = 0
        chats.value = emptyMap(); msgs.value = emptyMap(); older.value = emptyMap(); cards.value = emptyMap()
        working.value = emptyMap(); drafts.value = emptyMap(); synced.value = false; note.value = ""; conn.value = Conn.OFF
    }

    private suspend fun loop() {
        var wait = 500L
        while (scope.isActive && Prefs.paired) {
            if (conn.value != Conn.LIVE) conn.value = if (synced.value) Conn.RETRYING else Conn.CONNECTING
            try {
                sync()
                stream { wait = 500L }
            } catch (e: CancellationException) { throw e } catch (e: ApiError) {
                if (e.code == 401) { conn.value = Conn.REVOKED; note.value = "This phone is no longer paired with the daemon."; return }
                note.value = e.message ?: "The daemon refused the request"
            } catch (e: Exception) {
                note.value = e.message ?: e.javaClass.simpleName
            }
            conn.value = Conn.RETRYING
            withTimeoutOrNull(wait) { kick.receive() }
            wait = (wait * 2).coerceAtMost(4000L)
        }
    }

    suspend fun sync() {
        do {
            val o = Api.get("/v1/sync?since=$seq")
            val first = seq == 0L
            o.optJSONArray("chats")?.let { a ->
                val list = objs(a).map(Chat::of)
                chats.value = if (o.optBoolean("complete")) list.associateBy { it.id } else chats.value + list.associateBy { it.id }
            }
            o.optJSONArray("messages")?.let { mergeMsgs(objs(it).map(Msg::of)) }
            o.optJSONArray("approvals")?.let { a -> mergeCards(objs(a).map(Card::of), replacePending = first) }
            o.optJSONArray("working")?.let { setWorking(it) }
            seq = o.optLong("seq", seq)
        } while (o.optBoolean("more"))
        synced.value = true
        note.value = ""
    }

    private suspend fun stream(opened: () -> Unit) = suspendCancellableCoroutine<Unit> { k ->
        val req = Api.request("/v1/events").header("Accept", "text/event-stream").build()
        val src = EventSources.createFactory(Api.sse).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) { conn.value = Conn.LIVE; opened() }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                runCatching { handle(JSONObject(data)) }
            }
            override fun onClosed(eventSource: EventSource) { if (k.isActive) k.resume(Unit) }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val e = if (response != null && !response.isSuccessful) ApiError(response.code, "The event stream was refused (HTTP ${response.code})") else t ?: Exception("The event stream closed")
                if (k.isActive) k.resumeWithException(e)
            }
        })
        k.invokeOnCancellation { src.cancel() }
    }

    private fun handle(e: JSONObject) {
        when (e.str("type")) {
            "hello", "seq" -> {
                e.optJSONArray("working")?.let { setWorking(it) }
                // Something happened between the sync and the stream opening: fetch it.
                if (e.str("type") == "hello" && e.optLong("seq") > seq) scope.launch { runCatching { sync() } }
            }
            "message" -> {
                e.optJSONObject("chat")?.let { c -> Chat.of(c).let { ch -> chats.update { it + (ch.id to ch) } } }
                e.optJSONObject("message")?.let { m -> mergeMsgs(listOf(Msg.of(m))) }
                e.optLong("seq").takeIf { it > seq }?.let { seq = it }
            }
            "delta" -> { val c = e.str("chat_id"); val d = e.str("delta"); drafts.update { it + (c to (it[c].orEmpty() + d)) } }
            "chat" -> e.optJSONObject("chat")?.let { c -> Chat.of(c).let { ch -> chats.update { it + (ch.id to ch) } } }
            "chat_removed" -> { val c = e.str("chat_id"); chats.update { it - c }; msgs.update { it - c } }
            "working" -> {
                val c = e.str("chat_id")
                if (e.optBoolean("working")) working.update { it + (c to e.optDouble("since", System.currentTimeMillis() / 1000.0)) }
                else { working.update { it - c }; drafts.update { it - c } }
            }
            "approval" -> e.optJSONObject("approval")?.let { mergeCards(listOf(Card.of(it))) }
            "resync" -> nudge()
        }
    }

    private fun setWorking(a: JSONArray) {
        val now = objs(a).associate { it.str("chat_id") to it.optDouble("since", 0.0) }
        working.value = now
        drafts.update { d -> d.filterKeys { it in now } }
    }

    fun mergeMsgs(list: List<Msg>) {
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

    fun mergeCards(list: List<Card>, replacePending: Boolean = false) {
        val before = cards.value
        cards.update { all ->
            val base = if (replacePending) all.filterValues { !it.pending } else all
            base + list.associateBy { it.id }
        }
        list.filter { it.pending && before[it.id]?.pending != true }.forEach { c -> onCard?.invoke(c) }
    }

    private fun objs(a: JSONArray) = (0 until a.length()).mapNotNull { a.optJSONObject(it) }

    // --- actions -------------------------------------------------------------------

    suspend fun open(chat: String) {
        val o = Api.get("/v1/chats/${Uri.encode(chat)}/messages?paged=1&limit=150")
        val list = objs(o.optJSONArray("messages") ?: JSONArray()).map(Msg::of)
        msgs.update { it + (chat to list.filter { m -> m.kind != "deleted" }.sortedBy { m -> m.ts }) }
        older.update { it + (chat to o.str("older").takeIf { s -> s.isNotBlank() }) }
        runCatching { Api.post("/v1/chats/${Uri.encode(chat)}/read") }
        chats.update { m -> m[chat]?.let { m + (chat to it.copy(unread = 0)) } ?: m }
    }

    suspend fun loadOlder(chat: String) {
        val before = older.value[chat] ?: return
        val o = Api.get("/v1/chats/${Uri.encode(chat)}/messages?paged=1&limit=150&before=${Uri.encode(before)}")
        mergeMsgs(objs(o.optJSONArray("messages") ?: JSONArray()).map(Msg::of))
        older.update { it + (chat to o.str("older").takeIf { s -> s.isNotBlank() }) }
    }

    /** mode: send, steer or queue. clientId names the send: a retry under it stores no second prompt. */
    suspend fun send(chat: String, text: String, mode: String, clientId: String) {
        val o = Api.post("/v1/chats/${Uri.encode(chat)}/messages", Wire.sendBody(text, mode, clientId))
        o.optJSONObject("message")?.let { mergeMsgs(listOf(Msg.of(it))) }
    }

    suspend fun stopTurn(chat: String) { Api.post("/v1/chats/${Uri.encode(chat)}/stop") }

    suspend fun newChat(): String {
        val c = Chat.of(Api.post("/v1/chats", JSONObject()).getJSONObject("chat"))
        chats.update { it + (c.id to c) }
        return c.id
    }

    suspend fun resolve(aid: String, body: JSONObject, headers: Map<String, String>): Card? {
        val o = Api.post("/v1/approvals/${Uri.encode(aid)}", body, headers)
        return o.optJSONObject("approval")?.let(Card::of)?.also { mergeCards(listOf(it)) }
    }

    suspend fun me(): JSONObject = Api.get("/v1/me")
    suspend fun pulse(): JSONObject = Api.get("/v1/pulse")
    suspend fun usage(chat: String): JSONObject = Api.get("/v1/chats/${Uri.encode(chat)}/usage")
}
