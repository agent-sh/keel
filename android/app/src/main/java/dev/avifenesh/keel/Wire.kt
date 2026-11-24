// What the daemon sends and what the app signs, as pure functions: the unit
// tests run them on the JVM without a device.
package dev.avifenesh.keel

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

fun JSONObject.str(k: String, d: String = ""): String = if (isNull(k)) d else optString(k, d)

object Wire {
    fun sha256Hex(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** The request signature's message: METHOD, raw path and query, timestamp, body hash. */
    fun canonical(method: String, path: String, query: String?, ts: String, bodySha: String): String =
        "${method.uppercase()}\n$path${if (query != null) "?$query" else ""}\n$ts\n$bodySha"

    /** The approval key's message, version 2: it binds the answer of a question (empty for a permission). */
    fun approvalMessage(aid: String, choice: String, ts: String, answer: String): String =
        "approve2\n$aid\n$choice\n${sha256Hex(answer.trim().toByteArray())}\n$ts"

    /** What the approval key signs to land a branch: the card's key and the print of what it showed, at a time. */
    fun landMessage(key: String, fp: String, ts: String): String = "land\n$key\n$fp\n$ts"

    /** The answer text the daemon hashes for answers by question id: JSON.stringify of the sorted [id, value] pairs. */
    fun answersText(answers: Map<String, Any>): String = answers.keys.sorted().joinToString(",", "[", "]") { k ->
        val v = answers[k]
        val value = when (v) {
            is List<*> -> v.joinToString(",", "[", "]") { jsString(it.toString()) }
            else -> jsString(v.toString())
        }
        "[${jsString(k)},$value]"
    }

    /** A string as JavaScript's JSON.stringify writes it. */
    fun jsString(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) when (c) {
            '"' -> b.append("\\\""); '\\' -> b.append("\\\\")
            '\b' -> b.append("\\b"); '\u000C' -> b.append("\\f"); '\n' -> b.append("\\n"); '\r' -> b.append("\\r"); '\t' -> b.append("\\t")
            else -> if (c < ' ') b.append("\\u%04x".format(c.code)) else b.append(c)
        }
        return b.append('"').toString()
    }

    /**
     * The id a send goes under. The composer keeps it with the words until the
     * daemon answers, so the same words sent again after a lost answer are the
     * same send (the daemon stores them once); other words are a new send.
     */
    fun sendId(keptId: String, keptText: String, text: String, fresh: () -> String = { java.util.UUID.randomUUID().toString() }): String =
        if (keptId.isNotEmpty() && keptText == text) keptId else fresh()

    /**
     * What makes two sends the same send: the words and the uploads they name, in order (the daemon
     * takes a send id again only for the same words and files). Words alone are their own key.
     */
    fun sendKey(text: String, files: List<Upload>): String = if (files.isEmpty()) text else text + "\u0000" + files.joinToString(",") { it.id }
    /** The upload ids a send key names. */
    fun keyFiles(key: String): Set<String> = key.substringAfter('\u0000', "").split(',').filter { it.isNotEmpty() }.toSet()

    /** A prompt as the daemon takes it (POST /v1/chats/:id/messages). mode: send, steer or queue. files: the uploads it carries. */
    fun sendBody(text: String, mode: String, clientId: String, files: List<Upload> = emptyList()): JSONObject =
        JSONObject().put("text", text).put("mode", mode).put("client_id", clientId).apply {
            if (files.isNotEmpty()) put("attachments", JSONArray().apply {
                for (f in files) put(JSONObject().put("id", f.id).put("mime", f.mime).put("file_name", f.fileName))
            })
        }

    /** A question for the helper from its row (POST /v1/helper/ask): the words, under the phone's id for them. */
    fun askBody(text: String, clientId: String): JSONObject = JSONObject().put("text", text).put("client_id", clientId)

    /** Where a file goes up (POST, its bytes as the body): its name and the type the phone gives it. */
    fun uploadPath(name: String, mime: String): String = "/v1/upload?name=${enc(name.ifBlank { "file" })}&mime=${enc(mime.ifBlank { "application/octet-stream" })}"

    /** A query value as encodeURIComponent writes it: the bytes the request is signed over are the bytes sent. */
    fun enc(v: String): String = java.net.URLEncoder.encode(v, "UTF-8").replace("+", "%20").replace("%7E", "~")
        .replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%2A", "*")

    /**
     * Why a file is not sent, before its bytes are read: it is larger than the daemon takes. Empty
     * when it may go up (an unknown size or limit is the daemon's to judge).
     */
    fun tooLarge(name: String, size: Long?, max: Long?): String =
        if (size == null || max == null || max <= 0 || size <= max) "" else "$name is ${mb(size)}; the computer takes at most ${mb(max)} a file."

    fun mb(b: Long): String = when {
        b >= 1024 * 1024 -> "%.1f MB".format(b / 1048576.0).replace(".0 MB", " MB")
        b >= 1024 -> "${b / 1024} KB"
        else -> "$b bytes"
    }

    /**
     * How a picked photo goes up. A photo larger than the edge the daemon stores at is scaled to it
     * (the daemon would scale it anyway: the pixels past it are bytes on the phone's network for
     * nothing), and one in a type the model does not read (HEIC, AVIF) is written as JPEG, which
     * every model reads. One that says where it was taken (EXIF GPS) is written again at its size, which
     * leaves that out. PNG stays PNG, so a screenshot's text stays sharp. Null: it goes as it is.
     */
    data class Photo(val width: Int, val height: Int, val mime: String)
    fun photoPlan(mime: String, width: Int, height: Int, edge: Int?, inline: List<String>, located: Boolean = false): Photo? {
        if (!mime.startsWith("image/") || width <= 0 || height <= 0) return null
        val readable = mime in inline
        val long = maxOf(width, height)
        val scale = if (edge != null && edge > 0 && long > edge) edge.toDouble() / long else 1.0
        // located: the photo says where it was taken; it is written again, which leaves that out.
        if (readable && scale >= 1.0 && !located) return null
        val out = if (mime == "image/png") "image/png" else "image/jpeg"
        return Photo(maxOf(1, Math.round(width * scale).toInt()), maxOf(1, Math.round(height * scale).toInt()), out)
    }

