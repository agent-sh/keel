// The pieces every screen is built from, on the tokens of Theme.kt.
package dev.avifenesh.keel.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ripple
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.foundation.text.BasicText
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.State

@Composable fun k(): Tokens = LocalK.current

@Composable
fun Txt(text: String, style: TextStyle, color: Color = k().fg, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE) =
    BasicText(text, modifier, style.copy(color = color), maxLines = maxLines, overflow = TextOverflow.Ellipsis)

@Composable
fun KIcon(v: ImageVector, color: Color = k().fg, size: Dp = 20.dp, modifier: Modifier = Modifier) =
    Image(rememberVectorPainter(v), null, modifier.size(size), colorFilter = ColorFilter.tint(color))

/** A state as words, in the instrument face and the state's color. */
@Composable
fun StateTag(s: State, extra: String = "", only: Boolean = false) = Row(verticalAlignment = Alignment.CenterVertically) {
    StateMark(s, 9.dp)
    Spacer(Modifier.width(6.dp))
    Txt(if (only) extra else if (extra.isBlank()) s.word else "${s.word} · $extra", T.meta, k().inkOf(s))
}

fun Modifier.press(onClick: () -> Unit, enabled: Boolean = true, role: Role = Role.Button): Modifier = this.then(
    Modifier.clickable(enabled = enabled, role = role, interactionSource = null, indication = ripple(), onClick = onClick),
)

enum class Tone { INK, LINE, QUIET, DANGER, NEED }

