// Files in a session: what is picked for the next message above the composer,
// what a sent message carried in the transcript, and a photo seen whole.
package dev.avifenesh.keel.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Attach
import dev.avifenesh.keel.Attachment
import dev.avifenesh.keel.Media
import dev.avifenesh.keel.Picked
import dev.avifenesh.keel.State
import dev.avifenesh.keel.Up
import dev.avifenesh.keel.Wire

/** What is picked for the next message: a photo by its picture, a file by its name; each with its state and a remove. */
@Composable
fun PickedRow(chat: String, picked: List<Picked>) {
    val k = k()
    if (picked.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(start = S.md, end = S.md, top = 10.dp)) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(S.sm)) {
            for (p in picked) PickedChip(p) { Attach.remove(chat, p.key) }
        }
        // Each one that failed says why, and is read and sent again from where it was picked.
        val ctx = androidx.compose.ui.platform.LocalContext.current
        for (p in picked.filter { it.state == Up.FAILED }) {
            Spacer(Modifier.height(S.sm)); Notice(p.error)
            if (p.uri != null) Btn("Try again", { Attach.retry(ctx, chat, p.key) }, Tone.LINE, compact = true, tag = "retry-${p.picked}", modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun PickedChip(p: Picked, onRemove: () -> Unit) {
    val k = k()
    val shape = RoundedCornerShape(S.r)
    val edge = if (p.state == Up.FAILED) k.danger else k.line
    val what = when (p.state) { Up.READING -> "preparing"; Up.UPLOADING -> "uploading"; Up.READY -> "ready"; Up.FAILED -> "not sent" }
    Box(Modifier.semantics { contentDescription = "picked-${p.name}-$what" }) {
        if (p.photo && p.thumb != null) {
            Image(p.thumb, p.name, Modifier.size(64.dp).clip(shape).border(1.dp, edge, shape), contentScale = ContentScale.Crop)
        } else {
            Row(
                Modifier.height(64.dp).widthIn(max = 220.dp).clip(shape).background(k.raised).border(1.dp, edge, shape).padding(start = 10.dp, end = 34.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KIcon(if (p.photo) Ic.Image else Ic.File, k.muted, 20.dp)
                Spacer(Modifier.width(8.dp))
                Column {
                    Txt(p.name, T.small, k.fg, maxLines = 1)
                    Txt(if (p.size > 0) Wire.mb(p.size) else what, T.meta, k.faint, maxLines = 1)
                }
            }
        }
        // Not stored yet: the turning mark over the corner.
        if (p.busy) Box(Modifier.align(Alignment.BottomStart).padding(5.dp).clip(RoundedCornerShape(S.rPill)).background(k.bg.copy(alpha = 0.85f)).padding(4.dp)) {
            StateMark(State.WORKING, 10.dp)
        }
        // Remove: a finger-sized target over the corner, drawn as a small mark.
        Box(Modifier.align(Alignment.TopEnd).size(32.dp).press(onRemove).semantics { contentDescription = "remove-${p.name}" }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(20.dp).clip(RoundedCornerShape(S.rPill)).background(k.ink.copy(alpha = 0.78f)), contentAlignment = Alignment.Center) {
                KIcon(Ic.X, k.inkFg, 12.dp)
            }
        }
    }
}

/** What a sent message carried: its photos as pictures (a tap opens one whole), its files by name and size. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SentFiles(files: List<Attachment>, onView: (Attachment) -> Unit) {
    val k = k()
    val photos = files.filter { it.image }
    val others = files.filter { !it.image }
    if (photos.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 6.dp)) {
        // One photo is shown at its own shape; several are a grid of squares.
        for (a in photos) Thumb(a, if (photos.size == 1) 220.dp else 112.dp, whole = photos.size == 1) { onView(a) }
    }
    for (a in others) {
        val shape = RoundedCornerShape(S.r)
        Row(
            Modifier.padding(bottom = 6.dp).widthIn(max = 260.dp).clip(shape).background(k.raised).border(1.dp, k.line, shape).padding(horizontal = 10.dp, vertical = 8.dp)
                .semantics { contentDescription = "sent-file-${a.fileName}" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KIcon(Ic.File, k.muted, 18.dp)
            Spacer(Modifier.width(8.dp))
            Column {
                Txt(a.fileName.ifBlank { "File" }, T.small, k.fg, maxLines = 1)
                Txt(listOfNotNull(a.mime.takeIf { it.isNotBlank() }, a.size.takeIf { it > 0 }?.let(Wire::mb)).joinToString(" · "), T.meta, k.faint, maxLines = 1)
            }
        }
    }
}

/** The pixels a side of `dp` takes on this screen. */
@Composable private fun px(dp: androidx.compose.ui.unit.Dp) = with(LocalDensity.current) { dp.roundToPx() }

@Composable
private fun Thumb(a: Attachment, side: androidx.compose.ui.unit.Dp, whole: Boolean, onTap: () -> Unit) {
    val k = k()
    val edge = px(side)
    val shape = RoundedCornerShape(S.r)
    var img by remember(a.media) { mutableStateOf(Media.cached(a.media, edge)) }
    var failed by remember(a.media) { mutableStateOf(false) }
    LaunchedEffect(a.media) { if (img == null) runCatching { Media.get(a.media, edge) }.onSuccess { img = it }.onFailure { failed = true } }
    // Its shape, kept between a tall phone screenshot and a wide panorama.
    val ratio = img?.takeIf { whole }?.let { (it.width.toFloat() / it.height).coerceIn(0.5f, 2f) } ?: 1f
    Box(
        Modifier.width(side).aspectRatio(ratio).clip(shape).background(k.sunken).border(1.dp, k.line, shape).press(onTap).semantics { contentDescription = "sent-photo-${a.media}" },
        contentAlignment = Alignment.Center,
    ) {
        val i = img
        if (i != null) Image(i, "Photo", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else if (failed) Column(horizontalAlignment = Alignment.CenterHorizontally) { KIcon(Ic.Image, k.faint, 20.dp); Txt("Not loaded", T.meta, k.faint) }
        else StateMark(State.WORKING, 12.dp)
    }
}

/** A photo seen whole, over the session; back or a tap closes it. */
@Composable
fun Viewer(a: Attachment, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    val edge = LocalWindowInfo.current.containerSize.let { maxOf(it.width, it.height) }
    var img by remember(a.media) { mutableStateOf<ImageBitmap?>(Media.cached(a.media, edge)) }
    var why by remember(a.media) { mutableStateOf("") }
    LaunchedEffect(a.media) { if (img == null) runCatching { Media.get(a.media, edge) }.onSuccess { img = it }.onFailure { why = it.message ?: "Not loaded" } }
    // Black behind a photo in both themes: what a photo is seen against.
    Box(Modifier.fillMaxSize().background(Color.Black).press(onClose).semantics { contentDescription = "photo-viewer" }, contentAlignment = Alignment.Center) {
        val i = img
        if (i != null) Image(i, "Photo", Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        else if (why.isNotBlank()) Txt("The photo did not load: $why", T.small, Color.White, Modifier.padding(S.xl))
        else StateMark(State.WORKING, 16.dp)
        Box(Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(S.sm)) { IconBtn(Ic.X, "Close", onClose, tint = Color.White) }
    }
}
