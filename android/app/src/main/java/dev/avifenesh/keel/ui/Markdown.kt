// What the agent writes, rendered: paragraphs, headings, lists, quotes, code
// blocks and tables, with bold, italic, inline code and links inline.
package dev.avifenesh.keel.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em

sealed class Block {
    data class Para(val text: String) : Block()
    data class Heading(val level: Int, val text: String) : Block()
    data class Item(val marker: String, val text: String, val depth: Int) : Block()
    data class Quote(val text: String) : Block()
    data class Code(val lang: String, val text: String) : Block()
    data class Table(val rows: List<List<String>>) : Block()
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
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) { body.append(lines[i]).append('\n'); i++ }
                out += Block.Code(lang, body.toString().trimEnd('\n'))
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

/** Inline marks: **bold**, *italic* or _italic_, `code`, [text](url). */
fun inline(s: String, code: SpanStyle, link: SpanStyle): AnnotatedString = buildAnnotatedString {
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '`' -> { val e = s.indexOf('`', i + 1); if (e > i) { withStyle(code) { append(s.substring(i + 1, e)) }; i = e + 1 } else { append(c); i++ } }
            s.startsWith("**", i) -> { val e = s.indexOf("**", i + 2); if (e > i) { withStyle(SpanStyle(fontWeight = FontWeight(600))) { append(inline(s.substring(i + 2, e), code, link)) }; i = e + 2 } else { append(c); i++ } }
            (c == '*' || c == '_') && i + 1 < s.length && s[i + 1] != ' ' && (i == 0 || !s[i - 1].isLetterOrDigit()) -> {
                val e = s.indexOf(c, i + 1)
                if (e > i + 1 && (e + 1 >= s.length || !s[e + 1].isLetterOrDigit())) { withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(s.substring(i + 1, e)) }; i = e + 1 } else { append(c); i++ }
            }
            c == '[' -> {
                val m = Regex("^\\[([^\\]]+)]\\(([^)\\s]+)\\)").find(s.substring(i))
                if (m != null) { withStyle(link) { append(m.groupValues[1]) }; i += m.value.length } else { append(c); i++ }
            }
            else -> { append(c); i++ }
        }
    }
}

@Composable
fun Markdown(md: String, style: TextStyle = T.body, modifier: Modifier = Modifier) {
    val k = k()
    val code = SpanStyle(fontFamily = Mono, fontSize = 0.86.em, background = k.sunken)
    val link = SpanStyle(color = k.ownerInk, textDecoration = TextDecoration.Underline)
    val base = style.copy(color = k.fg)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        for (b in blocks(md)) when (b) {
            is Block.Para -> BasicText(inline(b.text, code, link), style = base)
            is Block.Heading -> BasicText(inline(b.text, code, link), style = (if (b.level <= 2) T.title else T.bodyStrong).copy(color = k.fg), modifier = Modifier.padding(top = 4.dp))
            is Block.Item -> Row(Modifier.padding(start = (b.depth * 16).dp)) {
                BasicText(b.marker, style = base.copy(color = k.muted), modifier = Modifier.width(if (b.marker == "•") 16.dp else 24.dp))
                BasicText(inline(b.text, code, link), style = base, modifier = Modifier.weight(1f))
            }
            is Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(k.lineStrong))
                Spacer(Modifier.width(12.dp))
                BasicText(inline(b.text, code, link), style = base.copy(color = k.muted))
            }
            is Block.Code -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).background(k.code).border(1.dp, k.line, RoundedCornerShape(S.r))) {
                if (b.lang.isNotBlank()) Txt(b.lang, T.label, k.faint, Modifier.padding(start = 12.dp, top = 8.dp))
                BasicText(b.text, style = T.code.copy(color = k.fg), softWrap = false,
                    modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp))
            }
            is Block.Table -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(S.r)).border(1.dp, k.line, RoundedCornerShape(S.r)).horizontalScroll(rememberScrollState())) {
                val widths = (0 until (b.rows.maxOfOrNull { it.size } ?: 0)).map { c -> (b.rows.maxOfOrNull { it.getOrNull(c)?.length ?: 0 } ?: 0).coerceIn(4, 28) }
                b.rows.forEachIndexed { r, row ->
                    Row(Modifier.background(if (r == 0) k.sunken else k.raised).padding(horizontal = 4.dp)) {
                        row.forEachIndexed { c, cell ->
                            BasicText(inline(cell, code, link), style = T.small.copy(color = k.fg, fontWeight = if (r == 0) FontWeight(600) else FontWeight(400)),
                                modifier = Modifier.width((widths.getOrElse(c) { 8 } * 8 + 16).dp).padding(horizontal = 8.dp, vertical = 6.dp))
                        }
                    }
                }
            }
        }
    }
}
