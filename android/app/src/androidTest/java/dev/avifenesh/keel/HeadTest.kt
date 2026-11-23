package dev.avifenesh.keel

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import dev.avifenesh.keel.ui.Head
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.Txt
import dev.avifenesh.keel.ui.T
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

// A screen's head at the largest text size Android offers (200%): its second line, where the list says
// whether the phone is connected, is drawn whole inside the head, not cut by it.
class HeadTest {
    @get:Rule val rule = createComposeRule()

    @Test fun theHeadsSecondLineIsWholeAtTheLargestText() {
        rule.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale = 2f)) {
                KeelTheme(1) { Box(Modifier.testTag("head")) { Head("Sessions", sub = { Txt("desk · Live", T.meta) }) } }
            }
        }
        val head = rule.onNodeWithTag("head").getBoundsInRoot()
        val title = rule.onNodeWithText("Sessions").getBoundsInRoot()
        val sub = rule.onNodeWithText("desk · Live").getBoundsInRoot()
        assertTrue("the second line ends at ${sub.bottom}, under the head's end at ${head.bottom}", sub.bottom <= head.bottom)
        // Neither line is cut inside its own box: the head gives each its whole height.
        for (words in listOf("Sessions", "desk · Live")) {
            val laid = mutableListOf<TextLayoutResult>()
            rule.onNodeWithText(words).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(laid)
            assertTrue("\"$words\" is cut at the bottom of its line", !laid.single().didOverflowHeight)
        }
        assertTrue("the second line starts at ${sub.top}, over the title's end at ${title.bottom}", sub.top >= title.bottom)
    }
}
