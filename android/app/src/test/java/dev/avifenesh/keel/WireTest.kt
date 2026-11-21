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

    @Test fun aDraftGoesOnlyWithEverythingItCarries() {
        val photo = Upload("a1", "image", "image/png", "photo.png", 70)
        // One of two picked files is not stored yet (still uploading, or its upload failed): nothing is sent.
        assertEquals(false, Wire.sendable("look at these", picked = 2, uploads = listOf(photo)))
        assertEquals(true, Wire.sendable("look at these", picked = 1, uploads = listOf(photo)))
        // A photo may go without words; nothing at all may not.
        assertEquals(true, Wire.sendable("", picked = 1, uploads = listOf(photo)))
        assertEquals(false, Wire.sendable("  ", picked = 0, uploads = emptyList()))
        // The send's id stays with the same words and files, and changes with either.
        val key = Wire.sendKey("look", listOf(photo))
        assertEquals("kept", Wire.sendId("kept", key, Wire.sendKey("look", listOf(photo))) { "fresh" })
        assertEquals("fresh", Wire.sendId("kept", key, Wire.sendKey("look", emptyList())) { "fresh" })
        assertEquals("fresh", Wire.sendId("kept", key, Wire.sendKey("look", listOf(photo.copy(id = "b2")))) { "fresh" })
    }

    @Test fun aFailedReadOfEarlierMessagesOffersTheRightWayOn() {
        // The cursor is no longer on the shown branch: the same page cannot be read again.
        assertEquals(Earlier.RELOAD, earlierAfter(409))
        // The daemon was busy, or out of reach (no HTTP code at all).
        assertEquals(Earlier.AGAIN, earlierAfter(503))
        assertEquals(Earlier.AGAIN, earlierAfter(null))
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
