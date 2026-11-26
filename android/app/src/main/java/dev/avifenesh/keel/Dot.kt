// A session's dot, as the workbench draws it (ui/src/bridge.css, .k-mark): one small dot per state, and the facts
// that decide it, pure so a test can read them. Nothing here knows Compose; ui/Parts.kt draws what `look` says.
package dev.avifenesh.keel

/** The state a dot shows, by the workbench's own names. */
enum class Dot(val key: String, val word: String) {
    NEED("need", "Needs you"), WORK("work", "Working"), WAIT("wait", "Waiting"), FAIL("fail", "Failed"), DECLINED("declined", "Declined"),
    RESUME("resume", "Waiting"), STOP("stop", "Stopped"), DONE("done", "Done"), IDLE("idle", "Not started");

    companion object {
        fun of(key: String): Dot? = entries.firstOrNull { it.key == key }
    }
}

/** How the dot is drawn. Shape as well as color, so the color is never the only signal. */
enum class Form {
    /** Filled. */ SOLID,
    /** Filled with a darker edge: the yellow one, too light to stand off a light surface by its fill. */ EDGED,
    /** An empty ring: declined (red), not started (grey). */ HOLLOW,
    /** The lower half filled inside a ring: waiting for a timer or something else that will wake it. */ HALF,
    /** A dot inside a ring: working only through its agents or a command left in the background. */ IN_RING,
    /** An empty square: stopped. */ SQUARE,
    /** A ring with a gap that does not turn: waiting to resume. */ OPEN,
}

/**
 * What to draw: the form, the palette tokens of its fill and its edge (the stylesheet's names), whether it has a soft halo
 * (the work dot alone) and whether the halo breathes (it stands still under reduced motion), and the dot's word.
 */
data class Look(val dot: Dot, val form: Form, val fill: String, val edge: String, val halo: Boolean, val breathes: Boolean, val word: String)

const val WAITING_ON_AGENTS = "Waiting on agents"
const val COMMAND_IN_BACKGROUND = "Command in background"
const val NEW_WORD = "New"

/** The dot of a state this app knew before the daemon said it, from a daemon that sends only the six statuses. */
fun dotOfState(s: State): Dot = when (s) {
    State.NEEDS -> Dot.NEED; State.WORKING -> Dot.WORK; State.FAILED -> Dot.FAIL; State.STOPPED -> Dot.STOP; State.DONE -> Dot.DONE; State.IDLE -> Dot.IDLE
}

/**
 * The dot of a row: the daemon's own (`dot`) when it agrees with the state the list shows, else what the state says.
 * A card that waits on the owner, or a turn the phone sees running, is the state the list shows first and wins over a
 * daemon answer that has not caught up. `ring` is `agents` or `command`, kept only where the dot is the work or wait one.
 */
fun dotOf(chat: Chat, state: State): Pair<Dot, String> {
    val said = Dot.of(chat.dot)
    val dot = when (state) {
        State.NEEDS -> Dot.NEED
        State.WORKING -> said.takeIf { it == Dot.WORK || it == Dot.WAIT || it == Dot.RESUME } ?: Dot.WORK
        State.FAILED -> said.takeIf { it == Dot.FAIL || it == Dot.DECLINED } ?: Dot.FAIL
        else -> dotOfState(state)
    }
    val ring = if (dot == Dot.WORK || dot == Dot.WAIT) chat.dotRing.takeIf { it == "agents" || it == "command" }.orEmpty() else ""
    return dot to ring
}

/** The word a reader hears for the dot: the daemon's when it said it for this dot, else the vocabulary's. */
fun dotWordOf(chat: Chat, dot: Dot, ring: String): String = when {
    chat.dotWord.isNotBlank() && Dot.of(chat.dot) == dot -> chat.dotWord
    ring == "agents" -> WAITING_ON_AGENTS
    ring == "command" -> COMMAND_IN_BACKGROUND
    else -> dot.word
}

/** The form of a dot; a halo is the work dot's alone, and it breathes only where motion is allowed. */
fun look(dot: Dot, ring: String = "", word: String = dot.word, reducedMotion: Boolean = false): Look = when {
    (dot == Dot.WORK || dot == Dot.WAIT) && ring.isNotEmpty() -> Look(dot, Form.IN_RING, "--dot-work", "--dot-work", false, false, word)
    dot == Dot.NEED -> Look(dot, Form.EDGED, "--dot-need", "--dot-need-edge", false, false, word)
    dot == Dot.WORK -> Look(dot, Form.SOLID, "--dot-work", "--dot-work", true, !reducedMotion, word)
    dot == Dot.WAIT -> Look(dot, Form.HALF, "--dot-work", "--dot-work", false, false, word)
    dot == Dot.FAIL -> Look(dot, Form.SOLID, "--dot-fail", "--dot-fail", false, false, word)
    dot == Dot.DECLINED -> Look(dot, Form.HOLLOW, "--dot-fail", "--dot-fail", false, false, word)
    // Done is the quiet grey of a state at rest: colour is for what needs the owner, failed and at work. (The page draws a finished row of its rail with no dot; its --dot-done green is for where finishes are counted.)
    dot == Dot.DONE -> Look(dot, Form.SOLID, "--st-idle", "--st-idle", false, false, word)
    dot == Dot.IDLE -> Look(dot, Form.HOLLOW, "--st-idle", "--st-idle", false, false, word)
    dot == Dot.STOP -> Look(dot, Form.SQUARE, "--st-idle", "--st-idle", false, false, word)
    else -> Look(dot, Form.OPEN, "--st-idle", "--st-idle", false, false, word)
}

/**
 * Whether a row's news is shown by the dot at its end: the same rule as the page (ui/src/lib/list-order.ts isNews).
 * A row that needs the owner or failed says more than a dot, so it shows none.
 */
fun showsNews(dot: Dot, unread: Int): Boolean = unread > 0 && dot != Dot.NEED && dot != Dot.FAIL && dot != Dot.DECLINED

/**
 * Whether a row's title is the heavy one: a session that needs the owner, failed or has news says so by its weight, as the page's
 * row does (bridge.css, .k-row-title). News is no second dot beside the state's.
 */
fun titleHeavy(dot: Dot, unread: Int): Boolean = dot == Dot.NEED || dot == Dot.FAIL || dot == Dot.DECLINED || showsNews(dot, unread)

/** A session at rest that has been seen reads in the muted text color; every other row's title is in ink. */
fun titleQuiet(dot: Dot, unread: Int): Boolean = (dot == Dot.DONE || dot == Dot.IDLE || dot == Dot.STOP) && !showsNews(dot, unread)

/**
 * The line a session at work shows in place of its last message: what its turn does now, in the page's words. Nothing for a
 * session that does not work (it says its state), one that waits on the owner (it says what it asks) or a daemon that says none.
 */
fun actionLine(chat: Chat, state: State): String = if (state == State.WORKING) chat.action.trim() else ""
