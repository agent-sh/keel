package dev.avifenesh.keel

import android.app.Notification
import android.app.NotificationManager
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The lasting notification: one, ongoing and silent, while something runs or waits, replaced by each
// update, and gone when nothing does.
class LiveTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val nm = ctx.getSystemService(NotificationManager::class.java)
    private fun shown() = nm.activeNotifications.filter { it.tag == Notify.LIVE }

    @Test fun oneOngoingNotificationWhileSomethingRunsGoneWhenNothingDoes() {
        // A fresh install has not been granted notifications yet (Android 13 and later ask).
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(ctx.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        Notify.channels(ctx)
        Notify.live(ctx, Live(2, 1, "2 sessions working · 1 needs you", "Fix the build · Docs", System.currentTimeMillis() - 60_000))
        val first = shown().single().notification
        assertTrue("it stays until nothing runs", first.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals("2 sessions working · 1 needs you", first.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(Notify.LIVE, first.channelId)
        assertEquals(NotificationManager.IMPORTANCE_LOW, nm.getNotificationChannel(Notify.LIVE).importance)
        // An update replaces it: still one.
        Notify.live(ctx, Live(1, 0, "1 session working", "Docs"))
        assertEquals("1 session working", shown().single().notification.extras.getString(Notification.EXTRA_TITLE))
        Notify.live(ctx, Live(0, 0, "", ""))
        assertEquals(0, shown().size)
    }
}
