package dev.avifenesh.keel

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithContentDescription
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.SessionList
import dev.avifenesh.keel.ui.sessionRows
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// A row's state is one dot with its word for a reader, and news is the title's weight.
class DotRowsTest {
    @get:Rule val rule = createComposeRule()

    private fun chat(id: String, status: String, dot: String = "", ring: String = "", word: String = "", unread: Int = 0, agents: Int = 0, action: String = "") =
        Chat(id, "T-$id", status, 1.0, unread, false, false, "A line.", "agent", null, agents = agents, dot = dot, dotRing = ring, dotWord = word, action = action)

    private fun told(text: String) = rule.onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, text), useUnmergedTree = true).fetchSemanticsNodes().size

    /** The weight of the title of a row, read from its text layout. */
    private fun weightOf(title: String): Int {
        val node = rule.onNodeWithText(title, useUnmergedTree = true).fetchSemanticsNode()
        val out = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(out)
        return out.first().layoutInput.style.fontWeight!!.weight
    }

    private fun words(word: String) = rule.onAllNodesWithContentDescription(word, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test fun everyStateIsADotWithItsWordAndNewsIsADot() {
        val chats = listOf(
            chat("w", "working", "work", word = "Working", action = "Editing src/a.ts"),
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
        // News: the done row's title is heavier and a reader is told; the row that needs the owner says more and tells none.
        assertEquals(1, told("New, 2 unread"))
        assertEquals(0, told("New, 1 unread"))
        assertEquals(0, words("New, 2 unread"))
        // A session at work says what it does now, where the others say their last message.
        rule.onNodeWithText("Editing src/a.ts", useUnmergedTree = true).assertExists()
        assertEquals(5, rule.onAllNodesWithText("A line.", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(600, weightOf("T-n"))
        assertEquals(600, weightOf("T-y"))
        assertEquals(400, weightOf("T-i"))
        assertEquals(400, weightOf("T-w"))
    }

    @Test fun theHelperRowCarriesTheFaceTheOwnerGaveIt() {
        val face = android.graphics.Bitmap.createBitmap(64, 32, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF2E7D32.toInt()) }
        val helper = chat("hp", "idle", "idle", word = "Not started").copy(helper = true)
        val chats = listOf(helper, chat("o", "idle", "idle", word = "Not started")).associateBy { it.id }
        Face.picture.value = Face.round(face)
        try {
            rule.setContent { KeelTheme(2) { SessionList(sessionRows(chats, emptyMap(), emptyMap()), now = 100.0, askRow = false) } }
            // One face, on the helper's row alone, and its state is still said by the dot beside it.
            assertEquals(1, rule.onAllNodesWithContentDescription("helper-face", useUnmergedTree = true).fetchSemanticsNodes().size)
            assertEquals(2, words("Not started"))
        } finally { Face.picture.value = null }
    }
}