/** Buttons: ink is the action, line the alternative, quiet the dismissal, danger the refusal. */
@Composable
fun Btn(
    text: String, onClick: () -> Unit, tone: Tone = Tone.INK, enabled: Boolean = true, icon: ImageVector? = null,
    modifier: Modifier = Modifier, compact: Boolean = false, tag: String = text,
) {
    val k = k()
    val (bg, fg, border) = when (tone) {
        Tone.INK -> Triple(k.ink, k.inkFg, Color.Transparent)
        Tone.NEED -> Triple(k.needFill, k.needOn, Color.Transparent)
        Tone.LINE -> Triple(k.raised, k.fg, k.lineStrong)
        Tone.QUIET -> Triple(Color.Transparent, k.muted, Color.Transparent)
        Tone.DANGER -> Triple(Color.Transparent, k.danger, k.danger.copy(alpha = 0.45f))
    }
    val shape = RoundedCornerShape(S.r)
    Row(
        modifier.clip(shape).background(if (enabled) bg else bg.copy(alpha = 0.4f)).border(1.dp, border, shape)
            .press(onClick, enabled).semantics { contentDescription = tag }
            .padding(if (compact) PaddingValues(horizontal = 12.dp, vertical = 7.dp) else PaddingValues(horizontal = 16.dp, vertical = 11.dp)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        if (icon != null) { KIcon(icon, fg, if (compact) 16.dp else 18.dp); Spacer(Modifier.width(8.dp)) }
        Txt(text, if (compact) T.uiStrong.copy(fontSize = T.small.fontSize) else T.uiStrong, if (enabled) fg else fg.copy(alpha = 0.6f), maxLines = 1)
    }
}

/** A square icon button. */
@Composable
fun IconBtn(v: ImageVector, label: String, onClick: () -> Unit, tint: Color = k().fg, modifier: Modifier = Modifier, enabled: Boolean = true) =
    Box(modifier.size(40.dp).clip(RoundedCornerShape(S.r)).press(onClick, enabled).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        KIcon(v, if (enabled) tint else tint.copy(alpha = 0.4f), 20.dp)
    }

/** A raised panel with a hairline border; `accent` draws a state stripe down its left edge. */
@Composable
fun Panel(modifier: Modifier = Modifier, accent: Color? = null, content: @Composable () -> Unit) {
    val k = k()
    val shape = RoundedCornerShape(S.rLg)
    Box(
        modifier.fillMaxWidth().clip(shape).background(k.raised).border(1.dp, k.line, shape)
            .drawBehind { if (accent != null) drawRect(accent, size = Size(3.dp.toPx(), size.height)) },
    ) { content() }
}

/** A section heading in the instrument face: "NEEDS YOU  2". */
@Composable
fun SectionLabel(text: String, count: Int? = null, color: Color = k().muted, modifier: Modifier = Modifier) =
    Row(modifier.padding(horizontal = S.lg, vertical = S.sm), verticalAlignment = Alignment.CenterVertically) {
        Txt(text.uppercase(), T.label, color)
        if (count != null) { Spacer(Modifier.width(8.dp)); Txt("$count", T.label, k().faint) }
    }

/** A pill of a few words. */
@Composable
fun Pill(text: String, fg: Color, bg: Color, modifier: Modifier = Modifier) =
    Box(modifier.clip(RoundedCornerShape(S.rPill)).background(bg).padding(horizontal = 8.dp, vertical = 2.dp)) { Txt(text, T.label, fg, maxLines = 1) }

/** The page head: a back or brand slot, the title in the instrument face, actions. */
@Composable
fun Head(title: String, sub: (@Composable () -> Unit)? = null, lead: (@Composable () -> Unit)? = null, actions: @Composable RowScope.() -> Unit = {}) {
    // At least a finger's row, and taller when the text size asks for it: a fixed height cut the second line at 200%.
    Row(Modifier.fillMaxWidth().padding(start = if (lead != null) 4.dp else S.lg, end = 6.dp, top = 6.dp, bottom = 6.dp).heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
        if (lead != null) { lead(); Spacer(Modifier.width(4.dp)) }
        Column(Modifier.weight(1f)) {
            Txt(title, if (lead != null) T.title else T.display, maxLines = 1)
            if (sub != null) { Spacer(Modifier.height(2.dp)); sub() }
        }
        actions()
    }
}

/** A line between rows. */
@Composable fun Rule(modifier: Modifier = Modifier) = Box(modifier.fillMaxWidth().height(1.dp).background(k().line))

/** The Keel mark: a hull over its keel on the sea tile. */
@Composable
fun Mark(size: Dp = 40.dp, modifier: Modifier = Modifier) {
    val k = k()
    Canvas(modifier.size(size)) {
        val u = this.size.minDimension / 32f
        drawRoundRect(k.sea, cornerRadius = CornerRadius(8 * u))
        val hull = Path().apply {
            moveTo(6 * u, 11.5f * u); lineTo(26 * u, 11.5f * u)
            cubicTo(24.9f * u, 16.4f * u, 21 * u, 19.1f * u, 16 * u, 19.1f * u)
            cubicTo(11 * u, 19.1f * u, 7.1f * u, 16.4f * u, 6 * u, 11.5f * u); close()
        }
        drawPath(hull, k.hull)
        drawPath(Path().apply { moveTo(14.6f * u, 18.6f * u); lineTo(17.4f * u, 18.6f * u); lineTo(16.7f * u, 25 * u); lineTo(15.3f * u, 25 * u); close() }, k.hull)
    }
}

/** A message that something did not work, with what to do. */
/**
 * A notice. A screen reader says its words when it appears (a polite live
 * region); a test finds it by a testTag on `modifier`, never by a content
 * description, which would be read in place of the words.
 */
@Composable
fun Notice(text: String, color: Color = k().danger, modifier: Modifier = Modifier) {
    val k = k()
    Row(modifier.semantics { liveRegion = LiveRegionMode.Polite }.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(if (color == k.danger) k.dangerSoft else k.sunken).padding(12.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 5.dp)) { Box(Modifier.size(8.dp).clip(RoundedCornerShape(2.dp)).background(color)) }
        Spacer(Modifier.width(10.dp))
        Txt(text, T.small, if (color == k.danger) k.fg else k.muted)
    }
}

/** Keeps a reading width on wide screens. */
fun Modifier.reading() = this.widthIn(max = 720.dp)

@Composable fun rememberSource() = remember { MutableInteractionSource() }
