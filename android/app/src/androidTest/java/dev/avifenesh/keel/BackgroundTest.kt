package dev.avifenesh.keel

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import dev.avifenesh.keel.ui.FrontCommand
import dev.avifenesh.keel.ui.KeelTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// Move to the background on a command the turn waits on: shown while it is in front, sent once, and told when it is too late.
class BackgroundTest {
    @get:Rule val rule = createComposeRule()

    private val front = Front("job_1", "toolu_9", "Run the unit tests", 1.0)

    @Test fun aCommandInFrontCanBeMovedAndThenIsGone() {
        var there: Front? = front
        val moved = mutableListOf<String?>()
        rule.setContent { KeelTheme(2) { FrontCommand("s-1", "m1", read = { there }, move = { call -> moved += call; there = null; true }, every = 200) } }
        rule.onNodeWithContentDescription("command-in-front").assertExists()
        rule.onNodeWithContentDescription("move-to-background").performClick()
        rule.waitUntil(3000) { moved.isNotEmpty() }
        // The call the owner saw is the one moved, once; the command is gone from the row and the owner is told what happened.
        assertEquals(listOf<String?>("toolu_9"), moved)
        rule.waitUntil(3000) { rule.onAllNodesWithContentDescriptionCount("command-in-front") == 0 }
        rule.onNodeWithContentDescription("move-said").assertExists()
    }

    @Test fun aCommandThatEndedFirstIsToldNotMoved() {
        var there: Front? = front
        rule.setContent { KeelTheme(2) { FrontCommand("s-1", "m1", read = { there }, move = { false }, every = 60_000) } }
        rule.onNodeWithContentDescription("move-to-background").performClick()
        rule.waitUntil(3000) { rule.onAllNodesWithContentDescriptionCount("move-said") == 1 }
        rule.onNodeWithContentDescription("move-said").assertExists()
        there = null
    }

    @Test fun nothingShowsWhileNoCommandIsInFront() {
        rule.setContent { KeelTheme(2) { FrontCommand("s-1", "m1", read = { null }, move = { true }, every = 60_000) } }
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithContentDescriptionCount("command-in-front"))
        assertEquals(0, rule.onAllNodesWithContentDescriptionCount("move-said"))
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithContentDescriptionCount(d: String) =
        onAllNodesWithContentDescription(d).fetchSemanticsNodes().size
}
