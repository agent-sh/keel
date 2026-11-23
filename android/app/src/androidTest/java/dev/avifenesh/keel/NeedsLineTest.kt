package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.SessionList
import dev.avifenesh.keel.ui.sessionRows
import org.junit.Rule
import org.junit.Test

// The list says what a session waits on the owner for, not its last words: the reason it is at the top.
class NeedsLineTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aRowThatNeedsTheOwnerSaysWhatItAsks() {
        fun chat(id: String, title: String, status: String, parent: String? = null) = Chat(id, title, status, 1.0, 0, false, false, "Step 1 of 1.", "agent", parent)
        val chats = listOf(chat("a", "Deploy check", "needs_you"), chat("b", "Release", "needs_you"), chat("b0", "Coordinator", "needs_you", "b"), chat("b1", "Changelog", "needs_you", "b0"), chat("c", "Docs", "done")).associateBy { it.id }
        val cards = listOf(
            Card("apr-1", "a", "permission", "git push --force-with-lease", "", emptyList(), "pending", null, 1.0, emptyList(), line = "Bash: git push origin main --force-with-lease"),
            Card("q-9", "b1", "question", "", "", emptyList(), "pending", null, 2.0, listOf(Question("q", "Which version number?", listOf("1.2"), false))),
        ).associateBy { it.id }
        rule.setContent { KeelTheme(2) { SessionList(sessionRows(chats, cards, emptyMap()), now = 100.0) } }
        rule.onNodeWithContentDescription("line-of-Deploy check", useUnmergedTree = true).assertTextEquals("Allow? Bash: git push origin main --force-with-lease")
        rule.onNodeWithContentDescription("line-of-Release", useUnmergedTree = true).assertTextEquals("Changelog: Asks: Which version number?")
        // The agent that asks is listed with its question; the one between it and the root is not.
        rule.onNodeWithContentDescription("line-of-Changelog", useUnmergedTree = true).assertTextEquals("Asks: Which version number?")
        rule.onNodeWithContentDescription("session-Coordinator").assertDoesNotExist()
        // A session that waits on nothing keeps its last words.
        rule.onNodeWithContentDescription("line-of-Docs", useUnmergedTree = true).assertIsDisplayed().assertTextEquals("Step 1 of 1.")
    }
}
