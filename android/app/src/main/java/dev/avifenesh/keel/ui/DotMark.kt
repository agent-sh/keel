// The state dot (the page's .k-mark, ui/src/bridge.css): one small mark per state, drawn from `look` (Dot.kt).
package dev.avifenesh.keel.ui

import android.provider.Settings
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.Dot
import dev.avifenesh.keel.Form
import dev.avifenesh.keel.Look
import dev.avifenesh.keel.State
import dev.avifenesh.keel.dotOfState
import dev.avifenesh.keel.look

/** Motion is off when the owner turned the system's animations off (the Android setting for reduced motion). */
@Composable
fun reducedMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return remember { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

private fun Tokens.token(name: String) = Color(StatePalette.of(name, dark))

/**
 * The dot, with its word for a reader. `halo`: the work dot's soft halo, which breathes slowly (opacity and scale only) and
 * stands still under reduced motion; only a row's dot has it, as on the page, where a count's or an alert's small dot does not.
 */
@Composable
fun DotMark(look: Look, size: Dp = 10.dp, modifier: Modifier = Modifier, halo: Boolean = false) {
    val k = k()
    val fill = k.token(look.fill)
    val edge = k.token(look.edge)
    val breathe = if (halo && look.breathes) {
        rememberInfiniteTransition(label = "breath").animateFloat(0f, 1f, infiniteRepeatable(tween(1700, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "breath").value
    } else 1f
    Canvas(modifier.size(size).semantics { contentDescription = look.word }) {
        val w = this.size.minDimension
        val c = Offset(w / 2, w / 2)
        val hair = 1.dp.toPx()
        if (halo && look.halo) {
            // A ring of soft blue around the dot: transparent inside the dot's edge, 55% blue just outside it, transparent at 1.9 times its size.
            val reach = w * 0.95f * (if (look.breathes) 0.92f + 0.16f * breathe else 1f)
            val a = if (look.breathes) 0.3f + 0.7f * breathe else 0.7f
            drawCircle(
                Brush.radialGradient(0.52f to Color.Transparent, 0.64f to fill.copy(alpha = 0.55f * a), 1f to Color.Transparent, center = c, radius = reach),
                radius = reach, center = c,
            )
        }
        when (look.form) {
            Form.SOLID -> drawCircle(fill, w / 2, c)
            Form.EDGED -> { drawCircle(fill, w / 2, c); drawCircle(edge, w / 2 + hair / 2, c, style = Stroke(hair)) }
            Form.HOLLOW -> { val t = (if (look.dot == Dot.DECLINED) 2f else 1.5f) * hair; drawCircle(fill, (w - t) / 2, c, style = Stroke(t)) }
            Form.HALF -> {
                val t = 1.5f * hair
                clipPath(Path().apply { addOval(androidx.compose.ui.geometry.Rect(0f, 0f, w, w)) }) { drawRect(fill, Offset(0f, w / 2), Size(w, w / 2)) }
                drawCircle(fill, (w - t) / 2, c, style = Stroke(t))
            }
            Form.IN_RING -> { val t = 1.5f * hair; drawCircle(fill, (w - t) / 2, c, style = Stroke(t)); drawCircle(fill, w * 0.2f, c) }
            Form.SQUARE -> { val t = 2f * hair; drawRoundRect(fill, Offset(t / 2, t / 2), Size(w - t, w - t), CornerRadius(2f * hair), style = Stroke(t)) }
            Form.OPEN -> { val t = 2f * hair; drawArc(fill, 45f, 270f, false, Offset(t / 2, t / 2), Size(w - t, w - t), style = Stroke(t)) }
        }
    }
}

/** A state of the app's own six as a dot, without the halo (a connection line, a card, a status line in a transcript). */
@Composable
fun StateMark(s: State, size: Dp = 10.dp, modifier: Modifier = Modifier) = DotMark(look(dotOfState(s), word = s.word), size, modifier)
