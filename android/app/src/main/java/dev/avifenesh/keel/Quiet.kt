// What a quiet screen says in one line: an agent's report folded in the conversation, a run of
// calls, the session's agents over the box, and which small buttons sit beside the box.
// Color is for what needs the owner; counts and timers wait until an item is opened.
package dev.avifenesh.keel

/** Inputs that are the agents' work, not the conversation: a report, a wake. They fold to one line. */
val FOLDED_ORIGINS = setOf("subagent", "wait")

/** The line an agent's report or a wake folds to, or null when the message is part of the conversation. */
fun foldedLine(m: Msg): String? {
    if (m.origin !in FOLDED_ORIGINS) return null
    val first = m.content.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
    val plain = first.replace("**", "").trim()
    return plain.ifEmpty { if (m.origin == "wait") "Woken" else "Agent report" }
}

/** The one line a finished run of calls folds to: the newest call's description, else its tool. */
fun traceLine(steps: List<Step>): String {
    val last = steps.lastOrNull() ?: return "Tool calls"
    return last.what.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.ifEmpty { null } ?: last.tool
}

/** The one item over the box for a session's agents: the word and how many, quiet. */
fun agentsWord(n: Int): String = "Agents $n"

/**
 * The one mark the agents item carries, or null: an agent that waits on the owner, else one that failed.
 * Agents at work or done carry none (the session's own dot says it works).
 */
fun agentsMark(need: Int, failed: Int): State? = when {
    need > 0 -> State.NEEDS
    failed > 0 -> State.FAILED
    else -> null
}

/** The small buttons beside the box. Stop while a turn runs; send when idle or when there is something to send. */
data class BoxButtons(val send: Boolean, val stop: Boolean)

fun boxButtons(working: Boolean, hasContent: Boolean): BoxButtons = BoxButtons(send = !working || hasContent, stop = working)
