package dev.avifenesh.keel

import dev.avifenesh.keel.ui.StatePalette
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The session list's dot: one per state, as the page draws it. */
class DotTest {
    private fun chat(status: String = "idle", dot: String = "", ring: String = "", word: String = "", unread: Int = 0) =
        Chat("s", "Title", status, 0.0, unread, false, false, "", "", null, dot = dot, dotRing = ring, dotWord = word)

    @Test fun everyStateHasItsOwnForm() {
        val forms = Dot.entries.associateWith { look(it).form }
        assertEquals(Form.EDGED, forms[Dot.NEED])
        assertEquals(Form.SOLID, forms[Dot.WORK])
        assertEquals(Form.HALF, forms[Dot.WAIT])
        assertEquals(Form.SOLID, forms[Dot.FAIL])
        // Declined is red and empty: the model gave nothing.
        assertEquals(Form.HOLLOW, forms[Dot.DECLINED])
        assertEquals(Form.SOLID, forms[Dot.DONE])
        assertEquals(Form.HOLLOW, forms[Dot.IDLE])
        assertEquals(Form.SQUARE, forms[Dot.STOP])
        assertEquals(Form.OPEN, forms[Dot.RESUME])
        // Failed and declined share the hue and differ by form; done and failed differ by hue.
        assertEquals(look(Dot.FAIL).fill, look(Dot.DECLINED).fill)
        assertTrue(look(Dot.FAIL).form != look(Dot.DECLINED).form)
        assertEquals("--dot-need-edge", look(Dot.NEED).edge)
    }

    @Test fun onlyTheWorkDotBreathesAndNotUnderReducedMotion() {
        assertEquals(listOf(Dot.WORK), Dot.entries.filter { look(it).breathes })
        assertEquals(listOf(Dot.WORK), Dot.entries.filter { look(it).halo })
        // Under reduced motion the halo stays, still.
        assertFalse(look(Dot.WORK, reducedMotion = true).breathes)
        assertTrue(look(Dot.WORK, reducedMotion = true).halo)
        // A session that only waits on what it left going is a dot in a ring, and the ring does not breathe.
        val ring = look(Dot.WORK, ring = "agents")
        assertEquals(Form.IN_RING, ring.form)
        assertFalse(ring.breathes)
        assertFalse(ring.halo)
        assertEquals(Form.IN_RING, look(Dot.WAIT, ring = "command").form)
        // A ring means nothing on a state that is not work or waiting.
        assertEquals(Form.SOLID, look(Dot.DONE, ring = "agents").form)
    }

    @Test fun everyTokenAFormNamesIsInThePalette() {
        for (d in Dot.entries) for (ring in listOf("", "agents")) look(d, ring).let {
            assertTrue(it.fill, it.fill in StatePalette.tokens)
            assertTrue(it.edge, it.edge in StatePalette.tokens)
        }
    }

    @Test fun theDaemonsDotIsKeptWhereItAgreesWithTheListsState() {
        assertEquals(Dot.DECLINED to "", dotOf(chat("failed", dot = "declined"), State.FAILED))
        assertEquals(Dot.WAIT to "", dotOf(chat("working", dot = "wait"), State.WORKING))
        assertEquals(Dot.WORK to "agents", dotOf(chat("working", dot = "work", ring = "agents"), State.WORKING))
        assertEquals(Dot.RESUME to "", dotOf(chat("working", dot = "resume"), State.WORKING))
    }

    @Test fun theListsStateWinsOverADotTheDaemonHasNotCaughtUpWith() {
        // A card waits on the owner: needs you, whatever the dot said a moment ago, and no ring.
        assertEquals(Dot.NEED to "", dotOf(chat("working", dot = "work", ring = "agents"), State.NEEDS))
        // A turn the phone sees running while the dot still says done.
        assertEquals(Dot.WORK to "", dotOf(chat("done", dot = "done"), State.WORKING))
        // A failed status with a stale dot.
        assertEquals(Dot.FAIL to "", dotOf(chat("failed", dot = "done"), State.FAILED))
    }

