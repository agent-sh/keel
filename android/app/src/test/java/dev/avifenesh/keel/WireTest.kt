package dev.avifenesh.keel

import dev.avifenesh.keel.ui.Block
import dev.avifenesh.keel.ui.blocks
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The expected strings are what the daemon computes (src/integrations/mobile/sig.ts
// and the approve route), printed by bun from the same inputs.
class WireTest {
    @Test fun canonicalMatchesTheDaemon() {
        val body = """{"text":"hi"}""".toByteArray()
        assertEquals(
            "POST\n/v1/chats/a/messages?x=1\n1795195000\ne7b995efa755c5ff3b84d2188b58cb4ae916a59470eb3761df8a814f11763500",
            Wire.canonical("post", "/v1/chats/a/messages", "x=1", "1795195000", Wire.sha256Hex(body)),
        )
        assertEquals("GET\n/v1/sync\n1\n${Wire.sha256Hex(ByteArray(0))}", Wire.canonical("GET", "/v1/sync", null, "1", Wire.sha256Hex(ByteArray(0))))
    }

    @Test fun answersAreHashedAsTheDaemonWritesThem() {
        val answers = linkedMapOf<String, Any>("b" to "say \"hi\"\n\tok\u0001", "a" to listOf("Yes", "Não / sí"), "10" to "x")
        val text = Wire.answersText(answers)
        assertEquals("""[["10","x"],["a",["Yes","Não / sí"]],["b","say \"hi\"\n\tok\u0001"]]""", text)
        assertEquals(
            "approve2\nq-call_1\nonce\n62bd08ee1cee77adf08e0dcb3dccc81c5afa0496c758a4eac4d540470ad4baa2\n1795195000",
            Wire.approvalMessage("q-call_1", "once", "1795195000", text),
        )
        assertEquals(
            "approve2\napr_9\nsession\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1795195000",
            Wire.approvalMessage("apr_9", "session", "1795195000", ""),
        )
    }

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

    @Test fun cardsReadTheDaemonsShape() {
        val c = Card.of(JSONObject("""{"id":"q-1","chat_id":"s","kind":"question","command":"Pick","actions":[["Answer","once","primary"],["Dismiss","deny","danger"]],
            "state":"approved","questions":[{"id":"0","question":"Which?","options":["A","B"],"multi":true}],"answers":{"0":{"picked":["A"],"other":"C"}}}"""))
        assertEquals(listOf(Act("Answer", "once", "primary"), Act("Dismiss", "deny", "danger")), c.actions)
        assertEquals(listOf("A", "C"), c.answers["0"])
        assertEquals(true, c.questions.single().multi)
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
