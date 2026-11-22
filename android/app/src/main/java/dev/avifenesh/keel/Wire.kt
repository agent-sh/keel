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

    /** A prompt as the daemon takes it (POST /v1/chats/:id/messages). mode: send, steer or queue. */
    fun sendBody(text: String, mode: String, clientId: String): JSONObject =
        JSONObject().put("text", text).put("mode", mode).put("client_id", clientId)

    /**
     * A card's answer as the daemon takes it (POST /v1/approvals/:id). answers: by question id, one label or a list of them.
     * seen: all of the request's text was on this screen before the answer. The daemon takes an allow of a
     * request that one line does not show whole only with it; a refusal needs none. via: "notification"
     * for an answer given from a notification, which shows one line and so never says seen.
     */
    fun answerBody(choice: String, answers: Map<String, Any>?, seen: Boolean = false, via: String? = null): JSONObject {
        val body = JSONObject().put("choice", choice)
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
) {
    companion object {
        fun of(o: JSONObject) = Chat(
            id = o.str("id"), title = o.str("title", "New chat").ifBlank { "New chat" }, status = o.str("status", "idle"),
            updated = o.optDouble("updated", 0.0), unread = o.optInt("unread", 0), pinned = o.optInt("pinned", 0) != 0,
            archived = o.optInt("archived", 0) != 0, preview = o.str("preview"), lastRole = o.str("last_role"),
            parentId = o.str("parent_id").takeIf { it.isNotBlank() }, failure = o.str("failure"),
        )
    }
}

/** The state the list shows: a waiting card or a running turn first, then how the last turn ended. */
fun stateOf(chat: Chat, pendingCard: Boolean, working: Boolean): State = when {
    pendingCard -> State.NEEDS
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

data class Question(val id: String, val question: String, val options: List<String>, val multi: Boolean)
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
) {
    val pending get() = state == "pending"
    val question get() = kind == "question"
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
    fun label(choice: String, fallback: String) = when (choice) {
        "once" -> "Allow once"
        "session" -> if (grants.isEmpty()) "Allow for session" else "Allow ${grants.joinToString(", ")} for this session"
        "always" -> if (grants.isEmpty()) "Always allow" else "Always allow ${grants.joinToString(", ")}"
        "deny" -> "Deny"
        else -> fallback
    }
    /** What stands in the way of Allow, said under the text. */
    val readFirst get() = when {
        !held -> ""
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
                    Question(q.str("id"), q.str("question"), (0 until opts.length()).map { opts.optString(it) }, q.optBoolean("multi"))
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
            )
        }
    }
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

/** GET /v1/me: what Settings says of the machine and of this phone. */
data class Me(val model: String, val device: String) {
    companion object {
        fun of(o: JSONObject) = Me(o.str("model"), o.optJSONObject("device")?.str("name").orEmpty())
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
data class PushMsg(val kind: String, val chat: String?, val title: String, val body: String, val card: String?, val choices: List<String>, val id: String?, val held: Boolean = false) {
    companion object {
        fun of(d: Map<String, String>) = PushMsg(
            kind = d["t"].orEmpty(), chat = d["c"]?.takeIf { it.isNotBlank() }, title = d["title"].orEmpty(), body = d["body"].orEmpty(),
            card = d["aid"]?.takeIf { it.isNotBlank() },
            choices = runCatching { JSONArray(d["opts"] ?: "[]").let { a -> (0 until a.length()).map { a.getString(it) } } }.getOrDefault(emptyList()),
            id = d["n"]?.takeIf { it.isNotBlank() },
            // The request is opened and read before it is allowed: its notification carries no Allow.
            held = !d["hold"].isNullOrBlank(),
        )
    }
    /**
     * Whether the notification carries Allow once: the daemon offered it (opts; a push from before
     * opts offered it always) and does not hold the request. Else it leads with Open.
     */
    val allows get() = !held && (choices.isEmpty() || "once" in choices)
}

/** A running session on the Usage screen: every input token, cached or not, and the spend when it is priced. */
data class PulseSession(val id: String, val title: String, val model: String, val tokensIn: Long, val tokensOut: Long, val cost: Double?)

/** GET /v1/pulse: today's spend and turns, the week's bars, the open cards, the sessions. */
data class Pulse(
    val tz: String, val spendToday: Double?, val unpricedToday: Int, val runsToday: Int, val failuresToday: Int,
    val week: List<Double>, val cards: List<Card>, val sessions: List<PulseSession>,
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