    @Test fun aDaemonThatSendsOnlyTheStatusesStillGetsADotForEach() {
        val of = mapOf(State.NEEDS to Dot.NEED, State.WORKING to Dot.WORK, State.FAILED to Dot.FAIL, State.STOPPED to Dot.STOP, State.DONE to Dot.DONE, State.IDLE to Dot.IDLE)
        for ((s, d) in of) assertEquals(d to "", dotOf(chat(), s))
    }

    @Test fun theWordIsTheDaemonsWhenItSaidItForThisDotElseTheVocabulary() {
        assertEquals("Waiting on agents", dotWordOf(chat(dot = "work", ring = "agents", word = "Waiting on agents"), Dot.WORK, "agents"))
        assertEquals("Waiting on agents", dotWordOf(chat(), Dot.WORK, "agents"))
        assertEquals(COMMAND_IN_BACKGROUND, dotWordOf(chat(), Dot.WORK, "command"))
        assertEquals("Declined", dotWordOf(chat(dot = "declined"), Dot.DECLINED, ""))
        // A word the daemon said for another state is not used for this one.
        assertEquals("Needs you", dotWordOf(chat(dot = "work", word = "Working"), Dot.NEED, ""))
        assertEquals(listOf("Needs you", "Working", "Waiting", "Failed", "Declined", "Waiting", "Stopped", "Done", "Not started"), Dot.entries.map { it.word })
    }

    @Test fun doneIsTheQuietGreyAndNewsIsTheTitlesWeight() {
        // Done is the grey of a state at rest, as the page's rail draws no dot for it; colour is for what needs the owner, failed and at work.
        assertEquals("--st-idle", look(Dot.DONE).fill)
        assertEquals(StatePalette.of("--st-idle", false), StatePalette.of(look(Dot.IDLE).fill, false))
        val chroma = { rgb: Long -> val c = listOf(16, 8, 0).map { ((rgb shr it) and 0xFF).toInt() }; c.max() - c.min() }
        for (dark in listOf(false, true)) assertTrue(chroma(StatePalette.of(look(Dot.DONE).fill, dark)) < 16)
        // The title is heavier for news and for the states that ask something of the owner, and no other row's is.
        assertTrue(titleHeavy(Dot.DONE, 2))
        assertTrue(titleHeavy(Dot.WORK, 1))
        for (d in listOf(Dot.NEED, Dot.FAIL, Dot.DECLINED)) assertTrue(titleHeavy(d, 0))
        for (d in listOf(Dot.DONE, Dot.IDLE, Dot.STOP, Dot.WORK, Dot.WAIT)) assertFalse(titleHeavy(d, 0))
        // A seen session at rest steps back to the muted ink; news brings it back.
        assertTrue(titleQuiet(Dot.DONE, 0))
        assertFalse(titleQuiet(Dot.DONE, 1))
        assertFalse(titleQuiet(Dot.WORK, 0))
    }

    @Test fun aSessionAtWorkSaysWhatItDoesNow() {
        val c = chat("working", dot = "work").copy(action = " Editing src/a.ts ")
        assertEquals("Editing src/a.ts", actionLine(c, State.WORKING))
        // At rest or waiting on the owner a row says its state; a daemon that says no action leaves the message line.
        assertEquals("", actionLine(c, State.NEEDS))
        assertEquals("", actionLine(c, State.DONE))
        assertEquals("", actionLine(chat("working"), State.WORKING))
    }

    @Test fun newsIsTheTitlesWeightOnARowThatSaysNoMore() {
        assertTrue(showsNews(Dot.DONE, 1))
        assertTrue(showsNews(Dot.WORK, 3))
        assertFalse(showsNews(Dot.DONE, 0))
        for (d in listOf(Dot.NEED, Dot.FAIL, Dot.DECLINED)) assertFalse(showsNews(d, 2))
    }
}
