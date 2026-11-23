package dev.avifenesh.keel

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.avifenesh.keel.ui.ChangesScreen
import dev.avifenesh.keel.ui.DiffScreen
import dev.avifenesh.keel.ui.KeelTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// A session's changes on the phone: the list opens a file's diff of the turn it is under, and Back
// leads to the list, then to the session.
class ChangesTest {
    @get:Rule val rule = createComposeRule()

    private val parse = FileChange("src/parse.ts", "M", 2, 1)
    private val test = FileChange("src/parse.test.ts", "A", 5, 0)
    private val changes = Changes(
        turns = listOf(ChangeTurn(9, 2, "Add a test", 1.0, 5, 0, listOf(test)), ChangeTurn(2, 1, "Filter blank lines", 1.0, 2, 1, listOf(parse))),
        session = listOf(test, parse), expired = 0, scope = "tree", unavailable = "",
    )
    private val diff = FileDiff("src/parse.ts", "M", 2, 1, "diff --git a/src/parse.ts b/src/parse.ts\n--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -1,2 +1,3 @@\n-old line\n+new line\n+one more\n kept\n", false)

    @Test fun theListOpensAFilesDiffAndBackLeadsHome() {
        val asked = mutableListOf<Long?>()
        Ui.route.value = Route.Changes("s-1")
        rule.setContent {
            KeelTheme(1) {
                when (val r = Ui.route.value) {
                    is Route.Changes -> ChangesScreen(r.id) { changes }
                    is Route.Diff -> DiffScreen(r) { asked += r.turn; diff }
                    is Route.Session -> Text("the session ${r.id}")
                    else -> Text("elsewhere")
                }
            }
        }
        // Since the first turn, then each turn's: parse.ts twice, under the first turn's heading too.
        rule.onNodeWithContentDescription("turn-1").assertIsDisplayed()
        assertEquals(2, rule.onAllNodesWithContentDescription("file-src/parse.ts").fetchSemanticsNodes().size)
        // The one under turn 1 opens that turn's diff.
        rule.onAllNodesWithContentDescription("file-src/parse.ts")[1].performClick()
        rule.onNodeWithText("Turn 1 · src").assertIsDisplayed()
        rule.onNodeWithText("new line").assertIsDisplayed()
        assertEquals(1, rule.onAllNodesWithContentDescription("line--").fetchSemanticsNodes().size)
        assertEquals(2, rule.onAllNodesWithContentDescription("line-+").fetchSemanticsNodes().size)
        assertEquals(listOf<Long?>(2), asked)
        rule.onNodeWithContentDescription("Back").performClick()
        rule.onNodeWithContentDescription("turn-2").assertIsDisplayed()
        rule.onNodeWithContentDescription("Back").performClick()
        rule.onNodeWithText("the session s-1").assertIsDisplayed()
    }
}
