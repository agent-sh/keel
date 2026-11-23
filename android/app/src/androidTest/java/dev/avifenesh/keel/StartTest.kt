package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollTo
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.StartSheet
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

// A task started from the phone: the message, the folder, the model, and another machine of the fleet.
class StartTest {
    @get:Rule val rule = createComposeRule()

    private val offer = Start(
        model = "fx:default",
        models = listOf(StartModel("fx:default", "Default model"), StartModel("fx:fast", "Fast model")),
        folders = listOf(StartFolder("/home/me/projects/app", "app", 1.0), StartFolder("/home/me/projects/site", "site", 1.0), StartFolder("/home/me", "me", home = true)),
        machines = listOf(StartMachine("local", "desk", true), StartMachine("m_7", "build box", true, "/srv/work"), StartMachine("m_8", "laptop", false, "/home/x")),
    )

    @Test fun aTaskStartsWhereAndOnWhatTheSheetChose() {
        val started = mutableListOf<NewChat>()
        rule.setContent { KeelTheme(1) { StartSheet(offer, busy = false, error = "", onStart = { started += it }, onClose = {}) } }
        // Untouched, it starts in the newest folder on the default model.
        rule.onNodeWithContentDescription("start-text").performTextInput("Find why the build fails on main")
        rule.onNodeWithContentDescription("folder-site").performClick()
        rule.onNodeWithContentDescription("start-model").performScrollTo().performClick()
        rule.onNodeWithContentDescription("model-fx:fast").performScrollTo().performClick()
        rule.onNodeWithText("Fast model").assertIsDisplayed()
        rule.onNodeWithContentDescription("start-go").performClick()
        assertEquals(NewChat(model = "fx:fast", workspace = "/home/me/projects/site", machine = "local", text = "Find why the build fails on main"), started.single())
        // On another machine: its granted folder, said; one that is offline cannot be picked.
        rule.onNodeWithContentDescription("machine-laptop").assertIsNotEnabled()
        rule.onNodeWithText("laptop (offline)").assertIsDisplayed()
        rule.onNodeWithContentDescription("machine-build box").performClick()
        rule.onNodeWithText("It starts in /srv/work on build box.").assertIsDisplayed()
        rule.onNodeWithContentDescription("start-go").performClick()
        assertEquals(NewChat(model = "fx:fast", workspace = "", machine = "m_7", text = "Find why the build fails on main"), started.last())
    }

    @Test fun withNothingChosenItStartsOnTheDaemonsDefaults() {
        val started = mutableListOf<NewChat>()
        rule.setContent { KeelTheme(2) { StartSheet(null, busy = false, error = "", onStart = { started += it }, onClose = {}) } }
        rule.onNodeWithContentDescription("start-go").performClick()
        assertEquals("{}", started.single().body().toString())
    }
}