    /**
     * A picked photo's name. The system photo picker names a photo by its media id (1000000044.jpg),
     * which tells the owner and the model nothing: such a photo is named by when it was taken, on the
     * phone's clock (Photo 2026-11-20 at 14.32.05.jpg). A real name (receipt.png) stays as it is.
     */
    fun pickedName(name: String, mime: String, id: String?, takenMs: Long?, zone: java.time.ZoneId = java.time.ZoneId.systemDefault(), picker: Boolean = false): String {
        if (!byMediaId(name, mime, id, picker) || takenMs == null || takenMs <= 0) return name
        val ext = name.substringAfterLast('.', "").ifBlank { MIME_EXT[mime] ?: mime.substringAfter('/') }
        val at = java.time.Instant.ofEpochMilli(takenMs).atZone(zone)
        return String.format(java.util.Locale.ROOT, "Photo %04d-%02d-%02d at %02d.%02d.%02d.%s", at.year, at.monthValue, at.dayOfMonth, at.hour, at.minute, at.second, ext)
    }
    /**
     * Whether a picked image is named by its media id: named not at all, by the number its URI ends
     * with (content://media/picker/.../media/1000000044 named 1000000044.jpg), or by a number from the
     * photo picker, which names every photo by an id. A real name of digits only from elsewhere
     * (20261120143205.jpg from a camera's folder in Files, 0001.png from a scan) is not, and stays.
     */
    fun byMediaId(name: String, mime: String, id: String?, picker: Boolean = false): Boolean {
        if (!mime.startsWith("image/")) return false
        val base = name.substringBeforeLast('.', name)
        return base.isEmpty() || (!id.isNullOrEmpty() && id.all { it.isDigit() } && base == id) || (picker && base.all { it.isDigit() })
    }
    private val MIME_EXT = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "image/heic" to "heic", "image/heif" to "heif", "image/gif" to "gif", "image/avif" to "avif")

    /** A file's name with the extension its new type has (a HEIC photo written as JPEG is IMG_1.jpg). */
    fun renamed(name: String, mime: String): String {
        val ext = when (mime) { "image/jpeg" -> "jpg"; "image/png" -> "png"; else -> return name }
        val base = name.substringBeforeLast('.', name).ifBlank { "photo" }
        return "$base.$ext"
    }

    /**
     * A card's answer as the daemon takes it (POST /v1/approvals/:id). answers: by question id, one label or a list of them.
     * seen: all of the request's text was on this screen before the answer. The daemon takes an allow of a
     * request that one line does not show whole only with it; a refusal needs none. via: "notification"
     * for an answer given from a notification, which shows one line and so never says seen.
     */
    fun answerBody(choice: String, answers: Map<String, Any>?, seen: Boolean = false, via: String? = null, feedback: String? = null): JSONObject {
        val body = JSONObject().put("choice", choice)
        // A plan sent back carries what to change, when the owner wrote it.
        if (choice == "deny" && !feedback.isNullOrBlank()) body.put("feedback", feedback.trim())
        if (answers != null && choice != "deny") body.put("answers", JSONObject().apply {
            answers.forEach { (k, v) -> put(k, if (v is List<*>) JSONArray(v) else v.toString()) }
        })
        if (seen && choice != "deny" && via != "notification") body.put("seen", "whole")
        if (via != null) body.put("via", via)
        return body
    }

    private val RTL: Set<Character.UnicodeScript> = listOf("HEBREW", "ARABIC", "SYRIAC", "THAANA", "NKO", "SAMARITAN", "MANDAIC", "ADLAM")
        .mapNotNull { runCatching { Character.UnicodeScript.valueOf(it) }.getOrNull() }.toSet()
    private val MARKS = setOf(Character.NON_SPACING_MARK.toInt(), Character.ENCLOSING_MARK.toInt(), Character.COMBINING_SPACING_MARK.toInt())

    /**
     * A request's text with each run of letters written right to left set apart (an isolate around it),
     * so the run reads as it is written and nothing around it changes places: "cp A 1 2 B > C" in Hebrew
     * letters would otherwise show as its mirror. Drawn left to right, the words stand in the order written.
     */
    fun inPlace(text: String): String {
        val b = StringBuilder()
        var open = false
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            val rtl = Character.UnicodeScript.of(cp) in RTL
            if (rtl && !open) { b.append('\u2067'); open = true }
            else if (!rtl && open && Character.getType(cp) !in MARKS) { b.append('\u2069'); open = false }
            b.appendCodePoint(cp)
            i += Character.charCount(cp)
        }
        if (open) b.append('\u2069')
        return b.toString()
    }

    data class PairLink(val base: String, val code: String, val name: String)

    /**
     * A pairing link: keel://pair?u=<base>&c=<code>&n=<name>, or the daemon's own
     * https page /pair?c=<code> (the base is that page's origin).
     */
    fun parsePair(text: String): PairLink? {
        val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
        val q = query(uri.rawQuery)
        val code = q["c"]?.takeIf { it.isNotBlank() } ?: return null
        return when (uri.scheme?.lowercase()) {
            "keel" -> {
                if (uri.host != "pair" && uri.authority != "pair") return null
                val base = q["u"]?.trimEnd('/') ?: return null
                val b = runCatching { URI(base) }.getOrNull() ?: return null
                if (b.scheme !in setOf("https", "http") || b.host.isNullOrBlank()) return null
                PairLink(base, code, q["n"].orEmpty())
            }
            "https", "http" -> {
                if (uri.path?.trimEnd('/') != "/pair" || uri.host.isNullOrBlank()) return null
                val base = "${uri.scheme}://${uri.rawAuthority}"
                PairLink(base, code, uri.host)
            }
            else -> null
        }
    }

    private fun query(raw: String?): Map<String, String> = raw.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
        val i = it.indexOf('=')
        val k = if (i < 0) it else it.substring(0, i)
        val v = if (i < 0) "" else it.substring(i + 1)
        URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
    }
}

/** Where a session stands. */
enum class State(val word: String) { NEEDS("Needs you"), WORKING("Working"), FAILED("Failed"), STOPPED("Stopped"), DONE("Done"), IDLE("Not started") }

data class Chat(
    val id: String, val title: String, val status: String, val updated: Double, val unread: Int,
    val pinned: Boolean, val archived: Boolean, val preview: String, val lastRole: String, val parentId: String?,
    val failure: String = "",
    /** When it was made: an agent's place among its siblings. */
    val created: Double = 0.0,
    /** The agents at work below it, at any depth. */
    val agents: Int = 0,
    /** Its state in the workbench's own words ("Waiting for a timer"), when the daemon says it. */
    val stateWord: String = "",
    /** The daemon's mark of this row's content: a reconnect says what it holds by these, and only what changed comes. */
    val h: String = "",
    /** A live agent's line: what it is doing now, its model steps, when its task began, its spend, and whether it waits on the owner. */
    val now: String = "",
    val nowSteps: Int = 0,
    val nowSince: Double = 0.0,
    val nowUsd: Double = 0.0,
    val nowNeed: Boolean = false,
    /** The owner's helper: listed above the sessions. */
    val helper: Boolean = false,
) {
    companion object {
        fun of(o: JSONObject) = Chat(
            id = o.str("id"), title = o.str("title", "New chat").ifBlank { "New chat" }, status = o.str("status", "idle"),
            updated = o.optDouble("updated", 0.0), unread = o.optInt("unread", 0), pinned = o.optInt("pinned", 0) != 0,
            archived = o.optInt("archived", 0) != 0, preview = o.str("preview"), lastRole = o.str("last_role"),
            parentId = o.str("parent_id").takeIf { it.isNotBlank() }, failure = o.str("failure"),
            created = o.optDouble("created", 0.0), agents = o.optInt("agents", 0), stateWord = o.str("state_word"), h = o.str("h"),
            now = o.str("now"), nowSteps = o.optInt("now_steps", 0), nowSince = o.optDouble("now_since", 0.0),
            nowUsd = o.optDouble("now_usd", 0.0), nowNeed = o.optInt("now_need", 0) != 0,
            helper = o.optInt("helper", 0) != 0,
        )
    }
}

/** One agent in the tree under a session: how deep (1 for the session's own agents) and how many agents are below it. */
data class AgentRow(val chat: Chat, val depth: Int, val below: Int)

/**
 * The agents under `root`, each followed by its own agents, oldest first at every level: the order the
 * workbench lists them in (src/core/agent-tree.ts, treeRows). A loop in damaged data is not followed.
 */
fun agentTree(chats: Collection<Chat>, root: String): List<AgentRow> {
    val kids = chats.filter { it.parentId != null && it.parentId != it.id }.groupBy { it.parentId!! }
        .mapValues { (_, l) -> l.sortedWith(compareBy<Chat>({ it.created }, { it.id })) }
    val out = ArrayList<AgentRow>()
    val seen = hashSetOf(root)
    fun walk(parent: String, depth: Int): Int {
        var total = 0
        for (c in kids[parent].orEmpty()) {
            if (!seen.add(c.id) || depth > 32) continue
            val at = out.size
            out += AgentRow(c, depth, 0)
            val below = walk(c.id, depth + 1)
            out[at] = out[at].copy(below = below)
            total += 1 + below
        }
        return total
    }
    walk(root, 1)
    return out
}

/**
 * Where an answer given in a session's screen leads: to the session of the card that has waited
 * longest elsewhere, as the page on a phone goes on. A card in an archived tree (the session or the
 * one at its top archived) is not gone on to, as the lasting notification does not count it. Null
 * to stay: the session's box holds words or files the owner began (`holds`), something else of this
 * session still waits, or nothing waits anywhere.
 */
fun nextAfterAnswer(answered: Card, cards: Collection<Card>, chats: Map<String, Chat>, holds: Boolean): String? {
    if (holds) return null
    val shelved = { id: String -> chats[id]?.archived == true || chats[rootOf(chats, id)]?.archived == true }
    val left = cards.filter { it.pending && it.id != answered.id && !shelved(it.chatId) }
    if (left.any { it.chatId == answered.chatId }) return null
    return left.minByOrNull { it.ts }?.chatId
}

/**
 * What a session waits on the owner for, in a line for the list: the oldest open card of the session or
 * of an agent under it, said as what it asks ("Allow? Bash: rm -rf build", "Asks: Which database?",
 * "Plan to approve: Split the store"), the agent named when it is an agent's, and how many more wait.
 * Empty when nothing waits.
 */
