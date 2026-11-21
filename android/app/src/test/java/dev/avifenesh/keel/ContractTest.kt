package dev.avifenesh.keel

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The app against the wire contract (src/integrations/mobile/contract/wire.json,
// on the test classpath as /wire.json). The daemon's tests check the daemon
// against the same file: the bytes that are signed, the fields of every answer
// and frame, the bodies the app sends. A field renamed on either side, or a
// changed signed byte, fails one of the two.
class ContractTest {
    private val wire = JSONObject(javaClass.getResourceAsStream("/wire.json")!!.readBytes().toString(Charsets.UTF_8))
    private val fields = wire.getJSONObject("fields")
    private fun examples(shape: String): List<JSONObject> = wire.getJSONObject("examples").getJSONArray(shape).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    private fun copy(o: JSONObject) = JSONObject(o.toString())

    // --- signing -----------------------------------------------------------------

    @Test fun theAppSignsTheBytesTheDaemonVerifies() {
        val signing = wire.getJSONObject("signing")
        val requests = signing.getJSONArray("request")
        for (i in 0 until requests.length()) {
            val r = requests.getJSONObject(i)
            val sha = Wire.sha256Hex(r.getString("body").toByteArray())
            assertEquals(r.getString("body_sha256"), sha)
            assertEquals(r.getString("canonical"), Wire.canonical(r.getString("method"), r.getString("path"), if (r.isNull("query")) null else r.getString("query"), r.getString("ts"), sha))
        }
        val approvals = signing.getJSONArray("approval")
        for (i in 0 until approvals.length()) {
            val a = approvals.getJSONObject(i)
            val text = a.optJSONObject("answers")?.let { Wire.answersText(answersOf(it)) }.orEmpty()
            assertEquals(a.getString("answers_text"), text)
            assertEquals(a.getString("message"), Wire.approvalMessage(a.getString("id"), a.getString("choice"), a.getString("ts"), text))
        }
    }

    /** Answers by question id as the card screen holds them: one label, or a list of them. */
    private fun answersOf(o: JSONObject): Map<String, Any> = o.keys().asSequence().associateWith { k ->
        o.optJSONArray(k)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: o.getString(k)
    }

    // --- what the app sends --------------------------------------------------------

    @Test fun theAppSendsTheBodiesOfTheContract() {
        // The app sends words only; a prompt that names uploads is the daemon's side of the contract until the app attaches.
        for (send in examples("send").filter { !it.has("attachments") }) {
            assertEquals(canon(send), canon(Wire.sendBody(send.getString("text"), send.getString("mode"), send.getString("client_id"))))
        }
        for (answer in examples("answer")) {
            assertEquals(canon(answer), canon(Wire.answerBody(answer.getString("choice"), answer.optJSONObject("answers")?.let(::answersOf))))
        }
    }

    /** JSON with its keys in order, so two bodies with the same content read the same. */
    private fun canon(v: Any?): String = when (v) {
        is JSONObject -> v.keys().asSequence().sorted().joinToString(",", "{", "}") { "${Wire.jsString(it)}:${canon(v.get(it))}" }
        is JSONArray -> (0 until v.length()).joinToString(",", "[", "]") { canon(v.get(it)) }
        is String -> Wire.jsString(v)
        else -> v.toString()
    }

    // --- what the app reads ----------------------------------------------------------

    private val hello = examples("hello").first()
    /** A phone level with the `hello` example. */
    private fun level() = Feed().also { it.frame(copy(hello)) }
    /** A phone that was level some time ago and holds a chat the daemon no longer has. */
    private fun stale() = Feed().also { it.sync(JSONObject().put("seq", 5).put("chats", JSONArray().put(JSONObject().put("id", "gone")))) }
    private fun state(f: Feed) = listOf(f.cursor, f.chats.value, f.msgs.value, f.older.value, f.cards.value, f.working.value, f.drafts.value, f.synced.value, f.reloads.value).toString()
    private fun framed(o: JSONObject) = state(level().also { it.frame(o) })

    /** What the app makes of one value of a shape, as text: two values the app reads alike give the same text. */
    private val reads: Map<String, (JSONObject) -> String> = mapOf(
        "chat" to { o -> Chat.of(o).toString() },
        "message" to { o -> Msg.of(o).toString() },
        "step" to { o -> Msg.of(JSONObject().put("meta", JSONObject().put("steps", JSONArray().put(o)))).steps.toString() },
        "attachment" to { o -> Msg.of(JSONObject().put("meta", JSONObject().put("attachments", JSONArray().put(o)))).attachments.toString() },
        "card" to { o -> Card.of(o).toString() },
        "question" to { o -> Card.of(JSONObject().put("questions", JSONArray().put(o))).questions.toString() },
        "picked" to { o -> Card.of(JSONObject().put("answers", JSONObject().put("q", o))).answers.toString() },
        "sync" to { o -> stale().let { f -> val more = f.sync(o); state(f) + " more=$more" } },
        "reset" to { o -> state(level().also { it.sync(copy(examples("sync")[1]).put("reset", JSONArray().put(o))) }) },
        "working_row" to { o -> framed(copy(examples("seq").first()).put("working", JSONArray().put(o))) },
        "draft" to { o -> state(Feed().also { it.sync(copy(examples("sync").first()).put("drafts", JSONArray().put(o))) }) },
        "page" to { o -> state(Feed().also { it.page("s-1", o) }) },
        "receipt" to { o -> state(level().also { it.sent(o) }) },
        "resolved" to { o -> state(level().also { it.resolved(o) }) },
        "created" to { o -> runCatching { state(level().also { it.created(o) }) }.getOrElse { "no session was made" } },
        "pulse" to { o -> Pulse.of(o).toString() },
        "pulse_session" to { o -> Pulse.of(JSONObject().put("live_sessions", JSONArray().put(o))).sessions.toString() },
        "usage" to ::usageLine,
        "usage_session" to { o -> usageLine(JSONObject().put("session", o)) },
        "me" to { o -> Me.of(o).toString() },
        "push_config" to { o -> PushConfig.of(o).toString() },
        "paired" to { o -> Paired.of(o).toString() },
        "revoked" to { o -> unpaired(o, null, null, "desk").toString() },
        "error" to { o -> errorOf(o.toString()) },
        "push" to { o -> PushMsg.of(o.keys().asSequence().associateWith { k -> o.get(k).toString() }).toString() },
        "hello" to { o -> state(Feed().also { it.frame(o) }) },
        "message_frame" to ::framed, "chat_frame" to ::framed, "chat_reset" to ::framed, "chat_removed" to ::framed,
        "working" to ::framed, "delta" to ::framed, "approval" to ::framed, "seq" to ::framed,
    )

    private fun has(o: JSONObject, path: String): Boolean {
        var at = o
        val keys = path.split('.')
        for (k in keys.dropLast(1)) at = at.optJSONObject(k) ?: return false
        return at.has(keys.last())
    }
    private fun without(o: JSONObject, path: String): JSONObject = copy(o).also {
        var at = it
        val keys = path.split('.')
        for (k in keys.dropLast(1)) at = at.getJSONObject(k)
        at.remove(keys.last())
    }

    @Test fun theAppReadsEveryFieldOfTheContractUnderItsName() {
        // Every shape the daemon sends has a reader here; `send` and `answer` are what the app sends.
        // `send` and `answer` are what the app sends; `upload` and `upload_ref` wait for the app to attach files.
        assertEquals(fields.keys().asSequence().toSet() - setOf("send", "answer", "upload", "upload_ref"), reads.keys)
        for ((shape, read) in reads) for (path in fields.getJSONObject(shape).keys()) {
            // Without the field, the app must make something else of at least one example that has it.
            val read1 = examples(shape).any { ex -> has(ex, path) && read(copy(ex)) != read(without(ex, path)) }
            assertTrue("$shape.$path is in the contract, but the app reads nothing under that name", read1)
        }
    }

    // --- the other direction: the app reads nothing the contract does not name -----------

    /** A JSON read with the field's name written out, and a read of a push's data. */
    private val jsonRead = Regex("""\.(?:str|optString|optJSONObject|optJSONArray|optBoolean|optInt|optLong|optDouble|isNull|has)\(\s*"([^"]+)"""")
    // A JSON get takes the name alone (a preference read takes a default beside it).
    private val jsonGet = Regex("""\.(?:getString|getJSONObject|getJSONArray|getBoolean|getInt|getLong|getDouble)\(\s*"([^"]+)"\s*\)""")
    private val pushRead = Regex("""\bd\["([^"]+)"\]""")

    @Test fun theAppReadsNoFieldTheContractDoesNotName() {
        // Every name the contract gives a field, at any depth of any shape.
        val named = fields.keys().asSequence().flatMap { shape -> fields.getJSONObject(shape).keys().asSequence().flatMap { it.split('.') } }.toSet()
        // The app's sources (the test runs in the app module's folder).
        val sources = java.io.File("src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue("the app's sources were not found from ${java.io.File(".").absolutePath}", sources.any { it.name == "Wire.kt" } && sources.any { it.name == "Feed.kt" })
        for (file in sources) {
            val text = file.readText()
            val read = (jsonRead.findAll(text) + jsonGet.findAll(text) + pushRead.findAll(text)).map { it.groupValues[1] }.toSet()
            if (file.name == "Wire.kt" || file.name == "Feed.kt") {
                assertEquals("${file.name} reads fields of the daemon's that no shape of the contract names", emptySet<String>(), read - named)
            } else {
                // Elsewhere nothing of the daemon's is read as JSON: a screen takes the values Wire.kt and Feed.kt made.
                assertEquals("${file.name} reads JSON fields itself; the daemon's answers are read in Wire.kt and Feed.kt", emptySet<String>(), read)
            }
        }
    }

    /** The same value with a field the app has never heard of in every object (not in `answers`: its keys are question ids). */
    private fun withUnknown(v: Any?): Any? = when (v) {
        is JSONObject -> JSONObject().also { out ->
            for (k in v.keys()) out.put(k, if (k == "answers") v.get(k) else withUnknown(v.get(k)))
            out.put("added_later", JSONObject().put("n", 1))
        }
        is JSONArray -> JSONArray().also { out -> for (i in 0 until v.length()) out.put(withUnknown(v.get(i))) }
        else -> v
    }

    @Test fun aFieldTheAppDoesNotKnowChangesNothing() {
        for ((shape, read) in reads) for (ex in examples(shape)) {
            // A missing `since` reads the clock; every example of `working` has it, so the two reads are of the same value.
            assertEquals("$shape with an added field", read(copy(ex)), read(withUnknown(ex) as JSONObject))
        }
    }

    @Test fun theFirstFrameOfTheStreamMakesThePhoneLevel() {
        val f = level()
        assertEquals(42L, f.cursor)
        val chat = f.chats.value.getValue("s-1")
        assertEquals(listOf("Fix the build", "failed", "HTTP 402: no credit", "s-parent"), listOf(chat.title, chat.status, chat.failure, chat.parentId))
        assertEquals(listOf("e-1", "e-2", "e-2.tools", "e-3", "e-4"), f.msgs.value.getValue("s-1").map { it.id })
        assertEquals(listOf(Step("Bash", "bun test")), f.msgs.value.getValue("s-1")[2].steps)
        assertEquals(setOf("q-call_1", "apr_9"), f.cards.value.filterValues { it.pending }.keys)
        assertEquals(mapOf("s-2" to "Looking at the"), f.drafts.value)
        assertEquals(setOf("s-2"), f.working.value.keys)
    }
}
