// How the helper row shows an answer (ui/Ask.kt draws it): its status while the helper works, the
// line that names what it read, and the taps it offers. Pure. The answer itself only read; each tap is
// the owner's and goes through what the app already does: Answer opens the session at what waits for
// the owner there (its approval or question card), Open opens it.
package dev.avifenesh.keel

/** A tap the answer offers. */
data class AskAct(val kind: Kind, val chatId: String, val label: String) {
    enum class Kind { ANSWER, OPEN, HELPER }
}

/** What the answer looked at besides single sessions, in words. */
private val LOOKED = mapOf("sessions" to "the session list", "activity" to "what happened", "mail" to "mail", "calendar" to "the calendar", "memory" to "its memory")

object Asked {
    /** How long the row reads an answer that has not come: past it the helper is held (a provider's wait, a long turn) and the row says so. */
    const val ANSWER_WAIT_MS = 2 * 60_000L

    /** Whether the row reads the answer again: the helper still works, and the row has not waited [ANSWER_WAIT_MS] since it began. */
    fun readsAgain(a: HelperAnswer, sinceMs: Long, nowMs: Long): Boolean = a.pending && nowMs - sinceMs < ANSWER_WAIT_MS

    /** What the row says when it stopped reading an answer that had not come. */
    const val UNANSWERED = "The helper did not answer."

    /** "Read Fix the build, Deploy and the session list"; empty when it read nothing. */
    fun readLine(a: HelperAnswer): String {
        val parts = a.read.map { it.title } + a.looked.map { LOOKED[it] ?: it }
        if (parts.isEmpty()) return ""
        return "Read " + if (parts.size == 1) parts[0] else parts.dropLast(1).joinToString(", ") + " and " + parts.last()
    }

    /** What the row says above the answer's words, or empty when the words are the answer. */
    fun status(a: HelperAnswer): String = when (a.state) {
        "waiting" -> if (a.text.isBlank()) "Asked. The helper starts on it." else ""
        "working" -> if (a.text.isBlank()) "The helper is reading your sessions." else ""
        "failed" -> "The helper's turn failed. Its conversation says why."
        "stopped" -> "The helper was stopped before it answered."
        else -> if (a.text.isBlank()) "The helper gave no words. Its conversation has the turn." else ""
    }

    /** The taps: Answer where a session it read waits for the owner (first), Open for the others, then the helper's conversation. */
    fun acts(a: HelperAnswer): List<AskAct> {
        val (waiting, rest) = a.read.partition { it.waits > 0 }
        return waiting.map { AskAct(AskAct.Kind.ANSWER, it.chatId, "Answer ${it.title}") } +
            rest.map { AskAct(AskAct.Kind.OPEN, it.chatId, "Open ${it.title}") } +
            AskAct(AskAct.Kind.HELPER, a.chatId, "Go on with the helper")
    }
}
