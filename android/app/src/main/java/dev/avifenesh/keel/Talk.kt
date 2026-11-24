// Push to talk for the helper row, as a state and what each step asks of the recognizer. Pure: the
// recognizer itself is Speech.kt (Android's on-device SpeechRecognizer; words only, never audio to a
// server), the row is ui/Ask.kt. Hold the microphone to listen, let go to stop; the words heard go to
// the helper as text. Nothing heard sends nothing and says so.
package dev.avifenesh.keel

/** Where push to talk is. `heard`: the words so far, shown while the owner speaks. */
sealed interface TalkState {
    data object Idle : TalkState
    data class Listening(val heard: String) : TalkState
    /** Let go: the recognizer finishes what it heard. */
    data class Ending(val heard: String) : TalkState
    /** The words went to the helper. */
    data class Sent(val words: String) : TalkState
    /** This try did not give words; the next press tries again. */
    data class Failed(val why: String) : TalkState
    /** No on-device recognizer for this phone or its language: the row is typed only. */
    data class Unavailable(val why: String) : TalkState
}

/** What a step asks of the recognizer and the row. */
sealed interface TalkDo {
    data object Nothing : TalkDo
    data object Start : TalkDo
    data object Stop : TalkDo
    data object AskMic : TalkDo
    data class Send(val words: String) : TalkDo
}

/** SpeechRecognizer's error codes (android.speech.SpeechRecognizer.ERROR_*), by value. */
object TalkError {
    const val NETWORK_TIMEOUT = 1
    const val NETWORK = 2
    const val AUDIO = 3
    const val SERVER = 4
    const val CLIENT = 5
    const val SPEECH_TIMEOUT = 6
    const val NO_MATCH = 7
    const val BUSY = 8
    const val PERMISSIONS = 9
    const val TOO_MANY = 10
    const val SERVER_DISCONNECTED = 11
    const val LANGUAGE_NOT_SUPPORTED = 12
    const val LANGUAGE_UNAVAILABLE = 13
}

const val NOTHING_HEARD = "Nothing was heard. Hold the microphone while you speak."
const val MIC_REFUSED = "Keel may not use the microphone. Allow it in the phone's settings, or type the question."

class Talk(state: TalkState = TalkState.Idle) {
    var state: TalkState = state
        private set

    private fun go(s: TalkState, d: TalkDo = TalkDo.Nothing): TalkDo { state = s; return d }

    /** The phone has no on-device recognizer (or none for its language). */
    fun unavailable(why: String): TalkDo = go(TalkState.Unavailable(why))

    /** A finger on the microphone. Without the microphone's permission it asks for it and listens on the next press. */
    fun press(micAllowed: Boolean): TalkDo = when (state) {
        is TalkState.Unavailable, is TalkState.Listening, is TalkState.Ending -> TalkDo.Nothing
        else -> if (micAllowed) go(TalkState.Listening(""), TalkDo.Start) else go(TalkState.Idle, TalkDo.AskMic)
    }

    /** The owner refused the microphone. */
    fun micRefused(): TalkDo = go(TalkState.Failed(MIC_REFUSED))

    /** Words heard so far. */
    fun partial(words: String): TalkDo = when (val s = state) {
        is TalkState.Listening -> go(TalkState.Listening(words.trim()))
        is TalkState.Ending -> go(TalkState.Ending(words.trim().ifBlank { s.heard }))
        else -> TalkDo.Nothing
    }

    /** The finger let go: the recognizer is told to finish. */
    fun release(): TalkDo = when (val s = state) {
        is TalkState.Listening -> go(TalkState.Ending(s.heard), TalkDo.Stop)
        else -> TalkDo.Nothing
    }

    /** The recognizer's last words (it may end by itself on silence while the finger is still down). */
    fun final(words: String): TalkDo {
        val heard = when (val s = state) { is TalkState.Listening -> s.heard; is TalkState.Ending -> s.heard; else -> return TalkDo.Nothing }
        val w = words.trim().ifBlank { heard }
        return if (w.isBlank()) go(TalkState.Failed(NOTHING_HEARD)) else go(TalkState.Sent(w), TalkDo.Send(w))
    }

    /** A recognizer error. What was heard before it is still the owner's words, and is sent. */
    fun error(code: Int): TalkDo {
        val heard = when (val s = state) { is TalkState.Listening -> s.heard; is TalkState.Ending -> s.heard; else -> return TalkDo.Nothing }
        return when (code) {
            TalkError.LANGUAGE_NOT_SUPPORTED, TalkError.LANGUAGE_UNAVAILABLE -> go(TalkState.Unavailable("The phone recognizes no speech on the device in its language. Type the question."))
            TalkError.PERMISSIONS -> go(TalkState.Failed(MIC_REFUSED))
            else -> if (heard.isNotBlank()) go(TalkState.Sent(heard), TalkDo.Send(heard)) else go(TalkState.Failed(errorWords(code)))
        }
    }

    /** The row took the sent words: ready for the next press. */
    fun done(): TalkDo = if (state is TalkState.Sent) go(TalkState.Idle) else TalkDo.Nothing
}

/** A recognizer error that left no words, said as the row says it. */
fun errorWords(code: Int): String = when (code) {
    TalkError.NO_MATCH, TalkError.SPEECH_TIMEOUT, TalkError.CLIENT -> NOTHING_HEARD
    TalkError.AUDIO -> "The microphone could not be read. Try again."
    TalkError.BUSY, TalkError.TOO_MANY -> "The phone's recognizer is busy. Try again in a moment."
    else -> "The phone's recognizer stopped (error $code). Try again, or type the question."
}
