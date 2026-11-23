package dev.avifenesh.keel

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.SpanStyle
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.Markdown
import dev.avifenesh.keel.ui.inline
import dev.avifenesh.keel.ui.mathText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

// Math on the phone itself, where text and regular expressions are ICU's: a reply with math is set,
// and replies made to be slow or deep are set on the UI thread in bounded time.
class MathTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aReplyWithMathIsSetAndHostileRepliesAreBounded() {
        rule.setContent { KeelTheme(1) { Markdown("Merge sort costs \$O(n)\$ a level:\n\n\$\$ T(n) = 2T\\left(\\frac{n}{2}\\right) + O(n) \$\$\n\nA price like \$5 and \$10 stays text.") } }
        rule.onAllNodesWithTag("math").fetchSemanticsNodes().let { assertEquals(1, it.size) }
        rule.onNodeWithText("A price like \$5 and \$10 stays text.").assertIsDisplayed()
        val sp = SpanStyle()
        rule.runOnUiThread {
            val took = mutableListOf<Pair<String, Long>>()
            fun timed(name: String, f: () -> Unit) { val t0 = System.nanoTime(); f(); took += name to (System.nanoTime() - t0) / 1_000_000 }
            timed("20,000 braces") { assertEquals("{".repeat(20_000) + "x" + "}".repeat(20_000), mathText("{".repeat(20_000) + "x" + "}".repeat(20_000))) }
            timed("30 KB of prices") { inline("costs \$5 " + "word ".repeat(6000) + "\$6 x", sp, sp) }
            timed("a megabyte of lone \$") { inline("\$ ".repeat(500_000), sp, sp) }
            timed("a megabyte of \$x\$") { inline("\$x\$ ".repeat(250_000), sp, sp) }
            timed("100,000 distinct formulas") { inline((0 until 100_000).joinToString(" ") { "\$x_{$it}\$" }, sp, sp) }
            timed("a megabyte of [") { inline("[".repeat(1_000_000), sp, sp) }
            println("MATH-HOSTILE $took")
            assertTrue("hostile replies took $took on the UI thread", took.all { it.second < 2_000 })
        }
    }
}
