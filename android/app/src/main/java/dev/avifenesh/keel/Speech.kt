// The phone's own speech recognizer for push to talk (Talk.kt decides, this listens). On the device
// only: SpeechRecognizer.createOnDeviceSpeechRecognizer (Android 12, this app's least), never the
// default recognizer, which may send the audio to a server. A phone without one gets the typed row.
// Words go to the daemon as text; no audio leaves the phone.
package dev.avifenesh.keel

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

class Speech(private val context: Context, private val on: (Event) -> Unit) {
    sealed interface Event {
        data class Partial(val words: String) : Event
        data class Final(val words: String) : Event
        data class Error(val code: Int) : Event
    }

    private var rec: SpeechRecognizer? = null

    companion object {
        /** Whether this phone recognizes speech on the device. */
        fun available(context: Context): Boolean = runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) }.getOrDefault(false)
    }

    private fun first(b: Bundle?): String = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    fun start() {
        stopNow()
        val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) = on(Event.Error(error))
            override fun onResults(results: Bundle?) = on(Event.Final(first(results)))
            override fun onPartialResults(partialResults: Bundle?) = on(Event.Partial(first(partialResults)))
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        rec = r
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        })
    }

    /** The finger let go: the recognizer finishes and gives its results. */
    fun stop() { rec?.stopListening() }

    /** Gone (the row left the screen): nothing more is heard. */
    fun stopNow() { rec?.destroy(); rec = null }
}
