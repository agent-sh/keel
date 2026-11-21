// The connection that keeps the app level with the daemon: the event stream,
// opened from the cursor, and the requests the screens make. The stream runs
// while the app is in front; push (or the periodic check) covers the rest.
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
    /** What the app holds of the daemon (Feed.kt). */
    private val feed = Feed()
    val chats get() = feed.chats
    val msgs get() = feed.msgs
    val older get() = feed.older
    val cards get() = feed.cards
    val working get() = feed.working
    val drafts get() = feed.drafts
    val synced get() = feed.synced
    val reloads get() = feed.reloads
    val conn = MutableStateFlow(Conn.OFF)
    val note = MutableStateFlow("")
    private var live: Job? = null
    private var catching: Job? = null
    private val kick = Channel<Unit>(Channel.CONFLATED)

    fun start() {
        if (!Prefs.paired || live?.isActive == true) return
        live = scope.launch { loop() }
    }
    fun stop() { live?.cancel(); live = null; if (conn.value != Conn.REVOKED) conn.value = Conn.OFF }
    /** The network came back or the app came to the front: retry now. */
    fun nudge() { kick.trySend(Unit) }

    fun reset() {
        stop(); feed.clear()
        note.value = ""; conn.value = Conn.OFF
    }

    // The stream opens from the cursor and brings what was missed with it
    // (`hello` with `sync`), so there is no second request to race the live
    // frames. When it ends, for any reason, the next one starts from the cursor.
    private suspend fun loop() {
        var wait = 500L
        while (scope.isActive && Prefs.paired) {
            if (conn.value != Conn.LIVE) conn.value = if (synced.value) Conn.RETRYING else Conn.CONNECTING
            try {
                stream { wait = 500L }
            } catch (e: CancellationException) { throw e } catch (e: ApiError) {
                if (e.code == 401) { conn.value = Conn.REVOKED; note.value = "This phone is no longer paired with the daemon."; return }
                note.value = e.message ?: "The daemon refused the request"
            } catch (e: Exception) {
                note.value = e.message ?: e.javaClass.simpleName
            } finally {
                catching?.cancel()
                feed.closed()
            }
            conn.value = Conn.RETRYING
            withTimeoutOrNull(wait) { kick.receive() }
            wait = (wait * 2).coerceAtMost(4000L)
        }
    }

    private suspend fun stream(opened: () -> Unit) = suspendCancellableCoroutine<Unit> { k ->
        val req = Api.request("/v1/events?since=${feed.cursor}").header("Accept", "text/event-stream").build()
        val src = EventSources.createFactory(Api.sse).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) { conn.value = Conn.LIVE; opened() }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                val e = runCatching { JSONObject(data) }.getOrNull() ?: return
                val ask = runCatching { feed.frame(e) }.getOrDefault(false)
                if (e.optJSONObject("sync") != null) note.value = ""
                if (ask) catchUp(eventSource)
            }
            override fun onClosed(eventSource: EventSource) { if (k.isActive) k.resume(Unit) }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val e = if (response != null && !response.isSuccessful) ApiError(response.code, "The event stream was refused (HTTP ${response.code})") else t ?: Exception("The event stream closed")
                if (k.isActive) k.resumeWithException(e)
            }
        })
        k.invokeOnCancellation { src.cancel() }
    }

    // A daemon that sends no catch-up with its stream: fetch it. The feed holds
    // the live frames until it is in, then applies them on top. A catch-up that
    // fails closes the stream; the next one starts from the same cursor.
    private fun catchUp(src: EventSource) {
        catching = scope.launch {
            try {
                do {
                    do { val more = feed.sync(Api.get("/v1/sync?since=${feed.cursor}")) } while (more)
                    note.value = ""
                } while (feed.end())
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                note.value = e.message ?: e.javaClass.simpleName
                src.cancel()
            }
        }
    }

    private fun objs(a: JSONArray) = (0 until a.length()).mapNotNull { a.optJSONObject(it) }

    // --- actions -------------------------------------------------------------------

    suspend fun open(chat: String) {
        val o = Api.get("/v1/chats/${Uri.encode(chat)}/messages?paged=1&limit=150")
        feed.page(chat, objs(o.optJSONArray("messages") ?: JSONArray()).map(Msg::of), o.str("older").takeIf { s -> s.isNotBlank() })
        runCatching { Api.post("/v1/chats/${Uri.encode(chat)}/read") }
        chats.update { m -> m[chat]?.let { m + (chat to it.copy(unread = 0)) } ?: m }
    }

    suspend fun loadOlder(chat: String) {
        val before = older.value[chat] ?: return
        val o = Api.get("/v1/chats/${Uri.encode(chat)}/messages?paged=1&limit=150&before=${Uri.encode(before)}")
        feed.mergeMsgs(objs(o.optJSONArray("messages") ?: JSONArray()).map(Msg::of))
        older.update { it + (chat to o.str("older").takeIf { s -> s.isNotBlank() }) }
    }

    /** mode: send, steer or queue. clientId names the send: a retry under it stores no second prompt. */
    suspend fun send(chat: String, text: String, mode: String, clientId: String) {
        val o = Api.post("/v1/chats/${Uri.encode(chat)}/messages", Wire.sendBody(text, mode, clientId))
        o.optJSONObject("message")?.let { feed.mergeMsgs(listOf(Msg.of(it))) }
    }

    suspend fun stopTurn(chat: String) { Api.post("/v1/chats/${Uri.encode(chat)}/stop") }

    suspend fun newChat(): String {
        val c = Chat.of(Api.post("/v1/chats", JSONObject()).getJSONObject("chat"))
        chats.update { it + (c.id to c) }
        return c.id
    }

    suspend fun resolve(aid: String, body: JSONObject, headers: Map<String, String>): Card? {
        val o = Api.post("/v1/approvals/${Uri.encode(aid)}", body, headers)
        return o.optJSONObject("approval")?.let(Card::of)?.also { feed.mergeCards(listOf(it)) }
    }

    suspend fun me(): JSONObject = Api.get("/v1/me")
    suspend fun pulse(): JSONObject = Api.get("/v1/pulse")
    suspend fun usage(chat: String): JSONObject = Api.get("/v1/chats/${Uri.encode(chat)}/usage")
}
