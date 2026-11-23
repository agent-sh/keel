package dev.avifenesh.keel.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import dev.avifenesh.keel.Api
import dev.avifenesh.keel.Hub
import dev.avifenesh.keel.MainActivity
import dev.avifenesh.keel.Route
import dev.avifenesh.keel.Ui
import dev.avifenesh.keel.Wire
import kotlinx.coroutines.launch

@Composable
fun Root(act: MainActivity) {
    val k = k()
    // System bar icons follow the app's theme, not the system's.
    val view = LocalView.current
    SideEffect {
        WindowCompat.getInsetsController(act.window, view).apply { isAppearanceLightStatusBars = !k.dark; isAppearanceLightNavigationBars = !k.dark }
    }
    Box(Modifier.fillMaxSize().background(k.bg)) {
        if (!Ui.paired.value) PairScreen(act)
        else when (val r = Ui.route.value) {
            is Route.Session -> {
                BackHandler { Ui.route.value = Route.Tabs(0) }
                SessionScreen(act, r.id)
            }
            is Route.Changes -> {
                BackHandler { Ui.route.value = Route.Session(r.id) }
                ChangesScreen(r.id)
            }
            is Route.Diff -> {
                BackHandler { Ui.route.value = Route.Changes(r.id) }
                DiffScreen(r)
            }
            is Route.Tabs -> {
                BackHandler(enabled = r.tab != 0) { Ui.route.value = Route.Tabs(0) }
                Column(Modifier.fillMaxSize().statusBarsPadding()) {
                    Box(Modifier.weight(1f)) {
                        when (r.tab) {
                            0 -> SessionsScreen()
                            1 -> NeedsScreen(act)
                            2 -> UsageScreen()
                            else -> SettingsScreen(act)
                        }
                    }
                    TabBar(r.tab)
                }
            }
        }
        // A pairing link that arrived while paired asks before it replaces the pairing.
        Ui.link.value?.let { l -> if (Ui.paired.value) PairOver(act, l) }
    }
}

@Composable
private fun TabBar(active: Int) {
    val k = k()
    val needs by Hub.cards.collectAsState()
    val open = needs.values.count { it.pending }
    Column(Modifier.fillMaxWidth().background(k.panel)) {
        Rule()
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(64.dp)) {
            listOf(Triple("Sessions", Ic.MessagesSquare, 0), Triple("Needs you", Ic.Inbox, 1), Triple("Usage", Ic.ChartColumn, 2), Triple("Settings", Ic.Settings, 3)).forEach { (label, icon, i) ->
                val on = i == active
                Column(
                    Modifier.weight(1f).height(64.dp).press({ Ui.route.value = Route.Tabs(i) }).semantics { contentDescription = "tab-$label" },
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                ) {
                    Box {
                        KIcon(icon, if (on) k.fg else k.faint, 22.dp)
                        if (i == 1 && open > 0) Box(
                            Modifier.offset(x = 14.dp, y = (-6).dp).clip(RoundedCornerShape(S.rPill)).background(k.need).padding(horizontal = 5.dp, vertical = 1.dp),
                        ) { Txt("$open", T.label, if (k.dark) k.bg else k.raised) }
                    }
                    Spacer(Modifier.height(4.dp))
                    Txt(label, T.label, if (on) k.fg else k.faint)
                    Spacer(Modifier.height(4.dp))
                    Box(Modifier.width(18.dp).height(2.dp).background(if (on) k.fg else androidx.compose.ui.graphics.Color.Transparent))
                }
            }
        }
    }
}

