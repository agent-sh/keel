package dev.avifenesh.keel

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// What the notifications look like in the shade: the digest as one notification with its lines, the helper's own with its face.
class NotifyTest {
    private val inst = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context = inst.targetContext
    private val nm = ctx.getSystemService(NotificationManager::class.java)

    @Before fun grant() {
        inst.uiAutomation.grantRuntimePermission(ctx.packageName, Manifest.permission.POST_NOTIFICATIONS)
        Notify.channels(ctx)
        nm.cancelAll()
    }

    @After fun clear() { nm.cancelAll() }

    private fun push(vararg kv: Pair<String, String>) = PushMsg.of(mapOf("c" to "", "n" to "push_1") + kv)

    private fun post(m: PushMsg, face: Bitmap? = null) = Notify.post(ctx, m.kind, m.chat, m.title, m.body, m.card, m.allows, m.open, m, face)

    @Test fun aDigestIsOneNotificationWithALineForEachCount() {
        post(push("t" to "agent", "title" to "4 more", "body" to "4 more: 1 needs you, 1 failed, 2 done", "ek" to "digest", "pri" to "high"))
        // The same digest again, a minute later with other counts, replaces it rather than stacking.
        post(push("t" to "agent", "title" to "5 more", "body" to "5 more: 1 needs you, 1 failed, 3 done", "ek" to "digest", "pri" to "high"))
        val shown = nm.activeNotifications.filter { it.tag == "keel-digest" }
        assertEquals(1, shown.size)
        val n = shown.single().notification
        assertEquals("5 more", n.extras.getCharSequence(Notification.EXTRA_TITLE_BIG)?.toString() ?: n.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertEquals(listOf("1 needs you", "1 failed", "3 done"), n.extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)!!.map { it.toString() })
        // What needs the owner is on the urgent channel.
        assertEquals(Notify.NEEDS, n.channelId)
    }

    @Test fun aQuietDigestIsOnTheQuietChannel() {
        post(push("t" to "agent", "title" to "2 more", "body" to "2 more: 1 report, 1 done", "ek" to "digest", "pri" to "normal"))
        assertEquals(Notify.UPDATES, nm.activeNotifications.single().notification.channelId)
    }

    @Test fun theHelpersNotificationCarriesItsNameAndFace() {
        val face = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF2E7D32.toInt()) }
        post(push("t" to "finished", "c" to "s-helper", "title" to "Fix the build finished", "body" to "The tests pass.", "ek" to "finished", "who" to "Pip", "face" to "1k9x2"), face)
        val n = nm.activeNotifications.single().notification
        assertEquals("Pip", n.extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString())
        assertNotNull(n.getLargeIcon())
        // Another session's notification has neither.
        nm.cancelAll()
        post(push("t" to "finished", "c" to "s-2", "title" to "Docs finished", "body" to "Done.", "ek" to "finished"))
        val o = nm.activeNotifications.single().notification
        assertNull(o.extras.getCharSequence(Notification.EXTRA_SUB_TEXT))
        assertNull(o.getLargeIcon())
        assertTrue(true)
    }
}