fun askLine(sessionId: String, cards: Collection<Card>, chats: Map<String, Chat>): String {
    val open = cards.filter { it.pending && (it.chatId == sessionId || rootOf(chats, it.chatId) == sessionId) }.sortedBy { it.ts }
    val c = open.firstOrNull() ?: return ""
    val what = when {
        c.plan -> "Plan to approve: ${c.command.ifBlank { "the model's plan" }}"
        c.question -> "Asks: ${c.questions.firstOrNull()?.question?.ifBlank { null } ?: c.command.lineSequence().firstOrNull().orEmpty()}" +
            (if (c.questions.size > 1) " (and ${c.questions.size - 1} more question${if (c.questions.size > 2) "s" else ""})" else "")
        else -> "Allow? ${c.noteLine}"
    }
    val who = if (c.chatId != sessionId) chats[c.chatId]?.title?.let { "$it: " }.orEmpty() else ""
    val more = if (open.size > 1) " · ${open.size - 1} more waiting" else ""
    return (who + what).replace(Regex("\\s+"), " ").trim() + more
}

/** The session at the top of the tree a session is in (itself when nobody started it). */
fun rootOf(chats: Map<String, Chat>, id: String): String {
    var at = id
    var n = 0
    while (n++ < 32) at = chats[at]?.parentId?.takeIf { it in chats } ?: return at
    return at
}

/**
 * The state the list shows: a waiting card first, then the daemon's word that the session waits on the
 * owner (a plan or a question inside a running turn), then a running turn, then how the last turn ended.
 */
fun stateOf(chat: Chat, pendingCard: Boolean, working: Boolean): State = when {
    pendingCard -> State.NEEDS
    chat.status == "needs_you" -> State.NEEDS
    working -> State.WORKING
    else -> when (chat.status) {
        "needs_you" -> State.NEEDS
        "working" -> State.WORKING
        "failed" -> State.FAILED
        "stopped" -> State.STOPPED
        "done" -> State.DONE
        else -> State.IDLE
    }
}

data class Step(val tool: String, val what: String)

/** What a stored prompt carried: an image (GET /v1/media/<media> gives its bytes) or a file by name. */
data class Attachment(val kind: String, val media: String, val mime: String, val fileName: String = "", val size: Long = 0) {
    val image get() = kind == "image"
    companion object {
        fun of(o: JSONObject) = Attachment(o.str("kind", "file"), o.str("media"), o.str("mime"), o.str("file_name"), o.optLong("size", 0))
    }
}

data class Msg(
    val id: String, val chatId: String, val role: String, val kind: String, val content: String, val ts: Double,
    val model: String = "", val steps: List<Step> = emptyList(), val approvalId: String? = null, val outcome: String = "",
    val cardKind: String = "", val cardCommand: String = "", val cardState: String = "", val origin: String = "",
    val attachments: List<Attachment> = emptyList(),
) {
    val mine get() = role == "user"
    companion object {
        fun of(o: JSONObject): Msg {
            val meta = o.optJSONObject("meta") ?: JSONObject()
            val steps = meta.optJSONArray("steps")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.map { Step(it.str("tool"), it.str("what")) } }.orEmpty()
            return Msg(
                id = o.str("id"), chatId = o.str("chat_id"), role = o.str("role"), kind = o.str("kind", "text"), content = o.str("content"),
                ts = o.optDouble("ts", 0.0), model = meta.str("model"), steps = steps, approvalId = meta.str("approval_id").takeIf { it.isNotBlank() },
                outcome = meta.str("outcome"), cardKind = meta.str("card"), cardCommand = meta.str("command"), cardState = meta.str("state"),
                origin = meta.str("origin"),
                attachments = meta.optJSONArray("attachments")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map(Attachment::of) }.orEmpty(),
            )
        }
    }
}

private fun strings(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }

/** `details`: what each option means, as the model wrote it beside the label ("" for none); `header`: the question's short head. */
data class Question(val id: String, val question: String, val options: List<String>, val multi: Boolean, val details: List<String> = emptyList(), val header: String = "") {
    fun detail(i: Int): String = details.getOrNull(i).orEmpty()
}
data class Act(val label: String, val choice: String, val style: String)

/**
 * A card. For a permission that waits, the daemon also sends all there is to judge:
 * text (the whole request, each hidden character written as its code point), notes (why it is asked,
 * where it runs, what in the text can mislead, that only its start is kept), and hold: why Allow
 * needs the text shown whole first (long, cut, marked, risk). An empty hold: one line shows all of it.
 * A daemon from before these fields sends none: the card shows its command, and nothing is held here.
 */
data class Card(
    val id: String, val chatId: String, val kind: String, val command: String, val description: String,
    val actions: List<Act>, val state: String, val choice: String?, val ts: Double, val questions: List<Question>,
    val answers: Map<String, List<String>> = emptyMap(),
    val text: String = "", val notes: List<String> = emptyList(), val cut: Boolean = false, val total: Int? = null, val lines: Int = 0,
    val hold: List<String> = emptyList(), val rtl: Boolean = false, val machine: String = "", val from: String = "",
    val line: String = "", val glance: Boolean = false, val grants: List<String> = emptyList(),
    /** What the wait costs a minute as it began, the key the daemon orders what waits by, and what it costs now in words. */
    val waitKey: Double = 0.0, val waitLine: String = "",
    /** When its alert was first raised (seconds; 0: none told): what the daemon breaks ties of the key by. */
    val asked: Double = 0.0,
) {
    val pending get() = state == "pending"
    val question get() = kind == "question"
    /** A plan the model presents: approved to start the work in a mode, or sent back to planning. */
    val plan get() = kind == "plan"
    /** Allow is given only once the whole text was on screen. */
    val held get() = hold.isNotEmpty()
    /** What the card draws of the request: the whole text when the daemon sent it, else the summary. */
    val shown get() = (text.ifBlank { command }).let { if (rtl) Wire.inPlace(it) else it }
    /** Whether an allow may be sent. read: every line of the text has been on screen. */
    fun mayAllow(read: Boolean) = !held || read
    /**
     * Whether a notification may carry Allow once: the daemon says its one line (line) shows all of the
     * request within a collapsed notification. A daemon from before that word sends no line: there a
     * request that is not held is allowed as it was.
     */
    val glanceable get() = if (line.isNotBlank()) glance else !held
    /** What a notification says of the request. */
    val noteLine get() = line.ifBlank { command.ifBlank { description } }
    /**
     * A choice's button. A standing answer stores a rule, and the button names it: "Allow echo * for this
     * session", never a bare "Allow for session". A daemon that names no rule gets the plain words.
     */
    fun label(choice: String, fallback: String) = if (plan) fallback else when (choice) {
        "once" -> "Allow once"
        "session" -> if (grants.isEmpty()) "Allow for session" else "Allow ${grants.joinToString(", ")} for this session"
        "always" -> if (grants.isEmpty()) "Always allow" else "Always allow ${grants.joinToString(", ")}"
        "deny" -> "Deny"
        else -> fallback
    }
    /** What stands in the way of Allow, said under the text. */
    val readFirst get() = when {
        !held -> ""
        plan -> "Scroll to the end of the plan to approve it."
        lines > 1 -> "Scroll to the end of all $lines lines to allow it."
        else -> "Read the whole request to allow it."
    }
    companion object {
        fun of(o: JSONObject): Card {
            val acts = o.optJSONArray("actions") ?: JSONArray()
            val qs = o.optJSONArray("questions") ?: JSONArray()
            val ans = o.optJSONObject("answers")
            return Card(
                id = o.str("id"), chatId = o.str("chat_id"), kind = o.str("kind", "permission"), command = o.str("command"),
                description = o.str("description"),
                actions = (0 until acts.length()).mapNotNull { acts.optJSONArray(it) }.map { Act(it.optString(0), it.optString(1), it.optString(2)) },
                state = o.str("state", "pending"), choice = o.str("choice").takeIf { it.isNotBlank() }, ts = o.optDouble("ts", 0.0),
                questions = (0 until qs.length()).map { qs.getJSONObject(it) }.map { q ->
                    val opts = q.optJSONArray("options") ?: JSONArray()
                    Question(q.str("id"), q.str("question"), (0 until opts.length()).map { opts.optString(it) }, q.optBoolean("multi"), strings(q.optJSONArray("details")), q.str("header"))
                },
                answers = ans?.keys()?.asSequence()?.associate { k ->
                    val a = ans.optJSONObject(k)
                    val picked = a?.optJSONArray("picked")?.let { p -> (0 until p.length()).map { p.optString(it) } }.orEmpty()
                    k to (picked + listOfNotNull(a?.str("other")?.takeIf { it.isNotBlank() }))
                }.orEmpty(),
                text = o.str("text"), notes = strings(o.optJSONArray("notes")), cut = o.optBoolean("cut"),
                total = if (o.isNull("total")) null else o.optInt("total"), lines = o.optInt("lines"),
                hold = strings(o.optJSONArray("hold")), rtl = o.optBoolean("rtl"), machine = o.str("machine"), from = o.str("from"),
                line = o.str("line"), glance = o.optBoolean("glance"), grants = strings(o.optJSONArray("grants")),
                waitKey = o.optJSONObject("wait")?.optDouble("key", 0.0) ?: 0.0, waitLine = o.str("wait_line"), asked = o.optDouble("asked", 0.0),
            )
        }
    }
}

