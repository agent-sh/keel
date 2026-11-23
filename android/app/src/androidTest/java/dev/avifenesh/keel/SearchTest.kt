package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.SearchScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// Search from the phone: the words asked once the typing stops, hits by session with what was found,
// a hit opening its session, and a search that finds nothing said so.
class SearchTest {
    @get:Rule val rule = createComposeRule()

    @Test fun theWordsFindSessionsAndAHitOpensItsSession() {
        val asked = mutableListOf<String>()
        val opened = mutableListOf<String>()
        val found = SearchResult("invoice total", listOf(
            SearchHit("s-1", "Invoice totals", "title", "Invoice totals", 1.0),
            SearchHit("s-2", "Docs", "assistant", "The \u0001invoice\u0002 \u0001total\u0002 is rounded twice.", 1.0, "e-9"),
        ), emptyList())
        rule.setContent { KeelTheme(2) { SearchScreen(find = { asked += it; if (it == "nothing here") SearchResult(it, emptyList(), emptyList()) else found }, onOpen = { opened += it }) } }
        rule.onNodeWithContentDescription("search-q").performTextInput("invoice total")
        rule.waitUntil(3000) { asked.isNotEmpty() }
        // One search for the words typed, not one a letter.
        assertEquals(listOf("invoice total"), asked)
        rule.onNodeWithContentDescription("hit-Invoice totals").assertIsDisplayed()
        rule.onNodeWithText("REPLY").assertIsDisplayed()
        rule.onNodeWithContentDescription("snippet-Docs", useUnmergedTree = true).assertTextEquals("The invoice total is rounded twice.")
        rule.onNodeWithContentDescription("hit-Docs").performClick()
        assertEquals(listOf("s-2"), opened)
    }

    @Test fun aSearchThatFindsNothingSaysSo() {
        rule.setContent { KeelTheme(1) { SearchScreen(find = { SearchResult(it, emptyList(), listOf("failed sessions")) }) } }
        rule.onNodeWithContentDescription("search-q").performTextInput("state:failed nothing")
        rule.waitUntil(3000) { rule.onAllNodes(androidx.compose.ui.test.hasText("Nothing found")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Limited to: failed sessions.").assertIsDisplayed()
    }
}
