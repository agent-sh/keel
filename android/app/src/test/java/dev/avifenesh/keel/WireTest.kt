package dev.avifenesh.keel

import dev.avifenesh.keel.ui.Block
import dev.avifenesh.keel.ui.blocks
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Pure logic of the app. What it shares with the daemon (signed bytes, shapes) is in ContractTest.
class WireTest {
    @Test fun aSendKeepsItsIdForTheSameWords() {
        var n = 0
        val fresh = { "id-${++n}" }
        val first = Wire.sendId("", "", "ship it", fresh)
        assertEquals("id-1", first)
        // The answer was lost: the same words go under the same id.
        assertEquals("id-1", Wire.sendId(first, "ship it", "ship it", fresh))
        // Other words are another send.
        assertEquals("id-2", Wire.sendId(first, "ship it", "ship it now", fresh))
        val body = Wire.sendBody("ship it", "steer", first)
        assertEquals(listOf("ship it", "steer", "id-1"), listOf(body.getString("text"), body.getString("mode"), body.getString("client_id")))
    }

    @Test fun aFailedReadOfEarlierMessagesOffersTheRightWayOn() {
        // The cursor is no longer on the shown branch: the same page cannot be read again.
        assertEquals(Earlier.RELOAD, earlierAfter(409))
        // The daemon was busy, or out of reach (no HTTP code at all).
        assertEquals(Earlier.AGAIN, earlierAfter(503))
        assertEquals(Earlier.AGAIN, earlierAfter(null))
    }

    @Test fun unpairingSaysWhetherTheDaemonRevokedThePhone() {
        // Online: the daemon confirms. A daemon that had revoked the phone already no longer knows its token.
        assertEquals(Unpaired(true, "Unpaired. desk no longer accepts this phone."), unpaired(JSONObject().put("ok", true), null, null, "desk"))
        assertEquals(true, unpaired(null, 401, "unauthorized", "desk").revoked)
        // Offline (no answer, no HTTP code), an error from the daemon, an answer that does not confirm, and a 401
        // for another reason (the phone's clock is off, so its signature is refused): local only.
        val local = listOf(
            unpaired(null, null, null, "desk"), unpaired(null, 503, "HTTP 503", "desk"), unpaired(JSONObject().put("ok", false), null, null, "desk"),
            unpaired(null, 401, "bad signature", "desk"), unpaired(null, 401, "Not authorized (HTTP 401)", "desk"),
        )
        for (u in local) {
            assertEquals(false, u.revoked)
            assertEquals(true, u.note.contains("did not confirm") && u.note.contains("Settings, then Phone"))
        }
    }

    @Test fun pairLinks() {
        val l = Wire.parsePair("keel://pair?u=https%3A%2F%2Fkeel.example.test&c=abc123&n=desk%20one")!!
        assertEquals(Wire.PairLink("https://keel.example.test", "abc123", "desk one"), l)
        assertEquals("http://10.0.2.2:47988", Wire.parsePair("keel://pair?u=http%3A%2F%2F10.0.2.2%3A47988%2F&c=x")!!.base)
        assertEquals(Wire.PairLink("https://keel.example.test:8443", "zz", "keel.example.test"), Wire.parsePair("https://keel.example.test:8443/pair?c=zz"))
        assertNull(Wire.parsePair("hermes://pair?u=https%3A%2F%2Fa.test&c=x"))
        assertNull(Wire.parsePair("keel://pair?u=https%3A%2F%2Fa.test"))
        assertNull(Wire.parsePair("keel://pair?u=javascript%3Aalert(1)&c=x"))
        assertNull(Wire.parsePair("https://a.test/other?c=x"))
    }

    private fun chat(status: String) = Chat.of(JSONObject().put("id", "c").put("title", "t").put("status", status))

    @Test fun stateComesFromCardsThenWorkThenTheLastTurn() {
        assertEquals(State.NEEDS, stateOf(chat("done"), pendingCard = true, working = true))
        assertEquals(State.WORKING, stateOf(chat("done"), pendingCard = false, working = true))
        assertEquals(State.FAILED, stateOf(chat("failed"), false, false))
        assertEquals(State.STOPPED, stateOf(chat("stopped"), false, false))
        assertEquals(State.DONE, stateOf(chat("done"), false, false))
        assertEquals(State.IDLE, stateOf(Chat.of(JSONObject().put("id", "c")), false, false))
    }

    @Test fun markdownBlocks() {
        val b = blocks("# Title\n\nA **bold** line\nwrapped.\n\n- one\n- two\n\n```kotlin\nval x = 1\n```\n| a | b |\n|---|---|\n| 1 | 2 |")
        assertEquals(Block.Heading(1, "Title"), b[0])
        assertEquals(Block.Para("A **bold** line wrapped."), b[1])
        assertEquals(Block.Item("•", "two", 0), b[3])
        assertEquals(Block.Code("kotlin", "val x = 1"), b[4])
        assertEquals(Block.Table(listOf(listOf("a", "b"), listOf("1", "2"))), b[5])
    }

    @Test fun times() {
        assertEquals("now", ago(100.0, 120.0))
        assertEquals("5m", ago(0.0, 300.0))
        assertEquals("4m 05s", elapsed(0.0, 245.0))
    }
}