/**
 * What waits, in the daemon's next-look order: the costliest wait first, then the one asked first
 * (its alert's time, as the daemon reads it; a card with none told, its own time), then by id
 * (src/core/wait-rank.ts). The key is fixed when a card begins to wait, so cards never change places.
 */
fun nextLook(cards: Collection<Card>): List<Card> =
    cards.sortedWith(compareByDescending<Card> { it.waitKey }.thenBy { if (it.asked > 0) it.asked else it.ts }.thenBy { it.id })

/**
 * The parts of a text that were drawn, as ranges along its height, merged as they come. A part
 * that touches or overlaps another joins it; what lies between two parts was not drawn.
 */
class Seen {
    private val parts = ArrayList<Pair<Float, Float>>()
    fun add(top: Float, bottom: Float) {
        if (bottom <= top) return
        var lo = top; var hi = bottom
        val keep = ArrayList<Pair<Float, Float>>()
        for ((a, b) in parts) if (b < lo - SLACK || a > hi + SLACK) keep += a to b else { lo = minOf(lo, a); hi = maxOf(hi, b) }
        keep += lo to hi
        parts.clear(); parts += keep.sortedBy { it.first }
    }
    /** All of [0, height] was drawn, within a pixel at each edge and between parts. */
    fun covers(height: Float): Boolean = parts.any { (a, b) -> a <= SLACK && b >= height - SLACK }
    companion object { const val SLACK = 1f }
}

/** One hit of the search: where (`kind`: title, user, assistant, tool_use, tool_result, summary), the words found marked in `snippet`. */
data class SearchHit(val chatId: String, val title: String, val kind: String, val snippet: String, val ts: Double, val eventId: String = "") {
    /** Where it was found, in a word. */
    val where get() = when (kind) {
        "title" -> "Title"; "user" -> "You wrote"; "assistant" -> "Reply"; "tool_use" -> "Tool call"; "tool_result" -> "Tool output"; "summary" -> "Summary"
        else -> kind.replaceFirstChar { it.uppercase() }
    }
}

/** GET /v1/search: the hits, and what the query limited the search to, in words. */
data class SearchResult(val query: String, val hits: List<SearchHit>, val limits: List<String>) {
    companion object {
        fun of(o: JSONObject) = SearchResult(
            o.str("query"),
            o.optJSONArray("hits")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().map {
                SearchHit(it.str("chat_id"), it.str("title"), it.str("kind"), it.str("snippet"), it.optDouble("ts", 0.0), it.str("event_id"))
            },
            strings(o.optJSONArray("limits")),
        )
    }
}

/** A snippet's parts: the text, and whether it is a word the search found (between \u0001 and \u0002). */
fun snippetParts(s: String): List<Pair<String, Boolean>> {
    val out = ArrayList<Pair<String, Boolean>>()
    var at = 0
    while (at < s.length) {
        val open = s.indexOf('\u0001', at)
        if (open < 0) { out += s.substring(at) to false; break }
        if (open > at) out += s.substring(at, open) to false
        val close = s.indexOf('\u0002', open + 1).let { if (it < 0) s.length else it }
        out += s.substring(open + 1, close) to true
        at = close + 1
    }
    return out.filter { it.first.isNotEmpty() }
}

/** One session in the away digest: what happened in it, the part that went wrong apart (`bad`). */
data class AwaySession(val chatId: String, val title: String, val state: String, val watch: String, val text: String, val bad: String = "")

/** GET /v1/away: what happened while the owner was away, in the page's words. Null: nothing to tell. */
data class Away(
    val span: String, val brief: String, val totals: String, val daemon: List<String>, val present: Boolean,
    val failed: Int, val waiting: Int, val quiet: Int, val sessions: List<AwaySession>,
) {
    companion object {
        fun of(o: JSONObject): Away? {
            val a = o.optJSONObject("away") ?: return null
            return Away(
                a.str("span"), a.str("brief"), a.str("totals"), strings(a.optJSONArray("daemon")), a.optBoolean("present"),
                a.optInt("failed"), a.optInt("waiting"), a.optInt("quiet"),
                a.optJSONArray("sessions")?.let { x -> (0 until x.length()).mapNotNull { x.optJSONObject(it) } }.orEmpty().map {
                    AwaySession(it.str("chat_id"), it.str("title"), it.str("state"), it.str("watch"), it.str("text"), it.str("bad"))
                },
            )
        }
    }
}

/**
 * One kind of failure on the daemon, as the page's Errors panel lists it: its whole message, where it came from
 * (`source`: provider, server, tool, client), how many times and when (seconds), read or not, healed by a retry
 * or not, and the session it last happened in while that session is there (`chatId`, empty when none; `sessions`:
 * in how many it happened, when more than one).
 */
data class ErrorRow(
    val id: String, val message: String, val source: String, val count: Int, val first: Double, val last: Double,
    val read: Boolean, val recovered: Boolean, val chatId: String = "", val title: String = "", val sessions: Int = 0,
) {
    /** Counted in the badge: open, not read, not healed by a retry. */
    val unread get() = !read && !recovered
    /** "Provider · 4x": where it came from, and how often when more than once. */
    val meta get() = source.replaceFirstChar { it.uppercase() } + if (count > 1) " · ${count}x" else ""
    /** Where it happened, in words: "In Fix the build", "In Fix the build and 2 other sessions"; empty with no session. */
    val where get() = if (chatId.isBlank()) "" else "In ${title.ifBlank { "a session" }}" +
        if (sessions > 1) " and ${sessions - 1} other session${if (sessions == 2) "" else "s"}" else ""
    companion object {
        fun of(o: JSONObject) = ErrorRow(
            o.str("id"), o.str("message"), o.str("source"), o.optInt("count", 1), o.optDouble("first", 0.0), o.optDouble("last", 0.0),
            o.optBoolean("read"), o.optBoolean("recovered"), o.str("chat_id"), o.str("title"), o.optInt("sessions", 0),
        )
    }
}

/** GET /v1/errors: the daemon's open errors, the newest first, and how many the page's badge counts. */
data class ErrorList(val rows: List<ErrorRow>, val unread: Int) {
    /** Open and not healed: what the list shows first. */
    val open get() = rows.filter { !it.recovered }
    val healed get() = rows.filter { it.recovered }
    /** After one was marked: its row as the daemon answered (`row`), or gone when resolved (`row` null). */
    fun marked(id: String, row: ErrorRow?): ErrorList {
        val next = if (row == null) rows.filter { it.id != id } else rows.map { if (it.id == id) row else it }
        return ErrorList(next, next.count { it.unread })
    }
    /**
     * An `error_changed` frame: the kind as it is now, first as the newest when it happened again, or off the
     * list when it is `gone` (resolved, or let go before the store took it). The count follows.
     */
    fun changed(row: ErrorRow, gone: Boolean): ErrorList {
        val rest = rows.filter { it.id != row.id }
        val next = when {
            gone -> rest
            (rows.firstOrNull { it.id == row.id }?.last ?: -1.0) == row.last -> rows.map { if (it.id == row.id) row else it }
            else -> (listOf(row) + rest).sortedByDescending { it.last }
        }
        return ErrorList(next, next.count { it.unread })
    }
    companion object {
        fun of(o: JSONObject) = ErrorList(
            o.optJSONArray("errors")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().map(ErrorRow::of),
            o.optInt("unread"),
        )
        /** POST /v1/errors/<id>/<action>: the row as it is now. */
        fun row(o: JSONObject): ErrorRow? = o.optJSONObject("row")?.let(ErrorRow::of)
        /** An `error_changed` frame: the row, and whether it left the open list. */
        fun frame(o: JSONObject): Pair<ErrorRow, Boolean>? = o.optJSONObject("row")?.let { ErrorRow.of(it) to o.optBoolean("gone") }
    }
}

/** One thing the helper was told: about a session (`chatId`), or mail (no session). */
data class HelperEvent(val id: String, val ts: Double, val chatId: String?, val title: String, val body: String)

