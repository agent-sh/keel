// Starting a task from the phone: what to do, where (this machine's folders, or a machine of the
// fleet), on which model. Each choice starts on what the daemon would pick by itself, so the owner
// can type the task and start it, or change one thing first.
package dev.avifenesh.keel.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.NewChat
import dev.avifenesh.keel.Start
import dev.avifenesh.keel.StartFolder
import dev.avifenesh.keel.ago
import dev.avifenesh.keel.modelName
import kotlinx.coroutines.launch

/** The start sheet over the app while `Ui.starting` is on: it reads what the daemon offers and starts the session. */
@Composable
fun StartHost() {
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var offer by remember { mutableStateOf<Start?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        runCatching { dev.avifenesh.keel.Hub.startOffer() }.onSuccess { offer = it }
            .onFailure { error = dev.avifenesh.keel.reach(it).let { w -> if (w == dev.avifenesh.keel.OUT_OF_REACH) "The computer is out of reach: a session starts when it is." else w } }
    }
    StartSheet(offer, busy, error, onStart = { n ->
        if (!busy) {
            busy = true; error = ""
            scope.launch {
                runCatching { dev.avifenesh.keel.Hub.newChat(n) }
                    .onSuccess { dev.avifenesh.keel.Ui.starting.value = false; dev.avifenesh.keel.Ui.open(it) }
                    .onFailure { error = it.message ?: "The session did not start" }
                busy = false
            }
        }
    }, onClose = { dev.avifenesh.keel.Ui.starting.value = false })
}

/**
 * The start sheet. `offer`: what the daemon offers (null while it loads, or when it could not be read:
 * then the daemon's defaults are all there is). `busy`: a start is on its way.
 */
@Composable
fun StartSheet(offer: Start?, busy: Boolean, error: String, onStart: (NewChat) -> Unit, onClose: () -> Unit) {
    val k = k()
    BackHandler(onBack = onClose)
    var text by rememberSaveable { mutableStateOf("") }
    var machine by rememberSaveable { mutableStateOf("local") }
    var folder by rememberSaveable { mutableStateOf("") }
    var model by rememberSaveable { mutableStateOf("") }
    var models by remember { mutableStateOf(false) }
    val chosenModel = model.ifBlank { offer?.model.orEmpty() }
    val far = offer?.machines?.firstOrNull { it.id == machine && it.id != "local" }
    val folders = offer?.folders.orEmpty()
    val here = folder.ifBlank { folders.firstOrNull()?.path.orEmpty() }
    fun start() = onStart(NewChat(model = model, workspace = if (far != null) "" else here, machine = machine, text = text))

    Column(Modifier.fillMaxSize().background(k.bg).statusBarsPadding().navigationBarsPadding().imePadding().semantics { contentDescription = "start-sheet" }) {
        Head("New session", lead = { IconBtn(Ic.X, "Close", onClose) })
        Rule()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = S.lg, vertical = S.md), verticalArrangement = Arrangement.spacedBy(S.lg)) {
            Field(text, { text = it }, "What should it do? (optional)", singleLine = false, minLines = 3, maxLines = 8, tag = "start-text")
            // Where: a machine of the fleet when there are others, then this machine's folders.
            val machines = offer?.machines.orEmpty()
            if (machines.size > 1) Column {
                Label("Machine")
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                    for (m in machines) Chip(m.name + if (!m.ready) " (offline)" else "", m.id == machine, enabled = m.ready || m.id == machine, tag = "machine-${m.name}") { machine = m.id }
                }
            }
            if (far != null) Column {
                Label("Folder")
                Txt("It starts in ${far.root.ifBlank { "the folder granted" }} on ${far.name}.", T.small, k.muted)
            } else if (folders.isNotEmpty()) Column {
                Label("Folder")
                Panel {
                    Column {
                        for ((i, f) in folders.withIndex()) {
                            if (i > 0) Rule()
                            FolderRow(f, f.path == here) { folder = f.path }
                        }
                    }
                }
            }
            if (offer != null && offer.models.isNotEmpty()) Column {
                Label("Model")
                val current = offer.models.firstOrNull { it.id == chosenModel }
                Panel {
                    Column {
                        Row(Modifier.fillMaxWidth().press({ models = !models }).semantics { contentDescription = "start-model" }.padding(horizontal = S.md, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Txt(current?.let(::modelName) ?: chosenModel.ifBlank { "The default model" }, T.ui, k.fg, Modifier.weight(1f), maxLines = 1)
                            if (chosenModel == offer.model) { Txt("default", T.meta, k.faint); Spacer(Modifier.width(S.sm)) }
                            KIcon(if (models) Ic.ChevronDown else Ic.ChevronRight, k.faint, 16.dp)
                        }
                        if (models) for (m in offer.models) {
                            Rule()
                            Row(Modifier.fillMaxWidth().press({ model = m.id; models = false }).semantics { contentDescription = "model-${m.id}" }.padding(horizontal = S.md, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Txt(modelName(m), T.ui, if (m.id == chosenModel) k.fg else k.muted, Modifier.weight(1f), maxLines = 1)
                                if (m.id == chosenModel) KIcon(Ic.Check, k.fg, 16.dp)
                            }
                        }
                    }
                }
            }
            if (offer == null && error.isBlank()) Txt("Reading what the computer offers. Start now and it uses its defaults.", T.small, k.faint)
            if (error.isNotBlank()) Notice(error)
        }
        Rule()
        Box(Modifier.fillMaxWidth().background(k.panel).padding(S.md)) {
            Btn(if (busy) "Starting" else if (text.isBlank()) "Start a session" else "Start", { start() }, enabled = !busy, icon = Ic.ArrowUp, modifier = Modifier.fillMaxWidth(), tag = "start-go")
        }
    }
}

@Composable
private fun Label(text: String) = Txt(text.uppercase(), T.label, k().muted, Modifier.padding(bottom = S.sm))

@Composable
private fun FolderRow(f: StartFolder, on: Boolean, onPick: () -> Unit) {
    val k = k()
    Row(Modifier.fillMaxWidth().press(onPick).semantics { contentDescription = "folder-${f.name}" }.padding(horizontal = S.md, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        // A ring, filled when chosen: one of them always is.
        val shape = RoundedCornerShape(S.rPill)
        Box(Modifier.size(16.dp).clip(shape).border(1.5.dp, if (on) k.fg else k.lineStrong, shape), contentAlignment = Alignment.Center) {
            if (on) Box(Modifier.size(8.dp).clip(shape).background(k.fg))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Txt(f.name, T.ui, k.fg, maxLines = 1)
            // Where it is: its parent folder, cut at its start, so the end that tells folders apart stays.
            androidx.compose.foundation.text.BasicText(f.path.substringBeforeLast('/', f.path).ifBlank { "/" }, style = T.meta.copy(color = k.faint), maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.StartEllipsis)
        }
        Txt(if (f.home) "the daemon's" else if (f.last > 0) ago(f.last) else "", T.meta, k.faint)
    }
}

@Composable
private fun Chip(label: String, on: Boolean, enabled: Boolean, tag: String, onPick: () -> Unit) {
    val k = k()
    val shape = RoundedCornerShape(S.r)
    Box(
        Modifier.clip(shape).background(if (on) k.inkSoft else k.raised).border(1.dp, if (on) k.fg else k.lineStrong, shape)
            .press(onPick, enabled).semantics { contentDescription = tag }.padding(horizontal = 14.dp, vertical = 10.dp),
    ) { Txt(label, T.ui, if (enabled) k.fg else k.faint, maxLines = 1) }
}
