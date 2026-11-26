package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import dev.avifenesh.keel.ui.AgentsBar
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.StarterLine
import androidx.compose.foundation.layout.Column
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// A session's agents on the phone: one quiet item, "Agents N", the tree when opened, each agent opening
// its session; an agent's session leads up to its starter.
class AgentsTest {
    @get:Rule val rule = createComposeRule()

    private fun c(id: String, title: String, parent: String?, created: Double, status: String = "done", failure: String = "") =
        Chat(id, title, status, created, 0, false, false, "", "", parent, failure = failure, created = created)
    private val chats = listOf(
        c("root", "Refactor the store", null, 0.0),
        c("a", "Coordinator", "root", 1.0, "working"),
        c("a1", "Worker", "a", 2.0, "working"),
        c("a1x", "Checker", "a1", 3.0, "failed", "HTTP 529: overloaded"),
        c("b", "Docs", "root", 4.0),
    ).associateBy { it.id }

    @Test fun theTreeOpensFromItsLineAndEachAgentOpensItsSession() {
        val opened = mutableListOf<String>()
        rule.setContent { KeelTheme(1) { AgentsBar("root", chats, needs = emptySet(), working = mapOf("a" to 1.0, "a1" to 2.0), now = 100.0) { opened += it } } }
        // Folded: the word and how many, quiet. Agents at work say nothing; a failed one is a mark, no count.
        rule.onNodeWithContentDescription("agents-4").assertIsDisplayed()
        rule.onNodeWithText("Agents 4", useUnmergedTree = true).assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithText("2 working").fetchSemanticsNodes().size)
        rule.onNodeWithContentDescription("agents-mark-failed", useUnmergedTree = true).assertExists()
        assertEquals(0, rule.onAllNodesWithContentDescription("agent-row-Worker").fetchSemanticsNodes().size)
        // Opened: each agent under the one that started it, the failure said.
        rule.onNodeWithContentDescription("agents-4").performClick()
        // (Where each title is drawn: the rows span the width, their titles are set in.)
        val order = listOf("Coordinator", "Worker", "Checker", "Docs").map { rule.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode().positionInRoot }
        assertEquals(order.sortedBy { it.y }, order)
        // Deeper is further in.
        assertEquals(true, order[0].x < order[1].x && order[1].x < order[2].x && order[3].x == order[0].x)
        rule.onNodeWithText("HTTP 529: overloaded").assertIsDisplayed()
        // No clock or count on a row.
        assertEquals(0, rule.onAllNodesWithText("2 below").fetchSemanticsNodes().size)
        rule.onNodeWithContentDescription("agent-row-Checker").performClick()
        assertEquals(listOf("a1x"), opened)
    }

    @Test fun onlyTheAgentThatAsksNeedsTheOwnerNotTheOnesAboveIt() {
        // The daemon says "needs you" of every agent between the one that asks and the root.
        val asking = chats.mapValues { (id, c) -> if (id in setOf("a", "a1", "a1x")) c.copy(status = "needs_you") else c }
        rule.setContent { KeelTheme(1) { AgentsBar("root", asking, needs = setOf("a1x"), working = emptyMap(), now = 100.0) {} } }
        rule.onNodeWithText("1 needs you", useUnmergedTree = true).assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithText("2 working").fetchSemanticsNodes().size)
        assertEquals(2, rule.onAllNodesWithText("Waits on an agent below it").fetchSemanticsNodes().size)
    }

    @Test fun anAgentThatNeedsTheOwnerOpensTheTreeByItselfAndAnAgentLeadsUp() {
        val opened = mutableListOf<String>()
        rule.setContent { KeelTheme(1) { Column { StarterLine("a", chats) { opened += it }; AgentsBar("a", chats, needs = setOf("a1x"), working = emptyMap(), now = 100.0) { opened += it } } } }
        rule.onNodeWithText("1 needs you", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithContentDescription("agent-row-Checker").assertIsDisplayed()
        rule.onNodeWithContentDescription("starter-Refactor the store").performClick()
        assertEquals(listOf("root"), opened)
    }
}
