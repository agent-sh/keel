package dev.avifenesh.keel

import dev.avifenesh.keel.ui.StatePalette
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.pow

/**
 * A state's word is read at 4.5:1 and its mark seen at 3:1, on every surface, in both themes (the page checks the same
 * on its rail: test/e2e/state-dots.spec.ts). The yellow dot is too light to stand off a light surface by its fill, so its
 * mark is the darker edge (--st-need); the fill carries its own dark ink at 4.5:1.
 */
class ContrastTest {
    private fun lum(c: Long): Double {
        fun ch(shift: Int): Double { val v = ((c shr shift) and 0xFF) / 255.0; return if (v <= 0.04045) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4) }
        return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
    }
    private fun ratio(a: Long, b: Long): Double { val (x, y) = listOf(lum(a), lum(b)).sortedDescending(); return (x + 0.05) / (y + 0.05) }

    private val words = listOf("--st-need-ink", "--st-work-ink", "--st-wait-ink", "--st-fail-ink", "--st-done-ink")
    private val marks = listOf("--st-need", "--st-work", "--st-wait", "--st-fail", "--st-done", "--st-idle", "--dot-work", "--dot-fail", "--dot-done", "--dot-need-edge", "--dot-unread")

    private fun check(names: List<String>, least: Double): List<String> = buildList {
        for (dark in listOf(false, true)) for (name in names) for (surface in StatePalette.surfaces.keys) {
            val r = ratio(StatePalette.of(name, dark), StatePalette.surface(surface, dark))
            if (r < least) add("$name on $surface (${if (dark) "dark" else "light"}) is %.2f:1, needs $least".format(r))
        }
    }

    @Test fun aStatesWordIsReadAtFourAndAHalfToOne() = assertEquals(emptyList<String>(), check(words, 4.5))

    @Test fun aStatesMarkIsSeenAtThreeToOne() = assertEquals(emptyList<String>(), check(marks, 3.0))

    @Test fun theYellowFillCarriesItsInkAtFourAndAHalfToOne() {
        for (dark in listOf(false, true)) assertEquals(true, ratio(StatePalette.of("--st-need-on", dark), StatePalette.of("--st-need-fill", dark)) >= 4.5)
    }
}