/** GET /v1/helper: whether the owner's helper is on, its conversation, how much it remembers, what it was told lately (newest first). */
data class HelperView(val on: Boolean, val chatId: String?, val memory: Int, val events: List<HelperEvent>) {
    companion object {
        fun of(o: JSONObject) = HelperView(
            o.optBoolean("on"), o.str("chat_id").ifBlank { null }, o.optInt("memory"),
            o.optJSONArray("events")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                .map { HelperEvent(it.str("id"), it.optDouble("ts", 0.0), it.str("chat_id").ifBlank { null }, it.str("title"), it.str("body")) },
        )
    }
}

/** POST /v1/helper/ask: the question's id (null when the same question was taken already) and the helper's chat. */
data class HelperAsked(val id: String?, val chatId: String, val duplicate: Boolean) {
    companion object {
        fun of(o: JSONObject) = HelperAsked(o.str("id").ifBlank { null }, o.str("chat_id"), o.optBoolean("duplicate"))
    }
}

/** A session the helper's answer read, and how many requests of it wait for the owner. */
data class HelperRead(val chatId: String, val title: String, val waits: Int)

/**
 * GET /v1/helper/ask/<id>: the helper's answer to a question from its row. `state`: waiting, working,
 * done, failed or stopped. `looked`: what else it read (sessions: the list, activity, mail, calendar, memory).
 */
data class HelperAnswer(
    val id: String, val chatId: String, val state: String, val question: String, val text: String,
    val ts: Double, val looked: List<String>, val read: List<HelperRead>,
) {
    /** The helper still works on it: the row asks again. */
    val pending: Boolean get() = state == "waiting" || state == "working"

    companion object {
        fun of(o: JSONObject) = HelperAnswer(
            o.str("id"), o.str("chat_id"), o.str("state"), o.str("question"), o.str("text"), o.optDouble("ts", 0.0), strings(o.optJSONArray("looked")),
            o.optJSONArray("read")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                .map { HelperRead(it.str("chat_id"), it.str("title"), it.optInt("waits")) },
        )
    }
}

/** One record of the helper's memory: a short fact under a key, with its topics. */
data class MemoryRecord(val key: String, val value: String, val topics: List<String>, val updated: Double)

/** GET /v1/helper/memory: the records (all, or those found), and how many were found. */
data class MemoryList(val items: List<MemoryRecord>, val total: Int) {
    companion object {
        fun of(o: JSONObject) = MemoryList(
            o.optJSONArray("items")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
                .map { MemoryRecord(it.str("key"), it.str("value"), strings(it.optJSONArray("topics")), it.optDouble("updated", 0.0)) },
            o.optInt("total"),
        )
    }
}

/** GET /v1/start: what a new session can start with. */
data class StartModel(val id: String, val name: String)
data class StartFolder(val path: String, val name: String, val last: Double = 0.0, val home: Boolean = false)
data class StartMachine(val id: String, val name: String, val ready: Boolean, val root: String = "")
data class Start(val model: String, val models: List<StartModel>, val folders: List<StartFolder>, val machines: List<StartMachine>) {
    companion object {
        private fun objs(o: JSONObject, k: String) = o.optJSONArray(k)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
        fun of(o: JSONObject) = Start(
            o.str("model"),
            objs(o, "models").map { StartModel(it.str("id"), it.str("name").ifBlank { it.str("id") }) },
            objs(o, "folders").map { StartFolder(it.str("path"), it.str("name"), it.optDouble("last", 0.0), it.optBoolean("home")) },
            objs(o, "machines").map { StartMachine(it.str("id"), it.str("name"), it.optBoolean("ready"), it.str("root")) },
        )
    }
}

/** A new session as the start sheet chose it (POST /v1/chats): what is left blank is the daemon's default. */
data class NewChat(val model: String = "", val workspace: String = "", val machine: String = "", val text: String = "") {
    fun body(): JSONObject = JSONObject().apply {
        if (model.isNotBlank()) put("model", model)
        if (workspace.isNotBlank()) put("workspace", workspace)
        if (machine.isNotBlank() && machine != "local") put("machine", machine)
        if (text.isNotBlank()) put("text", text.trim())
    }
}

/** A model's name as a picker shows it: its listing's name, else the id after its provider. */
fun modelName(m: StartModel) = if (m.name.isNotBlank() && m.name != m.id) m.name else m.id.substringAfter(':')

/** A file a session changed: its path, git's letter for how (A added, M changed, D deleted, T its type), the lines added and removed, written outside the session's work. */
data class FileChange(val path: String, val status: String, val added: Int, val removed: Int, val outside: Boolean = false) {
    val name get() = path.substringAfterLast('/')
    val dir get() = path.substringBeforeLast('/', "")
    companion object {
        fun of(o: JSONObject) = FileChange(o.str("path"), o.str("status"), o.optInt("added"), o.optInt("removed"), o.optBoolean("outside"))
    }
}

/** One turn's changes: `turn` is what a diff asks for, `n` its place among the session's turns. */
data class ChangeTurn(val turn: Long, val n: Int?, val prompt: String, val ts: Double, val added: Int, val removed: Int, val files: List<FileChange>) {
    companion object {
        fun of(o: JSONObject) = ChangeTurn(
            o.optLong("turn"), if (o.isNull("n")) null else o.optInt("n"), o.str("prompt"), o.optDouble("ts", 0.0), o.optInt("added"), o.optInt("removed"),
            o.optJSONArray("files")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map(FileChange::of) }.orEmpty(),
        )
    }
}

/** GET /v1/chats/:id/changes: each turn's changes, newest first, and the files changed since the first. `unavailable`: why there is nothing. */
data class Changes(val turns: List<ChangeTurn>, val session: List<FileChange>, val expired: Int, val scope: String, val unavailable: String) {
    companion object {
        fun of(o: JSONObject) = Changes(
            o.optJSONArray("turns")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map(ChangeTurn::of) }.orEmpty(),
            o.optJSONArray("session")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map(FileChange::of) }.orEmpty(),
            o.optInt("expired"), o.str("scope"), o.str("unavailable"),
        )
    }
}

/** One line of a diff: a hunk's head, an added, removed or unchanged line, or a note ("No newline at end of file"), with its numbers in the old and new file. */
data class DiffLine(val kind: Char, val text: String, val old: Int?, val new: Int?)

/** GET /v1/chats/:id/changes/diff: one file's unified diff, cut where the page cuts one (`truncated`). */
data class FileDiff(val path: String, val status: String, val added: Int, val removed: Int, val diff: String, val truncated: Boolean) {
    val lines get() = diffLines(diff)
    companion object {
        fun of(o: JSONObject) = FileDiff(o.str("path"), o.str("status"), o.optInt("added"), o.optInt("removed"), o.str("diff"), o.optBoolean("truncated"))
    }
}

