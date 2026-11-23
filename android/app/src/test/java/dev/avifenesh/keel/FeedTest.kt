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
    /** Whether the frame asks the caller for a catch-up. */
    private fun Feed.asks(e: JSONObject) = frame(e) is Took.CatchUp

    /** A phone level at 10: one message and an open card. */
    private fun level(): Feed = Feed().also {
        assertFalse(it.asks(frame("hello").put("seq", 10).put("cursor", 10).put("sync", sync(10, listOf(msg("m1", 1.0)), listOf(card("pending"))))))
        assertEquals(10L, it.cursor)
    }

    @Test fun aCardClosedWithoutAnAnswerOpensAgainWhenItIsPutBack() {
        val f = level()
        // The daemon stopped under it (an older daemon said it expired), then put it back on its card.
        f.frame(frame("approval").put("approval", card("expired")))
        assertFalse(f.cards.value.getValue("q-1").pending)
        f.frame(frame("approval").put("approval", card("pending")))
        assertTrue(f.cards.value.getValue("q-1").pending)
        // One that was answered stays answered, whatever an older frame says.
        f.frame(frame("approval").put("approval", card("approved")))
        f.frame(frame("approval").put("approval", card("pending")))
        assertFalse(f.cards.value.getValue("q-1").pending)
    }

    @Test fun aLateCatchUpRecoversWhatWasMissedUnderANewerLiveMessage() {
        val f = level()
        f.closed()
        // The stream of a daemon that sends no catch-up with it: the app must fetch one, and frames wait for it.
        assertTrue(f.asks(frame("hello").put("seq", 13)))
        // While the catch-up is on its way, a newer message arrives live, and an old frame still calls the card open.
        assertFalse(f.asks(message(13, msg("m3", 3.0))))
        assertFalse(f.asks(frame("approval").put("approval", card("pending"))))
        assertEquals(listOf("m1"), ids(f))
        // The catch-up: the message that was missed, the newer one too, and the card closed elsewhere.
        assertFalse(f.sync(sync(13, listOf(msg("m2", 2.0), msg("m3", 3.0)), listOf(card("approved")))))
        assertFalse(f.end() is Took.CatchUp)
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
        assertFalse(f.asks(frame("resync").put("missed", 2).put("seq", 13)))
        assertFalse(f.asks(frame("hello").put("seq", 13).put("cursor", 13).put("sync", sync(13, listOf(msg("m3", 3.0), msg("m4", 4.0)), listOf(card("approved"))))))
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
        f.page("c1", JSONObject().put("older", "m0").put("messages", JSONArray(listOf(msg("m0", 0.5), msg("m1", 1.0), msg("other", 0.7, kind = "deleted")))))
        assertEquals(listOf("m0", "m1", "m9"), ids(f))
        assertEquals("m0", f.older.value["c1"])
    }

    @Test fun aBranchPickedOnTheDesktopReplacesTheTranscript() {
        val f = level()
        f.frame(message(11, msg("new-1", 2.0), cursor = 11))
        f.frame(message(12, msg("new-2", 3.0), cursor = 12))
        // The desktop shows the other branch: no event is stored, the chat's page comes whole.
        f.frame(frame("chat_reset").put("seq", 13).put("chat_id", "c1").put("older", "m0").put("chat", chat(13.0))
            .put("messages", JSONArray(listOf(msg("m1", 1.0), msg("old-1", 2.5), msg("new-1", 2.0, kind = "deleted"), msg("new-2", 3.0, kind = "deleted")))))
        assertEquals(listOf("m1", "old-1"), ids(f))
        assertEquals("m0", f.older.value["c1"])
        // What is stored on the chosen branch next is an ordinary message.
        f.frame(message(14, msg("old-2", 4.0), cursor = 14))
        assertEquals(listOf("m1", "old-1", "old-2"), ids(f))
    }

    @Test fun aBranchPickedWhileAwayComesWithTheCatchUp() {
        val f = level()
        f.frame(message(11, msg("new-1", 2.0), cursor = 11))
        f.closed()
        // Back: the chat's branch changed since the cursor; another chat only got a message.
        val elsewhere = msg("x1", 1.0).put("chat_id", "c2")
        f.frame(frame("hello").put("seq", 15).put("cursor", 15).put("sync", sync(15, listOf(msg("m1", 1.0), msg("old-1", 2.5), elsewhere))
            .put("reset", JSONArray(listOf(JSONObject().put("chat_id", "c1").put("older", JSONObject.NULL))))))
        assertEquals(listOf("m1", "old-1"), ids(f))
        assertEquals(null, f.older.value["c1"])
        assertEquals(listOf("x1"), f.msgs.value["c2"].orEmpty().map { it.id })
    }

    @Test fun aFrameThatCannotBeAppliedStopsTheStreamAtTheLastGoodCursor() {
        val f = level()
        f.frame(message(11, msg("m2", 2.0), cursor = 11))
        // A frame whose text is cut short, as a connection that dies inside it leaves it.
        val cut = f.take("""{"type":"message","seq":12,"message":{"id":"m3","chat_id":"c1"""")
        assertTrue(cut is Took.Broken)
        assertTrue((cut as Took.Broken).reason.contains("could not be read"))
        // What follows on the same stream is not applied: its cursor would pass what the lost frame carried.
        assertTrue(f.frame(message(13, msg("m4", 4.0), cursor = 13)) is Took.Broken)
        assertTrue(f.take(frame("seq").put("seq", 14).put("cursor", 14).put("working", JSONArray()).toString()) is Took.Broken)
        assertEquals(listOf(11L, listOf("m1", "m2")), listOf(f.cursor, ids(f)))
        // The stream is closed and opened again from 11: the daemon sends what was lost, and it goes on.
        f.closed()
        assertTrue(f.frame(frame("hello").put("seq", 13).put("cursor", 13).put("sync", sync(13, listOf(msg("m3", 3.0), msg("m4", 4.0))))) is Took.Applied)
        assertEquals(listOf(13L, listOf("m1", "m2", "m3", "m4")), listOf(f.cursor, ids(f)))
    }

    @Test fun aFrameThatThrowsWhileItIsAppliedDoesNotMoveTheCursor() {
        val f = level()
        // The daemon's steps are objects; this one is not, and reading it throws.
        val bad = msg("m2.tools", 2.1, kind = "trace").put("meta", JSONObject().put("steps", JSONArray(listOf("not a step"))))
        val step = f.frame(message(11, bad, cursor = 11))
        assertTrue(step is Took.Broken)
        assertTrue((step as Took.Broken).reason.contains("message frame"))
        assertEquals(10L, f.cursor)
        // A frame that waited behind a catch-up and fails when its turn comes ends the stream the same way.
        f.closed()
        assertTrue(f.asks(frame("hello").put("seq", 12)))
        f.frame(message(12, bad, cursor = 12))
        f.sync(sync(12, listOf(msg("m2", 2.0))))
        assertTrue(f.end() is Took.Broken)
        assertEquals(12L, f.cursor) // the catch-up's own place, not the failed frame's
    }

    @Test fun aSendThatFailedHereButArrivedIsDone() {
        val f = level()
        f.frame(message(11, msg("u1", 2.0, text = "continue", role = "user"), cursor = 11))
        // The owner sends "continue" again; the answer is lost. What is held then is the mark.
        val after = newestTs(f.msgs.value["c1"].orEmpty())
        assertEquals(2.0, after, 0.0)
        assertFalse(sendArrived(f.msgs.value["c1"].orEmpty(), "continue", after))
        // The agent saying the same words is not the owner's send.
        f.frame(message(12, msg("a1", 3.0, text = "continue"), cursor = 12))
        assertFalse(sendArrived(f.msgs.value["c1"].orEmpty(), "continue", after))
        // The daemon did store it: the owner's message comes with the stream. The send is done, its id is let go.
        f.frame(message(13, msg("u2", 4.0, text = "continue", role = "user"), cursor = 13))
        assertTrue(sendArrived(f.msgs.value["c1"].orEmpty(), "continue", after))
        assertFalse(sendArrived(f.msgs.value["c1"].orEmpty(), "other words", after))
    }

    @Test fun aPageAskedForBeforeABranchChangeIsDropped() {
        val f = level()
        val asked = f.generation("c1")
        // While the page (and an older page) is on its way, the computer shows another branch.
        f.frame(frame("chat_reset").put("seq", 13).put("chat_id", "c1").put("older", "n0").put("chat", chat(13.0))
            .put("messages", JSONArray(listOf(msg("n1", 1.5), msg("n2", 2.5)))))
        val left = JSONObject().put("older", "m0").put("messages", JSONArray(listOf(msg("m0", 0.5), msg("m1", 1.0))))
        f.page("c1", left, asked)
        f.olderPage("c1", left, asked)
        assertEquals(listOf("n1", "n2"), ids(f))
        assertEquals("n0", f.older.value["c1"])
        // A page asked for after it is the chosen branch's.
        f.page("c1", JSONObject().put("older", JSONObject.NULL).put("messages", JSONArray(listOf(msg("n0", 1.0), msg("n1", 1.5), msg("n2", 2.5)))), f.generation("c1"))
        assertEquals(listOf("n0", "n1", "n2"), ids(f))
        // Everything read again (a cursor that cannot be caught up from) outdates a page too.
        val before = f.generation("c1")
        f.frame(frame("hello").put("seq", 4).put("cursor", 4).put("sync", sync(4, listOf(msg("z1", 0.5))).put("reload", "ahead")))
        f.page("c1", left, before)
        assertEquals(listOf("z1"), ids(f))
    }

    @Test fun aRowThatWaitedBehindACatchUpDoesNotReplaceANewerOne() {
        val f = level()
        f.closed()
        assertTrue(f.asks(frame("hello").put("seq", 12)))
        f.frame(frame("chat").put("chat", chat(11.0, "working")))
        f.sync(JSONObject().put("seq", 12).put("complete", true).put("chats", JSONArray(listOf(chat(12.0, "done")))))
        f.end()
        assertEquals("done", f.chats.value["c1"]?.status)
    }
}
