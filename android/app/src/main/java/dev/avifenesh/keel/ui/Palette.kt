// The state palette of the workbench (ui/src/styles.css: --st-*, --dot-*), in sRGB, light and dark.
// The page cannot be read at run time, so this is a table kept in step with it by a test
// (PaletteTest reads the stylesheet and fails when a value differs, printing the value to put here).
// Plain numbers, no Compose types, so the test can read it without the app's resources.
package dev.avifenesh.keel.ui

object StatePalette {
    /** Name as in the stylesheet to (light, dark) as 0xAARRGGBB. */
    val tokens: Map<String, Pair<Long, Long>> = mapOf(
        "--dot-work" to (0xFF0071E0L to 0xFF49A9FFL),
        "--dot-need" to (0xFFEBB500L to 0xFFEFCC36L),
        "--dot-need-edge" to (0xFF966800L to 0xFFEFCC36L),
        "--dot-fail" to (0xFFCC2827L to 0xFFFA695EL),
        "--dot-done" to (0xFF137738L to 0xFF4FCE74L),
        "--dot-unread" to (0xFF11161FL to 0xFFF8F8F8L),
        "--st-need" to (0xFF966800L to 0xFFEFCC36L),
        "--st-need-ink" to (0xFF735100L to 0xFFEFCC36L),
        "--st-need-fill" to (0xFFEBB500L to 0xFFEFCC36L),
        "--st-need-on" to (0xFF11161FL to 0xFF11161FL),
        "--st-work" to (0xFF0071E0L to 0xFF49A9FFL),
        "--st-work-ink" to (0xFF0859ACL to 0xFF49A9FFL),
        "--st-wait" to (0xFF0071E0L to 0xFF49A9FFL),
        "--st-wait-ink" to (0xFF0859ACL to 0xFF49A9FFL),
        "--st-fail" to (0xFFCC2827L to 0xFFFA695EL),
        "--st-fail-ink" to (0xFFBB0916L to 0xFFFA695EL),
        "--st-done" to (0xFF137738L to 0xFF4FCE74L),
        "--st-done-ink" to (0xFF09672EL to 0xFF6CC581L),
        "--st-idle" to (0xFF6F757DL to 0xFF6C727AL),
    )

    fun of(name: String, dark: Boolean): Long = tokens.getValue(name).let { if (dark) it.second else it.first }

    /** The surfaces a state color sits on (the workbench's --bg, --panel, --raised, --sunken), light and dark: the colors are checked against each. */
    val surfaces: Map<String, Pair<Long, Long>> = mapOf(
        "bg" to (0xFFEBEEF1L to 0xFF12181EL),
        "panel" to (0xFFDFE3E8L to 0xFF0C1117L),
        "raised" to (0xFFF9FAFBL to 0xFF181F27L),
        "sunken" to (0xFFE4E8ECL to 0xFF0E1319L),
    )

    fun surface(name: String, dark: Boolean): Long = surfaces.getValue(name).let { if (dark) it.second else it.first }
}
