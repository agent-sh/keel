package dev.avifenesh.keel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a push says to the notification: the helper's face. */
class PushTest {
    private fun msg(vararg kv: Pair<String, String>) = PushMsg.of(mapOf("t" to "agent", "c" to "", "n" to "push_1") + kv)

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
