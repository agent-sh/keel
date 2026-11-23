// What the agent writes, rendered: paragraphs, headings, lists, quotes, code
// blocks, tables and display math, with bold, italic, inline code, links and
// math inline (Math.kt).
package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em

sealed class Block {
    data class Para(val text: String) : Block()
    data class Heading(val level: Int, val text: String) : Block()
    data class Item(val marker: String, val text: String, val depth: Int) : Block()
    data class Quote(val text: String) : Block()
    data class Code(val lang: String, val text: String) : Block()
    data class Table(val rows: List<List<String>>) : Block()
    data class Math(val tex: String) : Block()
}

// Display math that starts a line: $$...$$ or \[...\], on one line or over several. The lines it
// covers and its TeX, or null when it is not closed (a reply still streaming shows it as written).
// It ends at a blank line, and within DISPLAY_LINES lines and DISPLAY_CHARS characters (ten inline
// formulas): each opener reads that far at most, so a reply of openers is read in bounded time.
private const val DISPLAY_LINES = 200
private const val DISPLAY_CHARS = 10 * INLINE_MATH_CHARS

private fun displayMath(lines: List<String>, from: Int): Pair<Int, String>? {
    val t = lines[from].trimStart()
    val (open, close) = when { t.startsWith("$$") -> "$$" to "$$"; t.startsWith("\\[") -> "\\[" to "\\]"; else -> return null }
    if (t.length > DISPLAY_CHARS) return null
    val first = t.removePrefix(open)
    first.indexOf(close).takeIf { it >= 0 }?.let { e -> return if (first.substring(e + close.length).isBlank() && first.substring(0, e).isNotBlank()) 1 to first.substring(0, e).trim() else null }
    val body = StringBuilder(first)
    for (j in from + 1 until minOf(lines.size, from + DISPLAY_LINES)) {
        val line = lines[j]
        if (line.isBlank() || body.length + line.length > DISPLAY_CHARS) return null
        val e = line.indexOf(close)
        if (e >= 0) {
            if (line.substring(e + close.length).isNotBlank()) return null
            body.append('\n').append(line.substring(0, e))
            return (j - from + 1) to body.toString().trim()
        }
        body.append('\n').append(line)
    }
    return null
}

/** Splits markdown into blocks. An unclosed fence (a reply still streaming) runs to the end. */
fun blocks(md: String): List<Block> {
    val out = mutableListOf<Block>()
    val lines = md.replace("\r\n", "\n").split('\n')
    var i = 0
    val para = StringBuilder()
    fun flush() { if (para.isNotBlank()) out += Block.Para(para.toString().trim()); para.clear() }
    while (i < lines.size) {
        val l = lines[i]
        val t = l.trimStart()
        when {
            t.startsWith("```") -> {
                flush()
                val lang = t.removePrefix("```").trim()
                val body = StringBuilder(); i++
                // A fence inside a list item is indented with it: the code is taken without that indent.
                val indent = l.length - t.length
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    val line = lines[i]
                    val lead = line.length - line.trimStart().length
                    body.append(line.substring(minOf(indent, lead))).append('\n'); i++
                }
                out += Block.Code(lang, body.toString().trimEnd('\n'))
            }
            (t.startsWith("$$") || t.startsWith("\\[")) && displayMath(lines, i) != null -> {
                flush()
                val (n, tex) = displayMath(lines, i)!!
                out += Block.Math(tex); i += n; continue
            }
            Regex("^#{1,6} ").containsMatchIn(t) -> { flush(); out += Block.Heading(t.takeWhile { it == '#' }.length, t.dropWhile { it == '#' }.trim()) }
            Regex("^([-*+]|\\d+[.)]) ").containsMatchIn(t) -> {
                flush()
                val m = Regex("^([-*+]|\\d+[.)]) (.*)").find(t)!!
                val marker = m.groupValues[1].let { if (it in setOf("-", "*", "+")) "•" else it }
                out += Block.Item(marker, m.groupValues[2], (l.length - t.length) / 2)
            }
            t.startsWith(">") -> { flush(); out += Block.Quote(t.removePrefix(">").trim()) }
            t.startsWith("|") && t.endsWith("|") -> {
                flush()
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].trim().let { it.startsWith("|") && it.endsWith("|") }) {
                    val cells = lines[i].trim().trim('|').split('|').map { it.trim() }
                    if (!cells.all { it.matches(Regex(":?-{2,}:?")) }) rows += cells
                    i++
                }
                out += Block.Table(rows); continue
            }
            t.isBlank() -> flush()
            else -> { if (para.isNotEmpty()) para.append(' '); para.append(t) }
        }
        i++
    }
    flush()
    return out
}

