package dev.avifenesh.keel

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import dev.avifenesh.keel.ui.CardView
import dev.avifenesh.keel.ui.KeelTheme
import org.junit.Rule
import org.junit.Test
import kotlinx.coroutines.launch

// A request or a plan is allowed only once every line of it was on the screen. A short one that
// fits its box is not read by fitting: in the transcript (a list opened at its end) a card taller
// than the list shows its buttons and its last lines while its first lines sit above the top.
class ReadFirstTest {
    @get:Rule val rule = createAndroidComposeRule<FragmentActivity>()

    private val lines = (1..6).joinToString("\n") { "$it. Step $it of the work, said in a line." }
    private val plan = Card(
        "plan-s-1.c1", "s-1", "plan", "Split the store", "", listOf(Act("Approve: edits run", "session", "primary"), Act("Approve: each change asks", "once", ""), Act("Keep planning", "deny", "danger")),
        "pending", null, 1.0, emptyList(), text = lines, lines = 6, hold = listOf("plan"),
    )
    private val held = Card(
        "apr-1", "s-1", "permission", "rm -rf build", "Bash", listOf(Act("Approve", "once", "primary"), Act("Deny", "deny", "danger")),
        "pending", null, 1.0, emptyList(), text = lines, lines = 6, hold = listOf("risk"),
    )

    private fun show(c: Card) {
        Prefs.init(rule.activity)
        rule.setContent {
        KeelTheme(1) {
            // The transcript: reversed, so it opens at the card's end.
            LazyColumn(Modifier.fillMaxWidth().height(220.dp).testTag("list"), reverseLayout = true) {
                item { CardView(rule.activity, c) }
            }
        }
        }
    }

    private fun check(c: Card, allow: String) {
        show(c)
        // The buttons and the last lines are on the screen; the first lines are not.
        rule.onNodeWithContentDescription(allow).assertIsNotEnabled()
        rule.onNodeWithContentDescription("deny-${c.id}").assertIsEnabled()
        // Scrolled up to its first lines: every line has been on the screen.
        rule.onNodeWithTag("list").performTouchInput { swipeDown() }
        rule.waitForIdle()
        rule.onNodeWithContentDescription(allow).assertIsEnabled()
    }

    // The keyboard open: a list of 150 dp under the rest of the screen, a plan of 60 lines in its box.
    @Test fun aJumpPastTheMiddleOfAPlanLeavesItUnread() {
        val long = plan.copy(id = "plan-s-1.c2", text = (1..60).joinToString("\n") { "$it. Step $it of the work." }, lines = 60)
        val state = androidx.compose.foundation.lazy.LazyListState()
        lateinit var scope: kotlinx.coroutines.CoroutineScope
        Prefs.init(rule.activity)
        rule.setContent {
            scope = androidx.compose.runtime.rememberCoroutineScope()
            KeelTheme(1) {
                androidx.compose.foundation.layout.Column {
                    androidx.compose.foundation.layout.Spacer(Modifier.height(320.dp))
                    LazyColumn(Modifier.fillMaxWidth().height(150.dp).testTag("list"), state = state, reverseLayout = true) {
                        item { CardView(rule.activity, long) }
                    }
                }
            }
        }
        val box = rule.onNodeWithContentDescription("plan-${long.id}")
        val card = rule.onNodeWithContentDescription("card-${long.id}").fetchSemanticsNode()
        // Where the box's top sits in the card, and how far the list must go to show just that.
        val top = box.fetchSemanticsNode().positionInRoot.y - card.positionInRoot.y
        val list = rule.onNodeWithTag("list").fetchSemanticsNode().size.height
        val off = (card.size.height - top - list).toInt()
        // Up to the box's first lines in one move, then back to the end at a send, in one move.
        rule.runOnIdle { scope.launch { state.scrollToItem(0, off) } }
        rule.waitForIdle()
        rule.runOnIdle { scope.launch { state.scrollToItem(0) } }
        rule.waitForIdle()
        // The box's last lines show: dragged to its end, what was jumped over is still owed.
        box.performTouchInput { repeat(12) { val x = width / 2f; val y = height - 12f; swipe(androidx.compose.ui.geometry.Offset(x, y), androidx.compose.ui.geometry.Offset(x, y - 600f), 400) } }
        rule.waitForIdle()
        rule.onNodeWithContentDescription("read-first-${long.id}").assertExists()
        rule.onNodeWithContentDescription("once-${long.id}").assertIsNotEnabled()
    }

    @Test fun aShortPlanWhoseFirstLinesWereNeverShownIsNotApproved() = check(plan, "once-${plan.id}")
    @Test fun aShortHeldRequestWhoseFirstLinesWereNeverShownIsNotAllowed() = check(held, "once-${held.id}")
}
