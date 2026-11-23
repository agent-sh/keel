package dev.avifenesh.keel

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.ui.FollowingList
import dev.avifenesh.keel.ui.KeelTheme
import org.junit.Rule
import org.junit.Test

// The transcript keeps the newest message on the screen while the owner is at the end, and after
// the owner's own send; read further up, it stays where it is and offers the way back down.
class TranscriptTest {
    @get:Rule val rule = createComposeRule()

    private data class Row(val id: String, val mine: Boolean)

    private fun show(rows: MutableList<Row>) = rule.setContent {
        KeelTheme(1) {
            val newest = rows.lastOrNull()
            FollowingList(newest?.id, newest?.mine == true, 0, Modifier.size(360.dp, 640.dp).testTag("list")) {
                // Newest at the bottom: the list runs reversed.
                items(rows.asReversed(), key = { it.id }) { r -> Text(r.id, Modifier.fillMaxWidth().height(220.dp).testTag(r.id)) }
            }
        }
    }

    @Test fun aNewReplyAndTheOwnersSendStayOnTheScreen() {
        val rows = mutableStateListOf(Row("a1", false), Row("a2", false), Row("a3", false), Row("a4", false))
        show(rows)
        rule.onNodeWithTag("a4").assertIsDisplayed()
        // The owner sends, then the reply comes: each lands where it is seen.
        rule.runOnIdle { rows += Row("me5", true) }
        rule.onNodeWithTag("me5").assertIsDisplayed()
        rule.runOnIdle { rows += Row("a6", false) }
        rule.onNodeWithTag("a6").assertIsDisplayed()
    }

    @Test fun readingFurtherUpIsNotMovedAndOffersTheWayDown() {
        val rows = mutableStateListOf(Row("a1", false), Row("a2", false), Row("a3", false), Row("a4", false), Row("a5", false))
        show(rows)
        rule.onNodeWithTag("list").performTouchInput { swipeDown() }
        rule.waitForIdle()
        rule.onNodeWithTag("a1").assertIsDisplayed()
        // A reply arrives while the owner reads an older one: the view stays, a button leads down.
        rule.runOnIdle { rows += Row("a6", false) }
        rule.onNodeWithTag("a1").assertIsDisplayed()
        rule.onNodeWithTag("to-latest").assertIsDisplayed().performClick()
        rule.onNodeWithTag("a6").assertIsDisplayed()
        // The owner's own send always brings the view down.
        rule.onNodeWithTag("list").performTouchInput { swipeDown() }
        rule.runOnIdle { rows += Row("me7", true) }
        rule.onNodeWithTag("me7").assertIsDisplayed()
    }
}

// A reply's words leave the phone: the whole reply by its copy button, a code block by its own.
class CopyTest {
    @get:Rule val rule = createComposeRule()

    private fun clip(): String {
        var text = ""
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val c = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(android.content.ClipboardManager::class.java)
            text = c.primaryClip?.getItemAt(0)?.text?.toString().orEmpty()
        }
        return text
    }

    @Test fun aReplyAndItsCodeAreCopied() {
        val reply = "Run this:\n\n```sh\ngit push origin main\n```\n\nThen check CI."
        rule.setContent { KeelTheme(1) { dev.avifenesh.keel.ui.Reply(Msg("e-1", "s-1", "agent", "text", reply, 1.0, model = "fx:m")) } }
        rule.onNodeWithTag("copy-reply").performClick()
        rule.waitForIdle()
        org.junit.Assert.assertEquals(reply, clip())
        rule.onNodeWithTag("copy-code").performClick()
        rule.waitForIdle()
        org.junit.Assert.assertEquals("git push origin main", clip())
    }
}