private val HUNK = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)""")

/** A unified diff as lines to draw, the file headers left out. A binary file's diff has none. */
fun diffLines(diff: String): List<DiffLine> {
    val out = ArrayList<DiffLine>()
    var old = 0; var new = 0; var inHunk = false
    for (l in diff.split('\n')) {
        val h = HUNK.find(l)
        when {
            h != null -> { old = h.groupValues[1].toInt(); new = h.groupValues[2].toInt(); inHunk = true; out += DiffLine('@', l, null, null) }
            l.startsWith("diff --git ") -> inHunk = false
            !inHunk -> {}
            l.startsWith("+") -> out += DiffLine('+', l.substring(1), null, new++)
            l.startsWith("-") -> out += DiffLine('-', l.substring(1), old++, null)
            l.startsWith(" ") -> out += DiffLine(' ', l.substring(1), old++, new++)
            l.startsWith("\\") -> out += DiffLine('\\', l.removePrefix("\\ "), null, null)
        }
    }
    return out
}

// --- what the phone keeps of the daemon, written back in the daemon's own shapes -----------
// The last sync is kept on the phone (Feed.snapshot) as a sync answer: each value written here is
// read again by its own `of`, so what is kept and what is read are one contract (WireTest checks
// every example of the wire round trip).

private fun JSONObject.opt(k: String, v: String) = apply { if (v.isNotEmpty()) put(k, v) }

fun Chat.json(): JSONObject = JSONObject().put("id", id).put("title", title).put("status", status).put("updated", updated).put("unread", unread)
    .put("pinned", if (pinned) 1 else 0).put("archived", if (archived) 1 else 0).put("preview", preview).put("last_role", lastRole)
    .put("parent_id", parentId ?: JSONObject.NULL).opt("failure", failure).put("created", created).put("agents", agents).opt("state_word", stateWord).opt("h", h)
    .apply { if (now.isNotEmpty()) put("now", now).put("now_steps", nowSteps).put("now_since", nowSince).put("now_usd", nowUsd).put("now_need", if (nowNeed) 1 else 0) }
    .apply { if (helper) put("helper", 1) }

/** FNV-1a, 32 bits, over the UTF-8 bytes: the daemon's number for the same text (v1.ts fnv). */
fun fnv(s: String): Long {
    var h = 0x811c9dc5L
    for (b in s.toByteArray(Charsets.UTF_8)) h = ((h xor (b.toLong() and 0xff)) * 0x01000193L) and 0xffffffffL
    return h
}

/** The bucket a row goes in when the phone says what it holds in `n` buckets. */
fun bucketOf(id: String, n: Int): Int = (fnv(id) % n).toInt()

/**
 * At most this many buckets: nine bytes each in the stream's query, about 1.2 KB, far under the 8 KB of
 * request line and headers a proxy commonly takes, however many rows the phone holds.
 */
const val HELD_BUCKETS = 128

/** What the phone holds in `n` buckets: per bucket the sum (mod 2^32) of its rows' `<id>:<mark>` hashes, as 8 hex digits, dot separated. */
fun heldOf(chats: Collection<Chat>, n: Int): String {
    val sums = LongArray(n)
    for (c in chats) { val b = bucketOf(c.id, n); sums[b] = (sums[b] + fnv("${c.id}:${c.h}")) and 0xffffffffL }
    return sums.joinToString(".") { "%08x".format(it) }
}

/**
 * What a reconnect says it holds (`held`): only rows the daemon marked (a daemon from before marks says
 * none, and is asked for every row, as before), about one row a bucket.
 */
fun heldOf(chats: Collection<Chat>): String? = chats.takeIf { it.isNotEmpty() && it.all { c -> c.h.isNotBlank() } }
    ?.let { heldOf(it, minOf(it.size, HELD_BUCKETS)) }

fun Attachment.json(): JSONObject = JSONObject().put("kind", kind).put("media", media).put("mime", mime).opt("file_name", fileName).apply { if (size > 0) put("size", size) }

fun Msg.json(): JSONObject {
    val meta = JSONObject().opt("model", model).opt("outcome", outcome).opt("card", cardKind).opt("command", cardCommand).opt("state", cardState).opt("origin", origin)
    if (steps.isNotEmpty()) meta.put("steps", JSONArray(steps.map { JSONObject().put("tool", it.tool).put("what", it.what) }))
    if (approvalId != null) meta.put("approval_id", approvalId)
    if (attachments.isNotEmpty()) meta.put("attachments", JSONArray(attachments.map { it.json() }))
    return JSONObject().put("id", id).put("chat_id", chatId).put("role", role).put("kind", kind).put("content", content).put("ts", ts).put("meta", meta)
}

fun Card.json(): JSONObject = JSONObject().put("id", id).put("chat_id", chatId).put("kind", kind).put("command", command).put("description", description)
    .put("actions", JSONArray(actions.map { JSONArray(listOf(it.label, it.choice, it.style)) })).put("state", state).put("choice", choice ?: JSONObject.NULL).put("ts", ts)
    .put("questions", JSONArray(questions.map { q -> JSONObject().put("id", q.id).put("question", q.question).put("options", JSONArray(q.options)).put("multi", q.multi).put("details", JSONArray(q.details)).put("header", q.header) }))
    .apply { if (answers.isNotEmpty()) put("answers", JSONObject().apply { answers.forEach { (k, v) -> put(k, JSONObject().put("picked", JSONArray(v))) } }) }
    .opt("text", text).apply { if (notes.isNotEmpty()) put("notes", JSONArray(notes)) }.put("cut", cut).put("total", total ?: JSONObject.NULL).put("lines", lines)
    .apply { if (hold.isNotEmpty()) put("hold", JSONArray(hold)) }.put("rtl", rtl).opt("machine", machine).opt("from", from).opt("line", line).put("glance", glance)
    .apply { if (grants.isNotEmpty()) put("grants", JSONArray(grants)) }
    .apply { if (waitKey != 0.0) put("wait", JSONObject().put("key", waitKey)) }.opt("wait_line", waitLine)
    .apply { if (asked != 0.0) put("asked", asked) }

/** "14:32" today, "Mon 14:32" this week, else "23 Nov 14:32": when the phone was last level with the computer, in its own time. */
fun syncedAt(ms: Long, now: Long = System.currentTimeMillis(), zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
    val t = java.time.Instant.ofEpochMilli(ms).atZone(zone)
    val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val hm = "%02d:%02d".format(t.hour, t.minute)
    return when {
        t.toLocalDate() == today -> hm
        t.toLocalDate().isAfter(today.minusDays(7)) -> "${t.dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH)} $hm"
        else -> "${t.dayOfMonth} ${t.month.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH)} $hm"
    }
}

/**
 * What a failed request means to the owner: the computer cannot be reached from here (no network, the
 * address does not answer, it took too long), said once in plain words; anything else as it came.
 */
const val OUT_OF_REACH = "The computer is out of reach"
fun reach(e: Throwable): String = when (e) {
    is java.net.UnknownHostException, is java.net.ConnectException, is java.net.NoRouteToHostException, is java.io.InterruptedIOException -> OUT_OF_REACH
    else -> if (e.message?.contains("Failed to connect", ignoreCase = true) == true || e.message?.contains("Unable to resolve host") == true) OUT_OF_REACH else e.message ?: e.javaClass.simpleName
}

/** How an unpairing ended: whether the daemon revoked this phone, and what the owner is told. */
data class Unpaired(val revoked: Boolean, val note: String)

/**
 * The outcome of asking the daemon to revoke this phone (DELETE /v1/devices/<id>)
 * before its keys are deleted here. Revoked: the daemon said ok, or refused the
 * request with 401 "unauthorized" (it had revoked this phone already, so its
 * token is unknown). Anything else, no answer included, leaves the phone
 * listed there: a 401 for a bad signature (the phone's clock is off) too. The
 * keys are gone here all the same, and the owner is told to revoke it on the
 * computer.
 */
fun unpaired(answer: JSONObject?, code: Int?, error: String?, server: String): Unpaired {
    val name = server.ifBlank { "The daemon" }
    return if (answer?.optBoolean("ok") == true || (code == 401 && error == "unauthorized")) Unpaired(true, "Unpaired. $name no longer accepts this phone.")
    else Unpaired(false, "This phone's keys are deleted, but $name did not confirm that it revoked this phone, so it may still list it. On the computer, open Settings, then Phone, and revoke it there.")
}

/** What a failed read of earlier messages offers: the same read again, or the conversation read anew. */
enum class Earlier { AGAIN, RELOAD }

/**
 * 409 says the page's cursor is no longer on the shown branch (another one
 * was picked on the computer): reading the same page again cannot work, the
 * conversation is reloaded. Anything else may pass: the same read again.
 */
fun earlierAfter(code: Int?): Earlier = if (code == 409) Earlier.RELOAD else Earlier.AGAIN

/** "now", "4m", "3h", "2d", "5w". */
fun ago(secs: Double, now: Double = System.currentTimeMillis() / 1000.0): String {
    val d = (now - secs).coerceAtLeast(0.0)
    return when {
        d < 45 -> "now"
        d < 3600 -> "${(d / 60).toInt().coerceAtLeast(1)}m"
        d < 86400 -> "${(d / 3600).toInt()}h"
        d < 86400 * 14 -> "${(d / 86400).toInt()}d"
        else -> "${(d / (86400 * 7)).toInt()}w"
    }
}

/** An elapsed time for a running turn: "12s", "4m 05s", "1h 02m". */
fun elapsed(secs: Double, now: Double = System.currentTimeMillis() / 1000.0): String {
    val d = (now - secs).coerceAtLeast(0.0).toLong()
    return when {
        d < 60 -> "${d}s"
        d < 3600 -> "${d / 60}m %02ds".format(d % 60)
        else -> "${d / 3600}h %02dm".format((d % 3600) / 60)
    }
}

// --- the daemon's other answers, as values --------------------------------------
// Every field the app reads of the daemon is read in this file or in Feed.kt,
// and is named in the wire contract (ContractTest checks both).

/** The daemon's refusal: `error` in the body of a failed request. */
fun errorOf(body: String): String = runCatching { JSONObject(body).str("error") }.getOrDefault("")

/** POST /v1/pair: the device the daemon made for this phone. */
data class Paired(val token: String, val deviceId: String, val server: String) {
    companion object {
        fun of(o: JSONObject) = Paired(o.str("token"), o.str("device_id"), o.optJSONObject("server")?.str("name").orEmpty())
    }
}

/**
 * GET /v1/me: what Settings says of the machine and of this phone, and what an upload may be:
 * at most maxBytes, a photo at most imageEdge on its long edge, the image types a model reads.
 * A daemon from before uploads says none of it: null, and the daemon judges each file.
 */
data class Me(val model: String, val device: String, val maxBytes: Long? = null, val imageEdge: Int? = null, val inlineImages: List<String>? = null) {
    /** The image types a model reads: the daemon's list, else the ones every model reads. */
    val readable get() = inlineImages ?: DEFAULT_INLINE
    companion object {
        /** The image types every model reads, for a daemon that does not list them. */
        val DEFAULT_INLINE = listOf("image/png", "image/jpeg", "image/gif", "image/webp")
        fun of(o: JSONObject): Me {
            val u = o.optJSONObject("uploads")
            return Me(
                o.str("model"), o.optJSONObject("device")?.str("name").orEmpty(),
                maxBytes = u?.takeIf { !it.isNull("max_bytes") }?.optLong("max_bytes"),
                imageEdge = u?.takeIf { !it.isNull("image_edge") }?.optInt("image_edge"),
                inlineImages = u?.optJSONArray("inline_images")?.let(::strings)?.takeIf { it.isNotEmpty() },
            )
        }
    }
}

/** POST /v1/upload: the file as the daemon stored it. A prompt names it by `id`. */
data class Upload(val id: String, val kind: String, val mime: String, val fileName: String, val size: Long) {
    val image get() = kind == "image"
    companion object {
        fun of(o: JSONObject) = Upload(o.str("id"), o.str("kind", "file"), o.str("mime"), o.str("file_name"), o.optLong("size", 0))
    }
}

/** GET /v1/push-config?app=<package>: this app's Firebase entry on the daemon, or the file the daemon looks for. */
data class PushConfig(val enabled: Boolean, val missing: String, val apiKey: String, val appId: String, val projectId: String, val senderId: String) {
    companion object {
        fun of(o: JSONObject): PushConfig {
            val c = o.optJSONObject("config") ?: JSONObject()
            return PushConfig(o.optBoolean("enabled"), o.str("missing"), c.str("api_key"), c.str("app_id"), c.str("project_id"), c.str("sender_id"))
        }
    }
}

/** One push, as its data arrives: the kind, the session, the alert's words, the card it is about, the choices a notification offers, the id to confirm. */
data class PushMsg(
    val kind: String, val chat: String?, val title: String, val body: String, val card: String?, val choices: List<String>, val id: String?, val held: Boolean = false,
    /** A "live" push: sessions working, cards waiting, when the longest turn started (ms), open errors not read, where a tap leads. */
    val working: Int = 0, val needs: Int = 0, val since: Long = 0, val failed: Int = 0, val to: String = "",
    /** Where its notification leads when it names no session: "errors" for a failure with no session to open. */
    val open: String = "",
) {
    companion object {
        fun of(d: Map<String, String>) = PushMsg(
            kind = d["t"].orEmpty(), chat = d["c"]?.takeIf { it.isNotBlank() }, title = d["title"].orEmpty(), body = d["body"].orEmpty(),
            card = d["aid"]?.takeIf { it.isNotBlank() },
            choices = runCatching { JSONArray(d["opts"] ?: "[]").let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrDefault(emptyList()),
            id = d["n"]?.takeIf { it.isNotBlank() },
            // The request is opened and read before it is allowed: its notification carries no Allow.
            held = !d["hold"].isNullOrBlank(),
            working = d["w"]?.toIntOrNull() ?: 0, needs = d["q"]?.toIntOrNull() ?: 0, since = d["since"]?.toLongOrNull() ?: 0,
            failed = d["f"]?.toIntOrNull() ?: 0, to = d["to"].orEmpty(), open = d["open"].orEmpty(),
        )
    }
    /**
     * Whether the notification carries Allow once: the daemon offered it (opts; a push from before
     * opts offered it always) and does not hold the request. Else it leads with Open.
     */
    val allows get() = !held && (choices.isEmpty() || "once" in choices)

    /**
     * What a withdraw push takes down: the one request's notification it names (answered elsewhere
     * while its session has more), else everything shown for its session. Nothing for another kind.
     */
    val takesDown: TakeDown? get() = if (kind != "withdraw") null else card?.let { TakeDown.Card(it) } ?: chat?.let { TakeDown.Chat(it) }
}

sealed interface TakeDown {
    data class Card(val aid: String) : TakeDown
    data class Chat(val chat: String) : TakeDown
}

/**
 * The lasting notification's state: sessions working, cards waiting on the owner, the words to show,
 * when the longest turn started (ms, 0 unknown). Nothing working or waiting: no notification.
 */
/**
 * `failed`: the open errors not read yet, said beside work or a wait (never alone: a failure has a notification
 * of its own). `to`: where a tap leads, as the daemon decides it (live.ts liveTo): needs, errors or sessions.
 */
data class Live(val working: Int, val needs: Int, val title: String, val body: String, val since: Long = 0, val failed: Int = 0, val to: String = "sessions") {
    val shown get() = working > 0 || needs > 0
    companion object {
        /**
         * Whether to post `l`, and whether a swipe still holds after it: a status that shows nothing ends the swipe
         * (the next work gets its notification again); while the swipe holds, nothing is posted.
         */
        fun gate(l: Live, swiped: Boolean): Pair<Boolean, Boolean> = if (!l.shown) false to false else !swiped to swiped
        /** What waits on the owner first, then what failed, else the sessions at work. */
        fun to(needs: Int, failed: Int) = if (needs > 0) "needs" else if (failed > 0) "errors" else "sessions"
        /** A "live" push, as the daemon sends it (one from before `to` leads by its counts). */
        fun of(m: PushMsg) = Live(m.working, m.needs, m.title, m.body, m.since, m.failed, m.to.ifBlank { to(m.needs, m.failed) })
        /**
         * What the app holds: the sessions whose turns run (since when), the open cards, the titles. Counted
         * as the daemon counts (live.ts readLive): per root, a root whose agents work works, an archived
         * root counts for nothing, and a root a card waits in needs the owner instead of working.
         */
        fun of(working: Map<String, Double>, cards: Collection<Card>, chats: Map<String, Chat>, unreadErrors: Int = 0): Live {
            val shelved = { id: String -> chats[id]?.archived == true }
            val open = cards.filter { it.pending && !shelved(rootOf(chats, it.chatId)) }
            val needs = open.size
            val waiting = open.map { rootOf(chats, it.chatId) }.toSet()
            // When each root's work started: its own turn, else the earliest turn below it.
            val start = mutableMapOf<String, Double>()
            for ((id, at) in working) { val r = rootOf(chats, id); start[r] = minOf(start[r] ?: at, at) }
            val roots = (working.keys.map { rootOf(chats, it) } + chats.values.filter { it.agents > 0 }.map { it.id })
                .filter { chats[it]?.parentId == null && !shelved(it) && it !in waiting }.distinct()
            val failed = if (roots.isNotEmpty() || needs > 0) unreadErrors.coerceAtLeast(0) else 0
            val what = listOfNotNull(
                if (roots.isNotEmpty()) "${roots.size} session${if (roots.size == 1) "" else "s"} working" else null,
                if (needs > 0) "$needs need${if (needs == 1) "s" else ""} you" else null,
                if (failed > 0) "$failed error${if (failed == 1) "" else "s"}" else null,
            ).joinToString(" · ")
            val byStart = roots.sortedBy { start[it] ?: 0.0 }
            return Live(roots.size, needs, what, byStart.take(4).joinToString(" · ") { chats[it]?.title ?: "A session" },
                byStart.mapNotNull { start[it] }.minOrNull()?.let { (it * 1000).toLong() } ?: 0, failed, to(needs, failed))
        }
        /** The background check's read (GET /v1/pulse): the daemon's own status, else made from the pulse (a daemon from before). */
        fun of(p: Pulse, unreadErrors: Int = 0): Live {
            p.live?.let { return it }
            val chats = p.sessions.associate { it.id to Chat(it.id, it.title, "working", 0.0, 0, false, false, "", "", null) }
            return of(p.working, p.cards, chats, unreadErrors)
        }
    }
}

/** A running session on the Usage screen: every input token, cached or not, and the spend when it is priced. */
data class PulseSession(val id: String, val title: String, val model: String, val tokensIn: Long, val tokensOut: Long, val cost: Double?)

/** GET /v1/pulse: today's spend and turns, the week's bars, the open cards, the sessions. */
data class Pulse(
    val tz: String, val spendToday: Double?, val unpricedToday: Int, val runsToday: Int, val failuresToday: Int,
    val week: List<Double>, val cards: List<Card>, val sessions: List<PulseSession>,
    /** The sessions whose turns run, and since when (seconds). */
    val working: Map<String, Double> = emptyMap(),
    /** The lasting notification's status as the daemon reads it (its "live" push's fields). */
    val live: Live? = null,
) {
    companion object {
        fun of(o: JSONObject): Pulse {
            fun objs(k: String) = o.optJSONArray(k)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
            return Pulse(
                tz = o.str("tz"), spendToday = if (o.isNull("spend_today")) null else o.optDouble("spend_today"),
                unpricedToday = o.optInt("spend_today_unpriced"), runsToday = o.optInt("runs_today"), failuresToday = o.optInt("failures_today"),
                week = o.optJSONArray("spend_7d")?.let { a -> (0 until a.length()).map { a.optDouble(it, 0.0) } }.orEmpty(),
                cards = objs("approvals").map(Card::of),
                sessions = objs("live_sessions").map { s ->
                    val u = s.optJSONObject("usage") ?: JSONObject()
                    PulseSession(
                        s.str("id"), s.str("title"), s.str("model"), u.optLong("input") + u.optLong("cache_read") + u.optLong("cache_write"),
                        u.optLong("output"), if (u.isNull("cost")) null else u.optDouble("cost"),
                    )
                },
                working = objs("working").associate { it.str("chat_id") to it.optDouble("since", 0.0) },
                live = o.optJSONObject("live")?.let { l -> Live.of(PushMsg.of(l.keys().asSequence().associateWith { l.optString(it) })) },
            )
        }
    }
}

/** GET /v1/chats/:id/usage in a line: the model, the tokens in and out, the cached ones, the spend. */
fun usageLine(o: JSONObject): String {
    val s = o.optJSONObject("session") ?: return "No usage yet"
    fun n(v: Long) = if (v >= 1_000_000) "%.1fM".format(v / 1e6) else if (v >= 1000) "%.1fk".format(v / 1e3) else "$v"
    val cost = if (s.isNull("cost")) "not priced" else "$%.4f".format(s.optDouble("cost"))
    return "${s.str("model")} · in ${n(s.optLong("prompt_tokens"))} · out ${n(s.optLong("output_tokens"))} · cached ${n(s.optLong("cache_read_tokens"))} · $cost"
}

/** The newest message held of a chat, by the daemon's clock: what a send is measured against. */
fun newestTs(held: List<Msg>): Double = held.maxOfOrNull { it.ts } ?: 0.0

/**
 * Whether a send that got no answer here did reach the daemon: the owner's own
 * words are held as a message newer than everything held when the send was
 * made. That send is done, and the same words sent again are a new prompt.
 */
fun sendArrived(held: List<Msg>, text: String, after: Double): Boolean = held.any { it.mine && it.content == text && it.ts > after }

/** What a branch changes in one top folder: files and lines. */
data class LandArea(val area: String, val files: Int, val added: Int, val removed: Int) {
    companion object {
        fun of(o: JSONObject) = LandArea(o.str("area"), o.optInt("files"), o.optInt("added"), o.optInt("removed"))
    }
}

/**
 * A branch that waits to land, as the work board's facts (GET /v1/landings): its agent's branch and head, the named
 * checks on that head (`checksState` known, unknown with `checksWhy`, none), the latest review (`verdict` empty when
 * none), the proof line of the agent's report, its size by area, its latest queue entry of this head, what of the
 * evidence is `missing`, and `fp`, the print a decision names.
 */
data class LandCard(
    val key: String, val chatId: String, val title: String, val agentChat: String, val agentTitle: String, val agentState: String,
    val branch: String, val base: String, val baseTip: String, val head: String, val ahead: Int?, val behind: Int?,
    val checksState: String, val passed: List<String>, val failed: List<String>, val notRun: List<String>, val checksWhy: String,
    val verdict: String, val reviewer: String, val reviewTitle: String, val reviewLine: String, val reviewCurrent: Boolean?,
    val proof: String, val areas: List<LandArea>, val queueState: String, val queueWhy: String,
    val ready: Boolean, val missing: List<String>, val fp: String,
) {
    val short get() = head.take(9)
    /** "2 ahead · 1 behind main": where the head stands against the base, when git said (counted against `baseTip`, the base's commit then). */
    val against get() = listOfNotNull(ahead?.let { "$it ahead" }, behind?.takeIf { it > 0 }?.let { "$it behind ${base.ifBlank { "the base" }}" }).joinToString(" · ")
    /** "typecheck, unit passed · e2e failed": the checks in a line. */
    val checksLine get() = when (checksState) {
        "none" -> "The repository names no checks"
        "unknown" -> "Checks not known: $checksWhy"
        else -> listOfNotNull(
            passed.takeIf { it.isNotEmpty() }?.let { "${it.joinToString(", ")} passed" },
            failed.takeIf { it.isNotEmpty() }?.let { "${it.joinToString(", ")} failed" },
            notRun.takeIf { it.isNotEmpty() }?.let { "${it.joinToString(", ")} not run" },
        ).joinToString(" · ").ifBlank { "No check decided on its head" }
    }
    /** "Approved by Review the retry fix", "Of an older head by Review the cache", "No review". */
    val reviewLineShort get() = when {
        verdict.isBlank() -> "No review"
        verdict == "approved" && reviewCurrent == false -> "Approved an older head"
        else -> VERDICTS[verdict].orEmpty().ifBlank { verdict.replaceFirstChar { it.uppercase() } } + (if (reviewTitle.isNotBlank()) " by $reviewTitle" else "")
    }
    /** "src/ 3 files +84 −12 · android/ 1 file +20 −2". */
    val size get() = areas.joinToString(" · ") { "${it.area} ${it.files} file${if (it.files == 1) "" else "s"} +${it.added} −${it.removed}" }
    companion object {
        private val VERDICTS = mapOf("approved" to "Approved", "refused" to "Refused", "disputed" to "Reviewers disagree", "words" to "Words only, no verdict",
            "unclear" to "No clear verdict", "pending" to "Review running", "stale" to "Of an older head")
        private fun strs(a: JSONArray?) = a?.let { x -> (0 until x.length()).map { x.optString(it) } }.orEmpty()
        fun of(o: JSONObject): LandCard {
            val c = o.optJSONObject("checks") ?: JSONObject()
            val r = o.optJSONObject("review")
            val q = o.optJSONObject("queue")
            return LandCard(
                o.str("key"), o.str("chat_id"), o.str("title"), o.str("agent_chat"), o.str("agent_title"), o.str("agent_state"),
                o.str("branch"), o.str("base"), o.str("base_tip"), o.str("head"), if (o.isNull("ahead")) null else o.optInt("ahead"), if (o.isNull("behind")) null else o.optInt("behind"),
                c.str("state"), strs(c.optJSONArray("passed")), strs(c.optJSONArray("failed")), strs(c.optJSONArray("not_run")), c.str("why"),
                r?.str("verdict").orEmpty(), r?.str("by").orEmpty(), r?.str("title").orEmpty(), r?.str("line").orEmpty(),
                r?.let { if (it.isNull("current")) null else it.optBoolean("current") },
                o.str("proof"), o.optJSONArray("areas")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().map(LandArea::of),
                q?.str("state").orEmpty(), q?.str("why").orEmpty(),
                o.optBoolean("ready"), strs(o.optJSONArray("missing")), o.str("fp"),
            )
        }
        fun list(o: JSONObject): List<LandCard> = o.optJSONArray("cards")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty().map(::of)
    }
}

/**
 * How a decision on a landing card ended: `ok` (queued: `entry`, its state; sent back: `waits`, `held`), or refused with
 * the daemon's words and the card as it is now (`card` null: it no longer waits to land).
 */
data class LandOutcome(val ok: Boolean, val error: String, val card: LandCard?, val entry: String = "", val state: String = "", val warnings: List<String> = emptyList(), val waits: Boolean = false, val held: Boolean = false) {
    companion object {
        fun of(o: JSONObject): LandOutcome {
            val e = o.optJSONObject("entry"); val s = o.optJSONObject("sent")
            return LandOutcome(true, "", o.optJSONObject("card")?.let(LandCard::of), e?.str("id").orEmpty(), e?.str("state").orEmpty(),
                o.optJSONArray("warnings")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty(), s?.optBoolean("waits") ?: false, s?.optBoolean("held") ?: false)
        }
        fun refused(o: JSONObject) = LandOutcome(false, o.str("error"), o.optJSONObject("card")?.let(LandCard::of))
    }
}
