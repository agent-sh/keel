package dev.avifenesh.keel

import dev.avifenesh.keel.ui.closedWords
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The quiet screen's one-line words: what folds, what one line says, what carries color. */
class QuietTest {
    private fun msg(content: String, origin: String = "", role: String = "agent") = Msg("m", "s", role, "text", content, 1.0, origin = origin)

    @Test fun anAgentsReportFoldsToItsFirstLineAndTheConversationDoesNot() {
        assertEquals("Report from Worker (done)", foldedLine(msg("**Report from Worker** (done)\n\nAll tests pass.", "subagent")))
        assertEquals("Woken: timer fired", foldedLine(msg("\nWoken: timer fired\nbody", "wait")))
        assertEquals("Agent report", foldedLine(msg("", "subagent")))
        // The reply and the owner's words stay whole.
        assertNull(foldedLine(msg("Here is the plan.")))
        assertNull(foldedLine(msg("Do it", role = "user")))
        assertNull(foldedLine(msg("A notice", "harness")))
    }

    @Test fun aRunOfCallsIsTheNewestCallsDescriptionWithNoCount() {
        val steps = listOf(Step("Read", "src/a.ts"), Step("Bash", "Run the unit tests\nbun test"))
        assertEquals("Run the unit tests", traceLine(steps))
        assertEquals("Bash", traceLine(listOf(Step("Bash", ""))))
        assertEquals("Tool calls", traceLine(emptyList()))
    }

    @Test fun theAgentsItemIsQuietUnlessAnAgentNeedsTheOwnerOrFailed() {
        assertEquals("Agents 4", agentsWord(4))
        assertNull(agentsMark(0, 0))
        assertEquals(State.NEEDS, agentsMark(1, 1))
        assertEquals(State.FAILED, agentsMark(0, 2))
    }

    @Test fun theBoxShowsStopWhileATurnRunsAndSendWhenThereIsSomethingToSend() {
        assertEquals(BoxButtons(send = true, stop = false), boxButtons(working = false, hasContent = false))
        assertEquals(BoxButtons(send = false, stop = true), boxButtons(working = true, hasContent = false))
        assertEquals(BoxButtons(send = true, stop = true), boxButtons(working = true, hasContent = true))
    }

    @Test fun theCardMarksThePartOfAChainedCommandThatAsked() {
        val text = "cd /srv && rm -rf build && echo done"
        fun card(at: List<Int>, rtl: Boolean = false) = Card("c", "s", "permission", text, "", emptyList(), "pending", null, 0.0, emptyList(), text = text, at = at, rtl = rtl)
        assertEquals("rm -rf build", card(listOf(11, 23)).askedPart?.let { text.substring(it) })
        assertNull(card(emptyList()).askedPart)
        // Outside the text, or a text drawn in another order: nothing is marked.
        assertNull(card(listOf(11, 99)).askedPart)
        assertNull(card(listOf(11, 23), rtl = true).askedPart)
        // Read from the daemon's card under its name, and kept as it was read.
        val wire = org.json.JSONObject().put("id", "c").put("chat_id", "s").put("text", text).put("at", org.json.JSONArray(listOf(11, 23)))
        assertEquals(listOf(11, 23), Card.of(wire).at)
        assertEquals(Card.of(wire), Card.of(Card.of(wire).json()))
    }

    @Test fun aDeniedCardIsTheOwnersAnswerNotAFailure() {
        fun card(state: String, kind: String = "permission") = Card("c", "s", kind, "rm x", "", emptyList(), state, null, 0.0, emptyList())
        assertEquals(State.STOPPED to "Denied", closedWords(card("denied")))
        assertEquals(State.STOPPED, closedWords(card("expired")).first)
        assertEquals(State.DONE to "Allowed once", closedWords(card("approved")))
    }
}
