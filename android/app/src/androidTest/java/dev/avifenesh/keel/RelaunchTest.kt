package dev.avifenesh.keel

import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The link or notification that opened the app is taken once. A screen made again (the text size, the
// dark theme or the turn of the phone changed) keeps what the owner did since: a pairing they cancelled
// does not ask again, and the session they left is not opened again.
class RelaunchTest {
    @Test fun aScreenMadeAgainDoesNotTakeTheLinkThatOpenedItAgain() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val link = "keel://pair?u=http%3A%2F%2F10.0.2.2%3A47988&c=abc123&n=desk"
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(ctx, MainActivity::class.java)
        ActivityScenario.launch<MainActivity>(open).use { s ->
            s.onActivity { assertEquals("abc123", Ui.link.value?.code) }
            // The owner cancels the pairing, then changes the text size: the screen is made again.
            s.onActivity { Ui.link.value = null }
            s.recreate()
            s.onActivity { assertNull("the pairing asked again after the screen was made again", Ui.link.value) }
        }
    }
}
