package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsEnabled
import androidx.fragment.app.FragmentActivity
import dev.avifenesh.keel.ui.CardView
import dev.avifenesh.keel.ui.KeelTheme
import org.junit.Rule
import org.junit.Test

// A question whose choices the model explained: the phone shows what each choice means under its
// label, and the question's header above it, as the page does. A choice is still picked with one tap.
class QuestionTest {
    @get:Rule val rule = createAndroidComposeRule<FragmentActivity>()

    private val card = Card(
        "q-s-1.call-1", "s-1", "question", "Fix only cart.js or the whole module?", "", listOf(Act("Answer", "once", "primary"), Act("Dismiss", "deny", "danger")),
        "pending", null, 1.0,
        listOf(Question("0", "Fix only cart.js or the whole module?", listOf("Only cart.js", "Whole module", "Ask the team"), false,
            details = listOf("Smallest change, ships today", "Every caller of the helper gets the bound", ""), header = "Scope")),
    )

    @Test fun eachChoiceSaysWhatItMeans() {
        rule.setContent { KeelTheme(1) { CardView(rule.activity, card) } }
        rule.onNodeWithText("Smallest change, ships today").assertIsDisplayed()
        rule.onNodeWithText("Every caller of the helper gets the bound").assertIsDisplayed()
        rule.onNodeWithText("SCOPE").assertIsDisplayed()
        rule.onNodeWithContentDescription("option-Whole module").performClick()
        rule.onNodeWithContentDescription("answer-q-s-1.call-1").assertIsEnabled()
    }
}
