package dev.avifenesh.keel

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.TabBar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

// The tab bar at the largest text size Android offers (200%): each of the four labels is read whole,
// not cut to "Sessi…" at a quarter of the phone's width.
class TabsTest {
    @get:Rule val rule = createComposeRule()

    @Test fun everyTabLabelIsWholeAtTheLargestText() {
        rule.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale = 2f)) { KeelTheme(1) { TabBar(0) } }
        }
        val labels = listOf("Sessions", "Needs you", "Usage", "Settings")
        val sizes = mutableSetOf<Float>()
        for (label in labels) {
            val laid = mutableListOf<TextLayoutResult>()
            rule.onNodeWithText(label, useUnmergedTree = true).fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(laid)
            val t = laid.single()
            // (A one-line text that ends in an ellipsis says so per line; its width flag counts the room it was given.)
            assertFalse("\"$label\" is cut at its tab's width (at ${t.layoutInput.style.fontSize})", t.isLineEllipsized(0))
            sizes += t.layoutInput.style.fontSize.value
        }
        // One size for the row, and a gap between neighbours: no two labels run into one.
        assertEquals("the labels are drawn at different sizes: $sizes", 1, sizes.size)
        val boxes = labels.map { rule.onNodeWithText(it, useUnmergedTree = true).getBoundsInRoot() }
        for ((a, b) in boxes.zipWithNext()) assertTrue("labels touch: ${a.right} and ${b.left}", a.right < b.left)
    }

    // The count on Needs you does not move its label: at 200% the badge is taller than the icon, and
    // the four labels still stand on one line.
    @Test fun theNeedsCountLeavesTheLabelsOnOneLine() {
        val card = Card.of(org.json.JSONObject().put("id", "q-1").put("chat_id", "c1").put("kind", "question").put("command", "Go?").put("state", "pending")
            .put("actions", org.json.JSONArray()).put("questions", org.json.JSONArray()))
        val before = Hub.cards.value
        Hub.cards.value = mapOf(card.id to card)
        try {
            rule.setContent {
                val d = LocalDensity.current
                CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale = 2f)) { KeelTheme(1) { TabBar(0) } }
            }
            val tops = listOf("Sessions", "Needs you", "Usage", "Settings").associateWith { rule.onNodeWithText(it, useUnmergedTree = true).getBoundsInRoot().top }
            assertEquals("the labels' tops: $tops", 1, tops.values.toSet().size)
        } finally { Hub.cards.value = before }
    }
}