/** Pairing: scan the workbench's code, or paste its link. */
@Composable
fun PairScreen(act: MainActivity) {
    val k = k()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var paste by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    val clip = LocalClipboardManager.current
    val link = Ui.link.value
    fun pair(l: Wire.PairLink) {
        busy = true; error = ""; Ui.unpaired.value = null
        scope.launch {
            val r = runCatching { Api.pair(l) }
            busy = false
            r.onSuccess { Ui.link.value = null; act.onPaired(first = true) }
                .onFailure { error = when ((it as? dev.avifenesh.keel.ApiError)?.code) {
                    403 -> "The daemon refused the code: it was used or it expired. Show a new one on the computer."
                    429 -> "Too many tries. Wait a few minutes, then show a new code."
                    else -> "Could not reach the daemon at ${l.base}: ${it.message}"
                } }
        }
    }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = S.xl),
    ) {
        Spacer(Modifier.height(72.dp))
        Mark(56.dp)
        Spacer(Modifier.height(S.xl))
        Txt("Keel", T.display.copy(fontSize = T.display.fontSize * 1.3f))
        Spacer(Modifier.height(S.sm))
        Txt("Your sessions, approvals and alerts from the Keel daemon you run, on this phone.", T.body, k.muted)
        // How the unpairing that led here ended: confirmed by the daemon, or only done on this phone.
        Ui.unpaired.value?.let { u ->
            Spacer(Modifier.height(S.lg))
            Notice(u.note, color = if (u.revoked) k.muted else k.danger, modifier = Modifier.testTag(if (u.revoked) "unpaired-confirmed" else "unpaired-local-only"))
        }
        Spacer(Modifier.height(S.xxl))
        if (link != null) {
            Panel {
                Column(Modifier.padding(S.lg)) {
                    Txt("PAIR WITH", T.label, k.muted)
                    Spacer(Modifier.height(6.dp))
                    Txt(link.name.ifBlank { "Keel" }, T.title)
                    Txt(link.base, T.code, k.muted)
                    Spacer(Modifier.height(S.md))
                    Txt("This phone makes its own keys. Approvals ask for your fingerprint or screen lock.", T.small, k.muted)
                    Spacer(Modifier.height(S.lg))
                    Row(horizontalArrangement = Arrangement.spacedBy(S.sm)) {
                        Btn(if (busy) "Pairing" else "Pair this phone", { pair(link) }, enabled = !busy, tag = "pair-confirm")
                        Btn("Cancel", { Ui.link.value = null }, Tone.QUIET, enabled = !busy)
                    }
                }
            }
        } else {
            Panel {
                Column(Modifier.padding(S.lg), verticalArrangement = Arrangement.spacedBy(S.md)) {
                    Step(1, "On the computer, open Keel's Settings, then Phone, and show a pairing code.")
                    Step(2, "Scan it here, or open its link on this phone.")
                }
            }
            Spacer(Modifier.height(S.xl))
            Btn("Scan pairing code", {
                error = ""
                GmsBarcodeScanning.getClient(act, GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
                    .startScan()
                    .addOnSuccessListener { b -> val l = b.rawValue?.let(Wire::parsePair); if (l != null) Ui.link.value = l else error = "That code is not a Keel pairing code." }
                    .addOnFailureListener { e -> error = "The scanner did not start: ${e.message}. Paste the link instead." }
            }, icon = Ic.QrCode, modifier = Modifier.fillMaxWidth(), tag = "pair-scan")
            Spacer(Modifier.height(S.sm))
            Btn("Paste link", { paste = !paste; clip.getText()?.text?.takeIf { it.startsWith("keel://") || it.contains("/pair?") }?.let { text = it } },
                Tone.LINE, icon = Ic.ClipboardPaste, modifier = Modifier.fillMaxWidth(), tag = "pair-paste")
            if (paste) {
                Spacer(Modifier.height(S.md))
                Field(text, { text = it }, "keel://pair?u=...&c=...", singleLine = false, tag = "pair-link")
                Spacer(Modifier.height(S.sm))
                Btn("Pair", {
                    val l = Wire.parsePair(text)
                    if (l == null) error = "That is not a Keel pairing link." else pair(l)
                }, enabled = text.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth(), tag = "pair-go")
            }
        }
        val e = error.ifBlank { Ui.linkError.value }
        if (e.isNotBlank()) { Spacer(Modifier.height(S.lg)); Notice(e) }
        Spacer(Modifier.height(S.xxl))
        Txt("Requests are signed by a key that never leaves this phone. Keep pairing links private.", T.small, k.faint, Modifier.fillMaxWidth().padding(bottom = S.xl))
    }
}

@Composable
private fun Step(n: Int, text: String) = Row {
    val k = k()
    Box(Modifier.size(22.dp).clip(RoundedCornerShape(S.rPill)).border(1.dp, k.lineStrong, RoundedCornerShape(S.rPill)), contentAlignment = Alignment.Center) {
        Txt("$n", T.label, k.muted)
    }
    Spacer(Modifier.width(S.md))
    Txt(text, T.ui, k.fg, Modifier.weight(1f))
}

/** A pairing link opened while paired: replacing the pairing is the owner's call. */
@Composable
private fun PairOver(act: MainActivity, l: Wire.PairLink) {
    Dialog(
        title = "Pair with ${l.name.ifBlank { "another daemon" }}?",
        body = "This phone is paired already. Pairing again replaces that pairing with ${l.base}.",
        action = "Replace pairing", danger = true,
        onCancel = { Ui.link.value = null },
        onAction = { Ui.paired.value = false },
    )
}

/** A text field on the tokens. */
@Composable
fun Field(value: String, onChange: (String) -> Unit, placeholder: String, singleLine: Boolean = true, tag: String = placeholder, modifier: Modifier = Modifier, minLines: Int = 1, maxLines: Int = if (singleLine) 1 else 6) {
    val k = k()
    val shape = RoundedCornerShape(S.r)
    Box(modifier.fillMaxWidth().clip(shape).background(k.sunken).border(1.dp, k.line, shape).padding(horizontal = 12.dp, vertical = 11.dp)) {
        if (value.isEmpty()) Txt(placeholder, T.body, k.faint, maxLines = 1)
        BasicTextField(value, onChange, Modifier.fillMaxWidth().semantics { contentDescription = tag }, textStyle = T.body.copy(color = k.fg),
            singleLine = singleLine, minLines = minLines, maxLines = maxLines, cursorBrush = SolidColor(k.fg))
    }
}

/** A modal question with one action. */
@Composable
fun Dialog(title: String, body: String, action: String, danger: Boolean = false, onCancel: () -> Unit, onAction: () -> Unit) {
    val k = k()
    BackHandler(onBack = onCancel)
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color.Black.copy(alpha = if (k.dark) 0.55f else 0.32f)).press(onCancel), contentAlignment = Alignment.Center) {
        Box(Modifier.padding(S.xl).press({})) {
            Panel {
                Column(Modifier.padding(S.xl)) {
                    Txt(title, T.title)
                    Spacer(Modifier.height(S.sm))
                    Txt(body, T.ui, k.muted)
                    Spacer(Modifier.height(S.xl))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(S.sm, Alignment.End)) {
                        Btn("Cancel", onCancel, Tone.QUIET)
                        Btn(action, onAction, if (danger) Tone.DANGER else Tone.INK, tag = "dialog-$action")
                    }
                }
            }
        }
    }
}

@Composable
fun Empty(title: String, body: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val k = k()
    Column(modifier.fillMaxWidth().padding(S.xxl), horizontalAlignment = Alignment.CenterHorizontally) {
        Txt(title, T.title, k.fg)
        Spacer(Modifier.height(S.sm))
        Txt(body, T.ui.copy(textAlign = TextAlign.Center), k.muted)
        if (action != null) { Spacer(Modifier.height(S.lg)); action() }
    }
}
