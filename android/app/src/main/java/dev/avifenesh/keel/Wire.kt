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

data class Msg(
    val id: String, val chatId: String, val role: String, val kind: String, val content: String, val ts: Double,
    val model: String = "", val steps: List<Step> = emptyList(), val approvalId: String? = null, val outcome: String = "",
    val cardKind: String = "", val cardCommand: String = "", val cardState: String = "", val origin: String = "",
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
            )
        }
    }
}

data class Question(val id: String, val question: String, val options: List<String>, val multi: Boolean)
data class Act(val label: String, val choice: String, val style: String)

data class Card(
    val id: String, val chatId: String, val kind: String, val command: String, val description: String,
    val actions: List<Act>, val state: String, val choice: String?, val ts: Double, val questions: List<Question>,
    val answers: Map<String, List<String>> = emptyMap(),
) {
    val pending get() = state == "pending"
    val question get() = kind == "question"
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
            )
        }
    }
}

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
