package dev.avifenesh.keel

import dev.avifenesh.keel.ui.StatePalette
import java.io.File
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's state colors are the workbench's: the stylesheet's `--st-*` and `--dot-*` tokens (light in :root, dark in .dark),
 * converted from oklch, equal the table in Palette.kt within one step of rounding. A state color on the phone that the page
 * does not have fails here; the failure prints the value to put in the table.
 */
class PaletteTest {
    private val css: String = File("../../ui/src/styles.css").also { assertTrue("the stylesheet was not found from ${File(".").absolutePath}", it.isFile) }
        .readText().replace(Regex("/\\*.*?\\*/", RegexOption.DOT_MATCHES_ALL), "")

    private fun block(selector: String): Map<String, String> {
        val start = css.indexOf("$selector {").also { assertTrue("no $selector block", it >= 0) }
        val end = css.indexOf("\n}", start)
        return Regex("(--[\\w-]+):\\s*([^;]+);").findAll(css.substring(start, end)).associate { it.groupValues[1] to it.groupValues[2].trim() }
    }

    private val root = block(":root")
    private val dark = root + block(".dark")

    private fun resolve(vars: Map<String, String>, name: String): String {
        var v = vars.getValue(name)
        var n = 0
        while (n++ < 12) v = Regex("^var\\((--[\\w-]+)\\)$").find(v)?.let { vars.getValue(it.groupValues[1]) } ?: return v
        error("a loop at $name")
    }

    /** CSS oklch to 0xFFRRGGBB, clamped to the gamut (every palette color is inside it). */
    private fun argb(oklch: String): Long {
        val (l, c, h) = Regex("^oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)").find(oklch)!!.destructured.toList().map { it.toDouble() }
        val a = c * cos(Math.toRadians(h)); val b = c * sin(Math.toRadians(h))
        val l_ = (l + 0.3963377774 * a + 0.2158037573 * b).pow(3)
        val m_ = (l - 0.1055613458 * a - 0.0638541728 * b).pow(3)
        val s_ = (l - 0.0894841775 * a - 1.2914855480 * b).pow(3)
        val lin = doubleArrayOf(
            4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
            -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
            -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
        )
        val ch = lin.map { x -> val v = x.coerceIn(0.0, 1.0); Math.round(255 * (if (v <= 0.0031308) 12.92 * v else 1.055 * v.pow(1 / 2.4) - 0.055)).toInt() }
        return 0xFF000000L or (ch[0].toLong() shl 16) or (ch[1].toLong() shl 8) or ch[2].toLong()
    }

    private fun near(a: Long, b: Long) = (0..2).all { i -> Math.abs(((a shr (i * 8)) and 0xFF) - ((b shr (i * 8)) and 0xFF)) <= 1 }
    private fun hex(v: Long) = "0x%08XL".format(v)

    @Test fun theTableIsTheStylesheetsPalette() {
        val wrong = mutableListOf<String>()
        for ((name, pair) in StatePalette.tokens) for ((vars, have, theme) in listOf(Triple(root, pair.first, "light"), Triple(dark, pair.second, "dark"))) {
            val want = argb(resolve(vars, name))
            if (!near(want, have)) wrong += "$name $theme: has ${hex(have)}, the page has ${hex(want)}"
        }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test fun everyStateTokenOfThePageIsInTheTable() {
        // The page's marks, words and fills: a token the phone lacks is a state it cannot draw as the page does.
        val page = root.keys.filter { Regex("^--(st|dot)-[a-z-]+$").matches(it) }.toSet()
        assertEquals(emptyList<String>(), (page - StatePalette.tokens.keys).sorted())
        assertEquals(emptyList<String>(), (StatePalette.tokens.keys - page).sorted())
    }
}
