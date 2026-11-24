// The helper row, first in Sessions: hold the microphone to ask (the phone's own on-device
// recognizer, Speech.kt; the words go as text) or type, and the answer shows under it as text with
// the sessions it read named (Asked.kt). The answer only read; each tap it offers is the owner's:
// Answer opens the session at what waits there, Open opens it, and the helper's conversation goes on.
// The page has the same row on a phone (ui/src/components/HelperAsk.tsx).
package dev.avifenesh.keel.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import dev.avifenesh.keel.AskAct
import dev.avifenesh.keel.Asked
import dev.avifenesh.keel.HelperAnswer
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.Speech
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Talk
import dev.avifenesh.keel.TalkDo
import dev.avifenesh.keel.TalkState
import dev.avifenesh.keel.Ui
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How often the row asks for the answer while the helper works. */
private const val POLL_MS = 1500L

/** The last answer the row showed, kept while the app runs (a trip into a session and back keeps it). */
private val shown = mutableStateOf<HelperAnswer?>(null)

@Composable
fun HelperRow() {
    val k = k()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var asking by remember { mutableStateOf(false) }
    var answer by shown
    val talk = remember { Talk() }
    var state by remember { mutableStateOf(talk.state) }

    fun ask(words: String) {
        val w = words.trim()
        if (w.isEmpty() || asking) return
        asking = true; error = ""
        scope.launch {
            runCatching { Hub.ask(w, "ask-${System.currentTimeMillis()}-${w.hashCode()}") }
                .onSuccess { r -> r.id?.let { answer = HelperAnswer(it, r.chatId, "waiting", w, "", System.currentTimeMillis() / 1000.0, emptyList(), emptyList()) } }
                .onFailure { error = dev.avifenesh.keel.reach(it) }
            asking = false
        }
    }

    val speech = remember {
        Speech(ctx) { e ->
            val d = when (e) {
                is Speech.Event.Partial -> talk.partial(e.words)
                is Speech.Event.Final -> talk.final(e.words)
                is Speech.Event.Error -> talk.error(e.code)
            }
            state = talk.state
            if (d is TalkDo.Send) { ask(d.words); talk.done(); state = talk.state }
        }
    }
    val mic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> if (!ok) { talk.micRefused(); state = talk.state } }
    LaunchedEffect(Unit) { if (!Speech.available(ctx)) { talk.unavailable("No on-device speech recognizer"); state = talk.state } }
    DisposableEffect(Unit) { onDispose { speech.stopNow() } }
    fun run(d: TalkDo) {
        state = talk.state
        when (d) {
            TalkDo.Start -> speech.start()
            TalkDo.Stop -> speech.stop()
            TalkDo.AskMic -> mic.launch(Manifest.permission.RECORD_AUDIO)
            else -> {}
        }
    }

    // While the helper works, its answer is read again.
    val a = answer
    LaunchedEffect(a?.id, a?.pending) {
        val id = a?.id ?: return@LaunchedEffect
        while (answer?.id == id && answer?.pending != false) {
            delay(POLL_MS)
            runCatching { Hub.answer(id) }.onSuccess { if (answer?.id == id) answer = it.copy(id = id) }
                .onFailure { if ((it as? dev.avifenesh.keel.ApiError)?.code == 404) answer = null }
        }
    }

    val listening = state is TalkState.Listening || state is TalkState.Ending
    val heard = (state as? TalkState.Listening)?.heard ?: (state as? TalkState.Ending)?.heard
    Column(Modifier.fillMaxWidth().padding(horizontal = S.lg, vertical = S.sm).semantics { contentDescription = "helper-row" }) {
        val shape = RoundedCornerShape(S.r)
        Row(
            Modifier.fillMaxWidth().clip(shape).background(k.raised).border(1.dp, if (listening) k.ownerInk else k.line, shape).padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KIcon(Ic.Sparkles, k.ownerInk, 16.dp)
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
                val shownText = if (listening) heard.orEmpty() else text
                if (shownText.isEmpty()) Txt(if (listening) "Listening. Let go to ask." else "Ask the helper", T.body, k.faint, maxLines = 1)
                BasicTextField(
                    shownText, { if (!listening) text = it }, Modifier.fillMaxWidth().semantics { contentDescription = "helper-ask-field" },
                    textStyle = T.body.copy(color = k.fg), singleLine = true, readOnly = listening, cursorBrush = SolidColor(k.fg),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { ask(text); text = "" }),
                )
            }
            if (text.isBlank() && state !is TalkState.Unavailable) {
                // Hold to talk: down listens, up asks.
                Box(
                    Modifier.size(40.dp).clip(RoundedCornerShape(S.r)).background(if (listening) k.inkSoft else androidx.compose.ui.graphics.Color.Transparent)
                        .semantics { contentDescription = "helper-talk"; role = Role.Button }
                        .pointerInput(Unit) {
                            awaitEachGesture {
                                awaitFirstDown()
                                run(talk.press(ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED))
                                waitForUpOrCancellation()
                                run(talk.release())
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) { KIcon(Ic.Mic, if (listening) k.ownerInk else k.muted, 20.dp) }
            } else {
                IconBtn(Ic.ArrowUp, "Ask", { ask(text); text = "" }, tint = k.fg, enabled = text.isNotBlank() && !asking)
            }
        }
        val note = error.ifBlank { (state as? TalkState.Failed)?.why.orEmpty() }
        if (note.isNotBlank()) { Spacer(Modifier.height(6.dp)); Txt(note, T.small, k.muted, Modifier.semantics { contentDescription = "helper-note" }) }
        a?.let { AnswerCard(it) { answer = null } }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AnswerCard(a: HelperAnswer, onClear: () -> Unit) {
    val k = k()
    Spacer(Modifier.height(S.sm))
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(topEnd = S.r, bottomEnd = S.r)).background(k.sunken)
            .drawBehind { drawRect(k.ownerInk, size = Size(2.dp.toPx(), size.height)) }
            .padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 12.dp).semantics { contentDescription = "helper-answer-${a.state}" },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Txt(a.question, T.small, k.muted, Modifier.weight(1f), maxLines = 1)
            IconBtn(Ic.X, "Clear the answer", onClear, tint = k.faint)
        }
        val status = Asked.status(a)
        if (status.isNotBlank()) Row(verticalAlignment = Alignment.CenterVertically) {
            if (a.pending) { StateMark(State.WORKING, 8.dp); Spacer(Modifier.width(8.dp)) }
            Txt(status, T.ui, k.muted, Modifier.semantics { contentDescription = "helper-answer-status" })
        }
        if (a.text.isNotBlank()) Markdown(a.text, T.ui, Modifier.padding(end = 8.dp).semantics { contentDescription = "helper-answer-text" })
        val read = Asked.readLine(a)
        if (read.isNotBlank()) { Spacer(Modifier.height(8.dp)); Txt(read, T.meta, k.faint, Modifier.semantics { contentDescription = "helper-answer-read" }) }
        Spacer(Modifier.height(10.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(S.sm), verticalArrangement = Arrangement.spacedBy(S.sm)) {
            for (act in Asked.acts(a)) Btn(
                act.label, { Ui.open(act.chatId) },
                tone = when (act.kind) { AskAct.Kind.ANSWER -> Tone.NEED; AskAct.Kind.OPEN -> Tone.LINE; AskAct.Kind.HELPER -> Tone.QUIET },
                compact = true, tag = "helper-act-${act.label}",
            )
        }
    }
}
