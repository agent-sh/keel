package dev.avifenesh.keel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a push says to the notification: the helper's face, and the daemon's digest of what its budget folded together. */
class PushTest {
    private fun msg(vararg kv: Pair<String, String>) = PushMsg.of(mapOf("t" to "agent", "c" to "", "n" to "push_1") + kv)

    @Test fun aDigestIsOneNotificationWithALineForEachCount() {
        val m = msg("title" to "4 more", "body" to "4 more: 1 needs you, 1 failed, 2 done", "ek" to "digest", "pri" to "high")
        assertTrue(m.digest)
        assertEquals(listOf("1 needs you", "1 failed", "2 done"), m.lines)
        // What asks something of the owner leads to the list of it, and the daemon's high mark is the urgent channel.
        assertEquals("needs", m.digestTo)
        assertTrue(m.urgent)
    }

    @Test fun aDigestOfWhatNeedsYouNamesEachOneAndKeepsItsCommas() {
        val m = msg("title" to "3 need you", "body" to "3 need you: Which color, red or blue?; Run rm -rf build?; and 1 more", "ek" to "digest", "pri" to "high")
        assertEquals(listOf("Which color, red or blue?", "Run rm -rf build?", "and 1 more"), m.lines)
        assertEquals("needs", m.digestTo)
    }

    @Test fun aDigestOfWhatNeedsNothingIsQuietAndLeadsToTheSessions() {
        val m = msg("title" to "2 more", "body" to "2 more: 1 report, 1 done", "ek" to "digest", "pri" to "normal")
        assertEquals(listOf("1 report", "1 done"), m.lines)
        assertFalse(m.urgent)
        assertEquals("", m.digestTo)
    }

    @Test fun aPushThatIsNoDigestHasNoLines() {
        val m = msg("title" to "Docs finished", "body" to "Done: all of it", "ek" to "finished")
        assertFalse(m.digest)
        assertEquals(emptyList<String>(), m.lines)
        assertEquals("", m.digestTo)
    }

    @Test fun theHelperAsksForItsFaceByTheMarkOnlyWhenItHasOne() {
        val m = msg("t" to "finished", "title" to "Pip", "body" to "x", "who" to "Pip", "face" to "1k9x2")
        assertEquals("Pip", m.who)
        assertEquals("1k9x2", m.face)
        assertEquals("", msg("title" to "x").who)
    }

    @Test fun aMarkIsAFileNameOrNothing() {
        assertEquals("1k9x2", Face.markOf("1k9x2"))
        assertNull(Face.markOf(""))
        assertNull(Face.markOf("../etc"))
        assertNull(Face.markOf("a".repeat(41)))
    }

    @Test fun aLargePictureIsDecodedSmallerAndASmallOneWhole() {
        assertEquals(1, Face.sampleOf(200, 200))
        assertEquals(1, Face.sampleOf(256, 256))
        assertEquals(2, Face.sampleOf(512, 512))
        assertEquals(4, Face.sampleOf(1024, 700))
    }
}