/** Inline marks: **bold**, *italic* or _italic_, `code`, [text](url), math ($...$, \\(...\\)), and \\ before a mark to write it as is. */
fun inline(s: String, code: SpanStyle, link: SpanStyle): AnnotatedString = buildAnnotatedString {
    var i = 0
    val scan = MathScan(s)
    // The same TeX is set once ($n$ comes back), and a block sets MATH_PER_BLOCK formulas at most.
    val set = HashMap<String, List<MathRun>>()
    var formulas = 0
    while (i < s.length) {
        val c = s[i]
        val math = if ((c == '$' || s.startsWith("\\(", i)) && formulas < MATH_PER_BLOCK) scan.at(i) else null
        when {
            math != null -> { formulas++; math(set.getOrPut(math.second) { mathRuns(math.second) }); i += math.first }
            c == '\\' && i + 1 < s.length && s[i + 1] in ESCAPABLE -> { append(s[i + 1]); i += 2 }
            c == '`' -> { val e = s.indexOf('`', i + 1); if (e > i) { withStyle(code) { append(s.substring(i + 1, e)) }; i = e + 1 } else { append(c); i++ } }
            s.startsWith("**", i) -> { val e = s.indexOf("**", i + 2); if (e > i) { withStyle(SpanStyle(fontWeight = FontWeight(600))) { append(inline(s.substring(i + 2, e), code, link)) }; i = e + 2 } else { append(c); i++ } }
            (c == '*' || c == '_') && i + 1 < s.length && s[i + 1] != ' ' && (i == 0 || !s[i - 1].isLetterOrDigit()) -> {
                val e = s.indexOf(c, i + 1)
                if (e > i + 1 && (e + 1 >= s.length || !s[e + 1].isLetterOrDigit())) { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(s.substring(i + 1, e)) }; i = e + 1 } else { append(c); i++ }
            }
            // [text](url): the text up to the first ], the url up to a ) with no space in it.
            c == '[' -> {
                val e = scan.bracket.from(i + 1)
                val end = if (e > i + 1 && e + 2 < s.length && s[e + 1] == '(') scan.close.from(e + 2) else -1
                val sp = if (end > e + 2) scan.space.from(e + 2) else -1
                if (end > e + 2 && (sp < 0 || sp > end)) { withStyle(link) { append(s.substring(i + 1, e)) }; i = end + 1 } else { append(c); i++ }
            }
            else -> { append(c); i++ }
        }
    }
}

// How many formulas one block of a reply sets; the rest is shown as written. A screen shows a few
// dozen; a block of more is a table or a dump, and setting each costs the UI thread some 15 us on
// a phone, again with every streamed token: 1,000 keep a block under about 15 ms.
private const val MATH_PER_BLOCK = 1_000

// What CommonMark lets a backslash write as it is.
private const val ESCAPABLE = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

// A line of prose breaks around math, never inside it: its spaces do not break.
private val NO_BREAK = mapOf(' ' to '\u00A0', '\u2009' to '\u202F', '\u2004' to '\u00A0', '\u2005' to '\u00A0', '\u2003' to '\u00A0', '\u2002' to '\u00A0')

// Math in its own face (a serif, as TeX sets it): scripts smaller and raised or lowered by their level.
private fun AnnotatedString.Builder.math(runs: List<MathRun>) {
    for (r in runs) {
        val size = Math.pow(0.75, kotlin.math.abs(r.level).toDouble())
        // How far the run sits from the line, in the base size: each level a little less than the last.
        var off = 0.0; for (k in 0 until kotlin.math.abs(r.level)) off += (if (r.level > 0) 0.36 else 0.2) * Math.pow(0.75, k.toDouble())
        val shift = if (r.level == 0) null else BaselineShift((off / (0.93 * size) * (if (r.level > 0) 1 else -1)).toFloat())
        withStyle(SpanStyle(fontFamily = FontFamily.Serif, fontStyle = if (r.italic) FontStyle.Italic else FontStyle.Normal,
            fontWeight = if (r.bold) FontWeight(700) else null, fontSize = if (r.level == 0) TextUnit.Unspecified else size.em, baselineShift = shift)) { append(r.text.map { NO_BREAK[it] ?: it }.joinToString("")) }
    }
}

