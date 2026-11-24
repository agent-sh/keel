package dev.avifenesh.keel

import org.junit.Assert.assertEquals
import org.junit.Test

// Push to talk on the helper row (Talk.kt): hold to listen, let go to ask; the words go as text.
class TalkTest {
    @Test fun holdListensLetGoAsksWithTheWordsHeard() {
        val t = Talk()
        assertEquals(TalkDo.Start, t.press(micAllowed = true))
        t.partial("what waits")
        assertEquals(TalkState.Listening("what waits"), t.state)
        assertEquals(TalkDo.Stop, t.release())
        assertEquals(TalkState.Ending("what waits"), t.state)
        // The recognizer's last words win; a second press while it finishes starts nothing.
        assertEquals(TalkDo.Nothing, t.press(micAllowed = true))
        assertEquals(TalkDo.Send("what waits for me"), t.final("what waits for me"))
        assertEquals(TalkState.Sent("what waits for me"), t.state)
        t.done()
        assertEquals(TalkState.Idle, t.state)
    }

    @Test fun nothingHeardSendsNothingAndSaysSo() {
        val t = Talk()
        t.press(true); t.release()
        assertEquals(TalkDo.Nothing, t.final(""))
        assertEquals(TalkState.Failed(NOTHING_HEARD), t.state)
        t.press(true); t.release()
        assertEquals(TalkDo.Nothing, t.error(TalkError.NO_MATCH))
        assertEquals(TalkState.Failed(NOTHING_HEARD), t.state)
        // The next press tries again.
        assertEquals(TalkDo.Start, t.press(true))
    }

    @Test fun anErrorAfterWordsStillSendsThem() {
        val t = Talk()
        t.press(true); t.partial("is the build green"); t.release()
        assertEquals(TalkDo.Send("is the build green"), t.error(TalkError.SPEECH_TIMEOUT))
    }

    @Test fun theMicrophoneIsAskedForFirstAndARefusalIsSaid() {
        val t = Talk()
        assertEquals(TalkDo.AskMic, t.press(micAllowed = false))
        assertEquals(TalkState.Idle, t.state)
        t.micRefused()
        assertEquals(TalkState.Failed(MIC_REFUSED), t.state)
        t.press(true)
        assertEquals(TalkDo.Nothing, t.error(TalkError.PERMISSIONS))
        assertEquals(TalkState.Failed(MIC_REFUSED), t.state)
    }

    @Test fun noRecognizerOnTheDeviceLeavesTheRowTyped() {
        val t = Talk()
        t.unavailable("none")
        assertEquals(TalkDo.Nothing, t.press(true))
        val u = Talk()
        u.press(true)
        u.error(TalkError.LANGUAGE_UNAVAILABLE)
        assertEquals(true, u.state is TalkState.Unavailable)
        assertEquals(TalkDo.Nothing, u.press(true))
    }

    @Test fun aRecognizerThatEndsOnSilenceWhileHeldAsksToo() {
        val t = Talk()
        t.press(true); t.partial("anything for me")
        assertEquals(TalkDo.Send("anything for me"), t.final(""))
        // The finger lets go after: nothing more happens.
        assertEquals(TalkDo.Nothing, t.release())
    }
}
