package dev.avifenesh.keel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

// How the helper row shows an answer (Asked.kt), from the daemon's answer as the app reads it.
class AskedTest {
    private fun answer(json: String) = HelperAnswer.of(JSONObject(json))

    @Test fun theAnswerNamesWhatItReadAndOffersAnswerFirstWhereASessionWaits() {
        val a = answer("""{"id":"e1","chat_id":"s-h","state":"done","question":"What waits?","text":"Deploy waits for your approval.","ts":1.0,"looked":["sessions","mail"],
            "read":[{"chat_id":"s-1","title":"Fix the build","waits":0},{"chat_id":"s-2","title":"Deploy","waits":1}]}""")
        assertEquals("Read Fix the build, Deploy, the session list and mail", Asked.readLine(a))
        assertEquals("", Asked.status(a))
        assertEquals(
            listOf(AskAct(AskAct.Kind.ANSWER, "s-2", "Answer Deploy"), AskAct(AskAct.Kind.OPEN, "s-1", "Open Fix the build"), AskAct(AskAct.Kind.HELPER, "s-h", "Go on with the helper")),
            Asked.acts(a),
        )
        assertEquals(false, a.pending)
    }

    @Test fun whileTheHelperWorksTheRowSaysSoAndAsksAgain() {
        val waiting = answer("""{"id":"q:1","chat_id":"s-h","state":"waiting","question":"Anything?","text":"","ts":1.0,"looked":[],"read":[]}""")
        assertEquals(true, waiting.pending)
        assertEquals("Asked. The helper starts on it.", Asked.status(waiting))
        assertEquals("", Asked.readLine(waiting))
        assertEquals(listOf(AskAct(AskAct.Kind.HELPER, "s-h", "Go on with the helper")), Asked.acts(waiting))
        val working = answer("""{"id":"e1","chat_id":"s-h","state":"working","question":"Anything?","text":"","ts":1.0,"looked":["sessions"],"read":[]}""")
        assertEquals("The helper is reading your sessions.", Asked.status(working))
        assertEquals("Read the session list", Asked.readLine(working))
        // Words already written are the answer so far: no status over them.
        assertEquals("", Asked.status(working.copy(text = "Looking.")))
    }

    @Test fun aFailedOrStoppedTurnIsSaid() {
        val a = answer("""{"id":"e1","chat_id":"s-h","state":"failed","question":"q","text":"","ts":1.0,"looked":[],"read":[]}""")
        assertEquals("The helper's turn failed. Its conversation says why.", Asked.status(a))
        assertEquals("The helper was stopped before it answered.", Asked.status(a.copy(state = "stopped")))
    }
}