/** Math as an AnnotatedString of its own: a display block, or a test. */
fun mathString(tex: String): AnnotatedString = buildAnnotatedString { math(mathRuns(tex)) }

// A block's text as it is drawn: one string, or a table's cells row by row.
private fun setBlock(b: Block, code: SpanStyle, link: SpanStyle): List<AnnotatedString> = when (b) {
    is Block.Para -> listOf(inline(b.text, code, link))
    is Block.Heading -> listOf(inline(b.text, code, link))
    is Block.Item -> listOf(inline(b.text, code, link))
    is Block.Quote -> listOf(inline(b.text, code, link))
    is Block.Math -> listOf(mathString(b.tex))
    is Block.Table -> b.rows.flatMap { row -> row.map { inline(it, code, link) } }
    is Block.Code -> emptyList()
}

@Composable
fun Markdown(md: String, style: TextStyle = T.body, modifier: Modifier = Modifier) {
    val k = k()
    val code = SpanStyle(fontFamily = Mono, fontSize = 0.86.em, background = k.sunken)
    val link = SpanStyle(color = k.ownerInk, textDecoration = TextDecoration.Underline)
    val base = style.copy(color = k.fg)
    // Set once for each text and theme, not on every recomposition: a list scrolled or a tick of the
    // clock draws the reply again but does not read it again.
    val set = remember(md, code, link) { blocks(md).map { it to setBlock(it, code, link) } }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for ((b, text) in set) when (b) {
            is Block.Para -> BasicText(text[0], style = base)
            is Block.Heading -> BasicText(text[0], style = (if (b.level <= 2) T.title else T.bodyStrong).copy(color = k.fg), modifier = Modifier.padding(top = 4.dp))
            is Block.Item -> Row(Modifier.padding(start = (b.depth * 16).dp)) {
                BasicText(b.marker, style = base.copy(color = k.muted), modifier = Modifier.width(if (b.marker == "•") 16.dp else 24.dp))
                BasicText(text[0], style = base, modifier = Modifier.weight(1f))
            }
            is Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(k.lineStrong))
                Spacer(Modifier.width(12.dp))
                BasicText(text[0], style = base.copy(color = k.muted))
            }
            is Block.Code -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(k.code).border(1.dp, k.line, RoundedCornerShape(S.r))) {
                // The language and Copy over the code: a command to run elsewhere is taken whole, not by a selection.
                Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Txt(b.lang, T.label, k.faint, Modifier.weight(1f))
                    CopyBtn(b.text, "Copy the code", "copy-code")
                }
                BasicText(b.text, style = T.code.copy(color = k.fg), softWrap = false,
                    modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 10.dp))
            }
            // Display math: centered on its own lines, scrolled sideways when it is wider than the screen.
            is Block.Math -> Box(Modifier.fillMaxWidth().padding(vertical = 2.dp), contentAlignment = Alignment.Center) {
                BasicText(text[0], style = base.copy(fontSize = base.fontSize * 1.1f, lineHeight = base.lineHeight * 1.15f), softWrap = false,
                    modifier = Modifier.horizontalScroll(rememberScrollState()).testTag("math"))
            }
            is Block.Table -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).border(1.dp, k.line, RoundedCornerShape(S.r)).horizontalScroll(rememberScrollState())) {
                val widths = (0 until (b.rows.maxOfOrNull { it.size } ?: 0)).map { c -> (b.rows.maxOfOrNull { it.getOrNull(c)?.length ?: 0 } ?: 0).coerceIn(4, 28) }
                var at = 0
                b.rows.forEachIndexed { r, row ->
                    Row(Modifier.background(if (r == 0) k.sunken else k.raised).padding(horizontal = 4.dp)) {
                        row.forEachIndexed { c, _ ->
                            BasicText(text[at++], style = T.small.copy(color = k.fg, fontWeight = if (r == 0) FontWeight(600) else FontWeight(400)),
                                modifier = Modifier.width((widths.getOrElse(c) { 8 } * 8 + 16).dp).padding(horizontal = 8.dp, vertical = 6.dp))
                        }
                    }
                }
            }
        }
    }
}
