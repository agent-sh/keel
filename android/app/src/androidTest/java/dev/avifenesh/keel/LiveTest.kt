package dev.avifenesh.keel

import android.app.Notification
import android.app.NotificationManager
import android.service.notification.StatusBarNotification
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The lasting notification: one, ongoing and silent, while something runs or waits, replaced by each
// update, and gone when nothing does.
class LiveTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val nm = ctx.getSystemService(NotificationManager::class.java)
    private fun shown() = nm.activeNotifications.filter { it.tag == Notify.LIVE }
    // The notification service takes a post or a cancel on its own thread: what it shows is read once it
    // got there (5 s at most, then the test reads what is shown).
    private fun settled(ok: (List<StatusBarNotification>) -> Boolean): List<StatusBarNotification> {
        val end = System.currentTimeMillis() + 5_000
        var s = shown()
        while (!ok(s) && System.currentTimeMillis() < end) { Thread.sleep(20); s = shown() }
        return s
    }
    private fun title(s: List<StatusBarNotification>) = s.singleOrNull()?.notification?.extras?.getString(Notification.EXTRA_TITLE)

    @Test fun oneOngoingNotificationWhileSomethingRunsGoneWhenNothingDoes() {
        // A fresh install has not been granted notifications yet (Android 13 and later ask).
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(ctx.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        Notify.channels(ctx)
        Notify.live(ctx, Live(2, 1, "2 sessions working · 1 needs you", "Fix the build · Docs", System.currentTimeMillis() - 60_000))
        val first = settled { title(it) == "2 sessions working · 1 needs you" }.single().notification
        assertTrue("it stays until nothing runs", first.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals("2 sessions working · 1 needs you", first.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(Notify.LIVE, first.channelId)
        assertEquals(NotificationManager.IMPORTANCE_LOW, nm.getNotificationChannel(Notify.LIVE).importance)
        // An update replaces it: still one.
        Notify.live(ctx, Live(1, 0, "1 session working", "Docs"))
        assertEquals("1 session working", title(settled { title(it) == "1 session working" }))
        Notify.live(ctx, Live(0, 0, "", ""))
        assertEquals(0, settled { it.isEmpty() }.size)
    }

    @Test fun aLivePushWhileTheAppIsInFrontPutsNothingUp() {
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(ctx.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        Notify.channels(ctx)
        val was = Ui.inFront
        try {
            Notify.live(ctx, Live(0, 0, "", ""))
            assertEquals(0, settled { it.isEmpty() }.size)
            Ui.inFront = true
            assertFalse("in front, a push puts nothing up", Notify.livePush(ctx, Live(1, 0, "1 session working", "Docs")))
            // In the back: it is shown; back in front, the push that says nothing runs takes it down.
            Ui.inFront = false
            assertTrue(Notify.livePush(ctx, Live(1, 0, "1 session working", "Docs")))
            assertEquals("1 session working", title(settled { it.size == 1 }))
            Ui.inFront = true
            assertTrue(Notify.livePush(ctx, Live(0, 0, "", "")))
            assertEquals(0, settled { it.isEmpty() }.size)
        } finally { Ui.inFront = was; Notify.live(ctx, Live(0, 0, "", "")) }
    }
}
