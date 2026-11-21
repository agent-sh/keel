package dev.avifenesh.keel

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The app's state under the frames a daemon sends when the connection is not
// kind: a catch-up that arrives late, frames dropped on the way, a cursor the
// daemon cannot catch up from. The frames are built the way the daemon builds
// them (src/integrations/mobile/v1.ts).
class FeedTest {
    private fun msg(id: String, ts: Double, text: String = id, kind: String = "text", role: String = "agent") =
        JSONObject().put("id", id).put("chat_id", "c1").put("role", role).put("kind", kind).put("content", text).put("ts", ts).put("meta", JSONObject())
    private fun card(state: String) = JSONObject().put("id", "q-1").put("chat_id", "c1").put("kind", "question").put("command", "Go?").put("state", state)
        .put("actions", JSONArray()).put("questions", JSONArray())
    private fun chat(updated: Double, status: String = "idle") = JSONObject().put("id", "c1").put("title", "One").put("status", status).put("updated", updated)
    private fun sync(seq: Long, messages: List<JSONObject>, approvals: List<JSONObject> = emptyList(), more: Boolean = false) = JSONObject()
        .put("seq", seq).put("more", more).put("complete", true).put("chats", JSONArray(listOf(chat(seq.toDouble()))))
        .put("messages", JSONArray(messages)).put("approvals", JSONArray(approvals)).put("working", JSONArray())
    private fun frame(type: String) = JSONObject().put("type", type)
    private fun message(seq: Long, m: JSONObject, cursor: Long? = null) = frame("message").put("seq", seq).put("message", m).apply { if (cursor != null) put("cursor", cursor) }
    private fun ids(f: Feed) = f.msgs.value["c1"].orEmpty().map { it.id }

    /** A phone level at 10: one message and an open card. */
    private fun level(): Feed = Feed().also {
        assertFalse(it.frame(frame("hello").put("seq", 10).put("cursor", 10).put("sync", sync(10, listOf(msg("m1", 1.0)), listOf(card("pending"))))))
        assertEquals(10L, it.cursor)
    }

    @Test fun aLateCatchUpRecoversWhatWasMissedUnderANewerLiveMessage() {
        val f = level()
        f.closed()
        // The stream of a daemon that sends no catch-up with it: the app must fetch one, and frames wait for it.
        assertTrue(f.frame(frame("hello").put("seq", 13)))
        // While the catch-up is on its way, a newer message arrives live, and an old frame still calls the card open.
        assertFalse(f.frame(message(13, msg("m3", 3.0))))
        assertFalse(f.frame(frame("approval").put("approval", card("pending"))))
        assertEquals(listOf("m1"), ids(f))
        // The catch-up: the message that was missed, the newer one too, and the card closed elsewhere.
        assertFalse(f.sync(sync(13, listOf(msg("m2", 2.0), msg("m3", 3.0)), listOf(card("approved")))))
        assertFalse(f.end())
        assertEquals(listOf("m1", "m2", "m3"), ids(f))
        assertEquals("approved", f.cards.value["q-1"]?.state)
        assertEquals(13L, f.cursor)
    }

    @Test fun aLiveFrameNeverMovesTheCursorPastWhatMayBeMissing() {
        val f = level()
        // A frame that names a newer place without the daemon's word that all before it was sent.
        f.frame(message(15, msg("m5", 5.0)))
        f.frame(frame("chat").put("seq", 16).put("chat", chat(16.0)))
        assertEquals(10L, f.cursor)
        // The last frame of an event carries the cursor; the heartbeat does too.
        f.frame(message(15, msg("m5.tools", 5.1, kind = "trace"), cursor = 15))
        assertEquals(15L, f.cursor)
        f.frame(frame("seq").put("seq", 20).put("cursor", 18).put("working", JSONArray()))
        assertEquals(18L, f.cursor)
    }

    @Test fun aStreamThatDroppedFramesRecoversOnTheSameStream() {
        val f = level()
        f.frame(message(11, msg("m2", 2.0), cursor = 11))
        // 12 (a message) and the card's closing were dropped; the daemon says so and sends the catch-up from 11.
        assertFalse(f.frame(frame("resync").put("missed", 2).put("seq", 13)))
        assertFalse(f.frame(frame("hello").put("seq", 13).put("cursor", 13).put("sync", sync(13, listOf(msg("m3", 3.0), msg("m4", 4.0)), listOf(card("approved"))))))
        // The frame that was on its way when the stream recovered comes after it: nothing twice.
        f.frame(message(13, msg("m4", 4.0), cursor = 13))
        f.frame(message(14, msg("m5", 5.0), cursor = 14))
        assertEquals(listOf("m1", "m2", "m3", "m4", "m5"), ids(f))
        assertEquals("approved", f.cards.value["q-1"]?.state)
        assertEquals(14L, f.cursor)
    }

    @Test fun aCursorTheDaemonCannotCatchUpFromReadsEverythingAgain() {
        val f = level()
        f.frame(message(11, msg("stale", 2.0), cursor = 11))
        // The daemon's store is behind the cursor (a restored backup): the answer is the whole state.
        f.frame(frame("hello").put("seq", 4).put("cursor", 4).put("sync", sync(4, listOf(msg("m0", 0.5))).put("reload", "ahead")))
        assertEquals(listOf("m0"), ids(f))
        assertTrue(f.cards.value.values.none { it.pending })
        assertEquals(4L, f.cursor)
        assertEquals(1, f.reloads.value)
    }

    @Test fun openingAChatKeepsWhatArrivedAfterItsPage() {
        val f = level()
        // The page was read, then a message arrived live before the page was applied.
        f.frame(message(11, msg("m9", 9.0), cursor = 11))
        f.page("c1", listOf(msg("m0", 0.5), msg("m1", 1.0), msg("other", 0.7, kind = "deleted")).map(Msg::of), "m0")
        assertEquals(listOf("m0", "m1", "m9"), ids(f))
        assertEquals("m0", f.older.value["c1"])
    }

    @Test fun aRowThatWaitedBehindACatchUpDoesNotReplaceANewerOne() {
        val f = level()
        f.closed()
        assertTrue(f.frame(frame("hello").put("seq", 12)))
        f.frame(frame("chat").put("chat", chat(11.0, "working")))
        f.sync(JSONObject().put("seq", 12).put("complete", true).put("chats", JSONArray(listOf(chat(12.0, "done")))))
        f.end()
        assertEquals("done", f.chats.value["c1"]?.status)
    }
}
