package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.MemoryScreen
import org.junit.Rule
import org.junit.Test

// A record forgotten elsewhere (the page, the helper itself) since the list was read: forgetting it
// from the phone is answered 404. The owner is told, and the list is read again, without it.
class MemoryTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aRecordForgottenElsewhereLeavesTheListShown() {
        val kept = mutableListOf(MemoryRecord("person.dana", "Dana, the client", emptyList(), 1.0), MemoryRecord("pref.notify", "Failures only", emptyList(), 2.0))
        var forgottenElsewhere = false
        rule.setContent {
            KeelTheme(1) {
                MemoryScreen(
                    list = { MemoryList(kept.filter { !(forgottenElsewhere && it.key == "person.dana") }, kept.size - (if (forgottenElsewhere) 1 else 0)) },
                    forget = { throw ApiError(404, "no such record") },
                )
            }
        }
        rule.waitUntil(3000) { rule.onAllNodes(hasContentDescription("memory-person.dana")).fetchSemanticsNodes().isNotEmpty() }
        forgottenElsewhere = true
        rule.onNodeWithContentDescription("Forget person.dana").performClick()
        rule.onNodeWithText("Forget").performClick()
        rule.waitUntil(3000) { rule.onAllNodes(hasText("person.dana: it was forgotten already.")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("memory-pref.notify").assertIsDisplayed()
        rule.waitUntil(3000) { rule.onAllNodes(hasContentDescription("memory-person.dana")).fetchSemanticsNodes().isEmpty() }
    }
}
