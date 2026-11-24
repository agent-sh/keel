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
    // Why this app closed the stream itself (a frame it could not apply): shown while it reconnects.
    @Volatile private var broke: String? = null
    private val kick = Channel<Unit>(Channel.CONFLATED)
    /** When the phone was last level with the computer (ms, 0: never): said while it is not. */
    val levelAt = MutableStateFlow(0L)
    // The last sync kept on the phone (Cache): read once into an empty feed, written a few seconds after
    // what is held changed, and when the app goes to the back.
    @Volatile private var restored = false
    @Volatile private var dirty = false
    private var saver: Job? = null

    /** The kept last sync, shown at once on a cold start; the stream then opens from its cursor. */
    fun restore() {
        if (restored || !Prefs.paired) return
        restored = true
        levelAt.value = Prefs.levelAt
        runCatching { Cache.load()?.let { feed.restore(it) } }
    }

    /** What is held now, kept for the next cold start. */
    fun keep() {
        if (!dirty) return
        dirty = false
        runCatching { feed.snapshot()?.let { Cache.save(it); Prefs.levelAt = levelAt.value } }
    }
    private fun changed() {
        dirty = true
        levelAt.value = System.currentTimeMillis()
        if (saver?.isActive == true) return
        saver = scope.launch { kotlinx.coroutines.delay(5_000); keep() }
    }

    fun start() {
        if (!Prefs.paired || live?.isActive == true) return
        live = scope.launch { restore(); loop() }
    }
    fun stop() {
        live?.cancel(); live = null; if (conn.value != Conn.REVOKED) conn.value = Conn.OFF
        scope.launch { keep() }
    }
    /** The network came back or the app came to the front: retry now. */
    fun nudge() { kick.trySend(Unit) }

    fun reset() {
        live?.cancel(); live = null; saver?.cancel(); dirty = false
        feed.clear(); runCatching { Cache.clear() }; levelAt.value = 0L; away.value = null; landings.value = null
        note.value = ""; conn.value = Conn.OFF
    }

    // The stream opens from the cursor and brings what was missed with it
    // (`hello` with `sync`), so there is no second request to race the live
    // frames. When it ends, for any reason, the next one starts from the cursor.
    private suspend fun loop() {
        var wait = 500L
        while (scope.isActive && Prefs.paired) {
            if (conn.value != Conn.LIVE) conn.value = if (synced.value) Conn.RETRYING else Conn.CONNECTING
            broke = null
            try {
                stream { wait = 500L }
            } catch (e: CancellationException) { throw e } catch (e: ApiError) {
                if (e.code == 401) { conn.value = Conn.REVOKED; note.value = "This phone is no longer paired with the daemon."; return }
                note.value = e.message ?: "The daemon refused the request"
            } catch (e: Exception) {
                note.value = broke ?: reach(e)
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
        // With what the phone holds (a digest per bucket of rows): the catch-up sends only the buckets that changed.
        val held = feed.held()?.let { "&held=$it" }.orEmpty()
        val req = Api.request("/v1/events?since=${feed.cursor}$held").header("Accept", "text/event-stream").build()
        val src = EventSources.createFactory(Api.sse).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) { conn.value = Conn.LIVE; opened() }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                when (val step = feed.take(data)) {
                    is Took.Applied -> { if (step.synced) { note.value = ""; readAway(); readErrors() }; changed() }
                    is Took.CatchUp -> catchUp(eventSource)
                    // What the frame carried was not applied: the stream ends here and the next one opens from the cursor.
                    is Took.Broken -> { broke = step.reason; note.value = step.reason; eventSource.cancel() }
                }
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
                var step: Took
                do {
                    do { val more = feed.sync(Api.get("/v1/sync?since=${feed.cursor}")) } while (more)
                    note.value = ""
                    step = feed.end()
                } while (step is Took.CatchUp)
                if (step is Took.Broken) { broke = step.reason; note.value = step.reason; src.cancel() }
            } catch (e: CancellationException) { throw e } catch (e: Exception) {
                note.value = reach(e)
                src.cancel()
            }
        }
    }

    // --- actions -------------------------------------------------------------------

    suspend fun open(chat: String) {
        // A branch picked on the computer while the page is on its way makes the page one of the branch that was left.
        val asked = feed.generation(chat)
        feed.page(chat, Api.get("/v1/chats/${Uri.encode(chat)}/messages?paged=1&limit=150"), asked)
        runCatching { Api.post("/v1/chats/${Uri.encode(chat)}/read") }
        feed.read(chat)
    }

    suspend fun loadOlder(chat: String) {
        val before = older.value[chat] ?: return
        val asked = feed.generation(chat)
        feed.olderPage(chat, Api.get("/v1/chats/${Uri.encode(chat)}/messages?paged=1&limit=150&before=${Uri.encode(before)}"), asked)
    }

    /** mode: send, steer or queue. clientId names the send: a retry under it stores no second prompt. files: uploads it carries. */
    suspend fun send(chat: String, text: String, mode: String, clientId: String, files: List<Upload> = emptyList()) {
        feed.sent(Api.post("/v1/chats/${Uri.encode(chat)}/messages", Wire.sendBody(text, mode, clientId, files)))
    }

    suspend fun stopTurn(chat: String) { Api.post("/v1/chats/${Uri.encode(chat)}/stop") }

    suspend fun newChat(n: NewChat = NewChat()): String {
        return feed.created(Api.post("/v1/chats", n.body())).id
    }
    /** What happened while the owner was away: read each time the phone is level with the computer again. */
    val away = MutableStateFlow<Away?>(null)
    private fun readAway() { scope.launch { runCatching { Away.of(Api.get("/v1/away")) }.onSuccess { away.value = it } } }
    /** The owner has seen the digest: it goes here and on the page. */
    fun seenAway() { away.value = null; scope.launch { runCatching { Api.delete("/v1/away") } } }
    /** The owner touched the app `idleMs` ago: the end of an absence, as a page in use says. */
    suspend fun present(idleMs: Long) { Api.post("/v1/presence", JSONObject().put("idle_ms", idleMs)) }
    /** The daemon's open errors (the page's Errors panel): read when the phone is level, kept from the stream's frames after. */
    val errors get() = feed.errors
    fun readErrors() { scope.launch { runCatching { errorList() } } }
    suspend fun errorList(): ErrorList = ErrorList.of(Api.get("/v1/errors")).also { errors.value = it }
    /** Read (out of the count), unread again, or resolved (off the list), on the page too. */
    suspend fun markError(id: String, action: String) {
        val row = ErrorList.row(Api.post("/v1/errors/${Uri.encode(id)}/$action"))
        // One the store never took is let go when read or resolved: it leaves the list.
        errors.value = errors.value?.marked(id, if (action == "resolve" || id.startsWith("unwritten-")) null else row)
    }
    /** Every open one shown, read at once (the page's Mark all read): the list as the daemon has it after. */
    suspend fun readAllErrors(ids: List<String>) {
        errors.value = ErrorList.of(Api.post("/v1/errors/read-all", JSONObject().put("ids", org.json.JSONArray(ids))))
    }
    /** Branches that wait to land, ready first (the work board's facts, one card each). */
    val landings = MutableStateFlow<List<LandCard>?>(null)
    suspend fun readLandings(): List<LandCard> = LandCard.list(Api.get("/v1/landings")).also { landings.value = it }
    fun readLandingsSoon() { scope.launch { runCatching { readLandings() } } }
    /** Land it, signed (`headers`): the entry the queue made, or the refusal with the card as it is now. */
    suspend fun land(card: LandCard, headers: Map<String, String>): LandOutcome =
        decide(card) { Api.post("/v1/landings/${Uri.encode(card.key)}/land", JSONObject().put("fp", card.fp), headers) }
    /** Give it back to its agent with the owner's words. */
    suspend fun sendBack(card: LandCard, text: String): LandOutcome =
        decide(card) { Api.post("/v1/landings/${Uri.encode(card.key)}/back", JSONObject().put("fp", card.fp).put("text", text)) }
    // A refusal over the card's facts (409) carries the card as it is now: it is an outcome, not a failure.
    private suspend fun decide(card: LandCard, ask: suspend () -> JSONObject): LandOutcome {
        val o = try { LandOutcome.of(ask()) } catch (e: ApiError) {
            if (e.code != 409) throw e
            LandOutcome.refused(runCatching { JSONObject(e.body) }.getOrElse { JSONObject().put("error", e.message) })
        }
        return o.also { settle(card, it) }
    }
    // A decided card leaves the list; a refused one is shown as it is now (or leaves, when it is gone).
    private fun settle(card: LandCard, o: LandOutcome) {
        landings.value = landings.value?.let { l -> if (o.ok || o.card == null) l.filter { it.key != card.key } else l.map { if (it.key == card.key) o.card else it } }
    }
    suspend fun search(q: String): SearchResult = SearchResult.of(Api.get("/v1/search?q=${Wire.enc(q)}"))
    suspend fun startOffer(): Start = Start.of(Api.get("/v1/start"))

    suspend fun resolve(aid: String, body: JSONObject, headers: Map<String, String>): Card? {
        return feed.resolved(Api.post("/v1/approvals/${Uri.encode(aid)}", body, headers))
    }

    suspend fun me(): Me = Me.of(Api.get("/v1/me"))
    suspend fun changes(chat: String): Changes = Changes.of(Api.get("/v1/chats/${Uri.encode(chat)}/changes"))
    /** One file's diff, of one turn or (turn null) since the session's first. */
    suspend fun fileDiff(chat: String, path: String, turn: Long?): FileDiff =
        FileDiff.of(Api.get("/v1/chats/${Uri.encode(chat)}/changes/diff?path=${Wire.enc(path)}${turn?.let { "&turn=$it" }.orEmpty()}"))
    suspend fun pulse(): Pulse = Pulse.of(Api.get("/v1/pulse"))
    /** The owner's helper: its state, turned on or off, its memory (all, or found by words), one record forgotten. */
    suspend fun helper(): HelperView = HelperView.of(Api.get("/v1/helper"))
    suspend fun setHelper(on: Boolean): HelperView = HelperView.of(Api.patch("/v1/helper", JSONObject().put("on", on)))
    suspend fun memory(q: String = ""): MemoryList = MemoryList.of(Api.get("/v1/helper/memory${if (q.isBlank()) "" else "?q=${Wire.enc(q)}"}"))
    suspend fun forget(key: String) { Api.delete("/v1/helper/memory/${Uri.encode(key)}") }
    suspend fun usage(chat: String): String = usageLine(Api.get("/v1/chats/${Uri.encode(chat)}/usage"))
}
