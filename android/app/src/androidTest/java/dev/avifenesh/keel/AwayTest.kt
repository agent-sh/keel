package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.SessionList
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// What happened while the owner was away, at the top of the list: open by itself when something failed,
// each session opening from it, and gone once seen.
class AwayTest {
    @get:Rule val rule = createComposeRule()

    private val away = Away(
        span = "While you were away, 14:00 to 16:00 +02:00 (2 h)", brief = "3 turns ended, 1 failed; 1 approval waits",
        totals = "", daemon = listOf("The daemon went down at 14:40 and came back after 29 s."), present = true, failed = 1, waiting = 1, quiet = 4,
        sessions = listOf(
            AwaySession("s-a", "Fix the build", "Failed", "fail", "2 turns ended, 1 failed (provider); \$0.12", "1 failed (provider)"),
            AwaySession("s-b", "Docs", "Done", "done", "1 turn ended; agents: 2 ended; \$0.03"),
        ),
    )

    @Test fun theDigestSaysWhatFailedAndGoesOnceSeen() {
        var seen = 0
        rule.setContent { KeelTheme(1) { SessionList(emptyList(), now = 0.0, away = away, onSeen = { seen++ }) } }
        rule.onNodeWithText("3 turns ended, 1 failed; 1 approval waits").assertIsDisplayed()
        rule.onNodeWithText("14:00 to 16:00 +02:00 (2 h)").assertIsDisplayed()
        // Something failed: it is open, the failed session first, the daemon's account above.
        rule.onNodeWithContentDescription("away-Fix the build").assertIsDisplayed()
        rule.onNodeWithText("The daemon went down at 14:40 and came back after 29 s.").assertIsDisplayed()
        rule.onNodeWithText("4 other sessions: nothing happened.").assertIsDisplayed()
        rule.onNodeWithContentDescription("away-head").performClick()
        rule.onNodeWithContentDescription("away-Fix the build").assertDoesNotExist()
        rule.onNodeWithContentDescription("away-head").performClick()
        rule.onNodeWithContentDescription("away-seen").performClick()
        assertEquals(1, seen)
    }

    @Test fun nothingToTellShowsNothing() {
        rule.setContent { KeelTheme(2) { SessionList(emptyList(), now = 0.0, away = null) } }
        rule.onNodeWithContentDescription("away").assertDoesNotExist()
    }
}
