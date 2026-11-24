package dev.avifenesh.keel

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.SessionList
import dev.avifenesh.keel.ui.sessionRows
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// A row's state is one dot with its word for a reader, and news is a dot at the row's end.
class DotRowsTest {
    @get:Rule val rule = createComposeRule()

    private fun chat(id: String, status: String, dot: String = "", ring: String = "", word: String = "", unread: Int = 0, agents: Int = 0) =
        Chat(id, "T-$id", status, 1.0, unread, false, false, "A line.", "agent", null, agents = agents, dot = dot, dotRing = ring, dotWord = word)

    private fun words(word: String) = rule.onAllNodesWithContentDescription(word, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test fun everyStateIsADotWithItsWordAndNewsIsADot() {
        val chats = listOf(
            chat("w", "working", "work", word = "Working"),
            chat("r", "working", "work", "agents", "Waiting on agents", agents = 2),
            chat("h", "working", "wait", word = "Waiting"),
            chat("d", "failed", "declined", word = "Declined"),
            chat("f", "failed", "fail", word = "Failed"),
            chat("n", "done", "done", word = "Done", unread = 2),
            chat("y", "needs_you", "need", word = "Needs you", unread = 1),
            chat("i", "idle", "idle", word = "Not started"),
        ).associateBy { it.id }
        rule.setContent { KeelTheme(2) { SessionList(sessionRows(chats, emptyMap(), emptyMap()), now = 100.0, askRow = false) } }
        for (word in listOf("Working", "Waiting on agents", "Waiting", "Declined", "Failed", "Done", "Needs you", "Not started")) assertEquals("the dot of $word", 1, words(word))
        // A declined turn is not read as an ordinary failure, and a session that waits on its agents is not just working.
        assertEquals(1, words("Failed"))
        // News: a dot on the done row; none on the row that needs the owner.
        assertEquals(1, words("New, 2 unread"))
        assertEquals(0, words("New, 1 unread"))
    }
}
