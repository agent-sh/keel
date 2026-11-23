// Keel's design system on the phone, the workbench's "Bridge": steel and ink.
// Color means state and nothing else: violet is the owner (needs you), amber is
// work, red is a failure, sea green is done. Buttons are ink. Martian Mono at a
// narrow width sets what a glance reads (titles, states, times); Plex Sans sets
// what the agent writes; JetBrains Mono sets code. The values are the
// workbench's tokens (ui/src/styles.css) in sRGB.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.avifenesh.keel.R
import dev.avifenesh.keel.State

@Immutable
data class Tokens(
    val dark: Boolean,
    val bg: Color, val panel: Color, val raised: Color, val sunken: Color, val hover: Color,
    val fg: Color, val muted: Color, val faint: Color, val line: Color, val lineStrong: Color,
    val ink: Color, val inkFg: Color, val inkSoft: Color, val ownerInk: Color,
    val danger: Color, val dangerSoft: Color, val code: Color,
    val need: Color, val work: Color, val fail: Color, val done: Color, val idle: Color,
    val needSoft: Color, val workSoft: Color,
    val sea: Color = Color(0xFF0E6A80), val hull: Color = Color(0xFFF4FAF9),
)

val Light = Tokens(
    dark = false,
    bg = Color(0xFFEBEEF1), panel = Color(0xFFDFE3E8), raised = Color(0xFFF9FAFB), sunken = Color(0xFFE4E8EC), hover = Color(0x99D3D8DE),
    fg = Color(0xFF11161F), muted = Color(0xFF464E58), faint = Color(0xFF626A73), line = Color(0xFFCCD1D7), lineStrong = Color(0xFFABB2BA),
    ink = Color(0xFF11161F), inkFg = Color(0xFFF3F5F8), inkSoft = Color(0xFFD5DBE3), ownerInk = Color(0xFF382F5E),
    danger = Color(0xFFCC2827), dangerSoft = Color(0xFFFFE8E6), code = Color(0xFFE7EAED),
    need = Color(0xFF773CD6), work = Color(0xFFCB7300), fail = Color(0xFFCC2827), done = Color(0xFF26795F), idle = Color(0xFF7A8189),
    needSoft = Color(0xFFEEE7FB), workSoft = Color(0xFFF8EBD9),
)

val Dark = Tokens(
    dark = true,
    bg = Color(0xFF12181E), panel = Color(0xFF0C1117), raised = Color(0xFF181F27), sunken = Color(0xFF0E1319), hover = Color(0x8C272E38),
    fg = Color(0xFFE4E8ED), muted = Color(0xFFA5ACB4), faint = Color(0xFF80878F), line = Color(0xFF262C33), lineStrong = Color(0xFF3C434C),
    ink = Color(0xFFE4E8ED), inkFg = Color(0xFF11161D), inkSoft = Color(0xFF272E38), ownerInk = Color(0xFFC8B7FF),
    danger = Color(0xFFFA695E), dangerSoft = Color(0xFF431F1D), code = Color(0xFF0D1218),
    need = Color(0xFFB492FF), work = Color(0xFFF8AC3D), fail = Color(0xFFFA695E), done = Color(0xFF6EBDA0), idle = Color(0xFF6C727A),
    needSoft = Color(0xFF241D38), workSoft = Color(0xFF2B2216),
)

/** A diff's tints, as the workbench draws them (ui/src/styles.css, .k-diff-line): added on done, removed on danger. */
val Tokens.addTint get() = done.copy(alpha = if (dark) 0.16f else 0.12f)
val Tokens.delTint get() = dangerSoft.copy(alpha = 0.85f)

fun Tokens.of(s: State): Color = when (s) {
    State.NEEDS -> need; State.WORKING -> work; State.FAILED -> fail; State.DONE -> done; State.STOPPED, State.IDLE -> idle
}

@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun inst(w: Int) = Font(R.font.martian_mono, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w), FontVariation.width(87.5f)))
@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun plex(w: Int) = Font(R.font.plex_sans, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))
@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
private fun jb(w: Int) = Font(R.font.jetbrains_mono, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))

val Inst = FontFamily(inst(400), inst(500), inst(600), inst(700))
val Sans = FontFamily(plex(400), plex(500), plex(600), plex(700))
val Mono = FontFamily(jb(400), jb(500), jb(600))

/** The type scale. */
object T {
    val display = TextStyle(fontFamily = Inst, fontWeight = FontWeight(600), fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = (-0.025).em)
    val title = TextStyle(fontFamily = Inst, fontWeight = FontWeight(600), fontSize = 17.sp, lineHeight = 22.sp, letterSpacing = (-0.02).em)
    val label = TextStyle(fontFamily = Inst, fontWeight = FontWeight(500), fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.04.em)
    val meta = TextStyle(fontFamily = Inst, fontWeight = FontWeight(400), fontSize = 12.sp, lineHeight = 16.sp)
    val body = TextStyle(fontFamily = Sans, fontWeight = FontWeight(400), fontSize = 16.sp, lineHeight = 24.sp)
    val bodyStrong = TextStyle(fontFamily = Sans, fontWeight = FontWeight(600), fontSize = 16.sp, lineHeight = 22.sp)
    val ui = TextStyle(fontFamily = Sans, fontWeight = FontWeight(400), fontSize = 14.sp, lineHeight = 20.sp)
    val uiStrong = TextStyle(fontFamily = Sans, fontWeight = FontWeight(600), fontSize = 14.sp, lineHeight = 20.sp)
    val small = TextStyle(fontFamily = Sans, fontWeight = FontWeight(400), fontSize = 13.sp, lineHeight = 18.sp)
    val code = TextStyle(fontFamily = Mono, fontWeight = FontWeight(400), fontSize = 13.sp, lineHeight = 20.sp)
}

/** Spacing and radii (the workbench's scale is tight: radii of 4 to 8). */
object S {
    val xs = 4.dp; val sm = 8.dp; val md = 12.dp; val lg = 16.dp; val xl = 24.dp; val xxl = 32.dp
    val r = 6.dp; val rLg = 8.dp; val rPill = 999.dp
}

val LocalK = staticCompositionLocalOf { Light }

/** 0 follows the system, 1 light, 2 dark. */
@Composable
fun KeelTheme(mode: Int, content: @Composable () -> Unit) {
    val dark = when (mode) { 1 -> false; 2 -> true; else -> isSystemInDarkTheme() }
    val k = if (dark) Dark else Light
    // Material only for the pieces it draws by itself (selection handles, ripples), in Keel's colors.
    val scheme = if (dark) darkColorScheme(primary = k.ink, onPrimary = k.inkFg, background = k.bg, surface = k.raised, onSurface = k.fg, error = k.danger)
    else lightColorScheme(primary = k.ink, onPrimary = k.inkFg, background = k.bg, surface = k.raised, onSurface = k.fg, error = k.danger)
    CompositionLocalProvider(LocalK provides k) { MaterialTheme(colorScheme = scheme, content = content) }
}
