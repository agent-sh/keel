// TeX in replies, as the workbench reads it (ui/src/lib/mdmath.ts): $$...$$ and \[...\] as display
// math, \(...\) and $...$ inline, an inline $ by Pandoc's rule so prices and shell variables stay
// text. The page draws it as MathML; the phone sets it as text: letters in math italic, operators
// spaced, scripts raised and lowered, symbols as their Unicode characters, a fraction as a/b, a root
// as √x, and the rows of an aligned or cases block one under the other. No library and no web view.
package dev.avifenesh.keel.ui

/** One run of math text: its letters, whether they are italic or bold, and how many script levels up (or down) it sits. */
data class MathRun(val text: String, val italic: Boolean = false, val bold: Boolean = false, val level: Int = 0)

/** The math at the start of `s`, as the page finds it: the raw text it covers, its TeX, and whether it is display math. */
fun inlineMath(s: String, at: Int): Triple<Int, String, Boolean>? {
    val src = s.substring(at)
    Regex("^\\$\\$(?!\\$)([^\\n]+?)\\$\\$").find(src)?.let { return Triple(it.value.length, it.groupValues[1].trim(), true) }
    Regex("^\\\\\\(([^\\n]+?)\\\\\\)").find(src)?.let { return Triple(it.value.length, it.groupValues[1].trim(), false) }
    Regex("^\\$(?![\\s$])((?:\\\\.|[^\\\\\\n$])*?[^\\s\\\\])\\$(?!\\d)").find(src)?.let { return Triple(it.value.length, it.groupValues[1], false) }
    Regex("^\\$([^\\s$\\\\])\\$(?!\\d)").find(src)?.let { return Triple(it.value.length, it.groupValues[1], false) }
    return null
}

private sealed class Node {
    data class Atom(val text: String, val kind: Kind) : Node()
    data class Seq(val items: List<Node>) : Node()
    data class Script(val base: Node, val sup: Node?, val sub: Node?) : Node()
    data class Frac(val num: Node, val den: Node) : Node()
    data class Root(val index: Node?, val body: Node) : Node()
    data class Style(val body: Node, val italic: Boolean?, val bold: Boolean, val map: ((Char) -> String)?, val mark: Char?) : Node()
    data class Rows(val rows: List<List<Node>>, val open: String, val close: String) : Node()
}

private enum class Kind { ORD, LETTER, OP, REL, OPEN, CLOSE, PUNCT, FUN, SPACE }

private val GREEK = mapOf(
    "alpha" to "α", "beta" to "β", "gamma" to "γ", "delta" to "δ", "epsilon" to "ϵ", "varepsilon" to "ε", "zeta" to "ζ", "eta" to "η",
    "theta" to "θ", "vartheta" to "ϑ", "iota" to "ι", "kappa" to "κ", "lambda" to "λ", "mu" to "μ", "nu" to "ν", "xi" to "ξ", "pi" to "π",
    "varpi" to "ϖ", "rho" to "ρ", "varrho" to "ϱ", "sigma" to "σ", "varsigma" to "ς", "tau" to "τ", "upsilon" to "υ", "phi" to "ϕ",
    "varphi" to "φ", "chi" to "χ", "psi" to "ψ", "omega" to "ω", "Gamma" to "Γ", "Delta" to "Δ", "Theta" to "Θ", "Lambda" to "Λ",
    "Xi" to "Ξ", "Pi" to "Π", "Sigma" to "Σ", "Upsilon" to "Υ", "Phi" to "Φ", "Psi" to "Ψ", "Omega" to "Ω",
)
private val REL = mapOf(
    "le" to "≤", "leq" to "≤", "ge" to "≥", "geq" to "≥", "ne" to "≠", "neq" to "≠", "approx" to "≈", "sim" to "∼", "simeq" to "≃",
    "cong" to "≅", "equiv" to "≡", "propto" to "∝", "ll" to "≪", "gg" to "≫", "in" to "∈", "notin" to "∉", "ni" to "∋",
    "subset" to "⊂", "subseteq" to "⊆", "supset" to "⊃", "supseteq" to "⊇", "to" to "→", "rightarrow" to "→", "leftarrow" to "←",
    "gets" to "←", "leftrightarrow" to "↔", "Rightarrow" to "⇒", "Leftarrow" to "⇐", "Leftrightarrow" to "⇔", "implies" to "⟹",
    "iff" to "⟺", "mapsto" to "↦", "longrightarrow" to "⟶", "longmapsto" to "⟼", "mid" to "∣", "parallel" to "∥", "perp" to "⊥",
    "vdash" to "⊢", "models" to "⊨", "prec" to "≺", "succ" to "≻", "preceq" to "⪯", "succeq" to "⪰", "coloneqq" to "≔", "doteq" to "≐",
    "uparrow" to "↑", "downarrow" to "↓",
)
private val OP = mapOf(
    "times" to "×", "cdot" to "⋅", "div" to "÷", "pm" to "±", "mp" to "∓", "ast" to "∗", "star" to "⋆", "circ" to "∘", "bullet" to "∙",
    "cup" to "∪", "cap" to "∩", "setminus" to "∖", "wedge" to "∧", "land" to "∧", "vee" to "∨", "lor" to "∨", "oplus" to "⊕",
    "otimes" to "⊗", "odot" to "⊙",
)
private val ORD = mapOf(
    "infty" to "∞", "partial" to "∂", "nabla" to "∇", "forall" to "∀", "exists" to "∃", "nexists" to "∄", "emptyset" to "∅",
    "varnothing" to "∅", "neg" to "¬", "lnot" to "¬", "ell" to "ℓ", "hbar" to "ℏ", "Re" to "ℜ", "Im" to "ℑ", "aleph" to "ℵ",
    "angle" to "∠", "triangle" to "△", "prime" to "′", "cdots" to "⋯", "ldots" to "…", "dots" to "…", "vdots" to "⋮", "ddots" to "⋱",
    "sum" to "∑", "prod" to "∏", "coprod" to "∐", "int" to "∫", "iint" to "∬", "iiint" to "∭", "oint" to "∮", "bigcup" to "⋃",
    "bigcap" to "⋂", "bigoplus" to "⨁", "bigotimes" to "⨂", "top" to "⊤", "bot" to "⊥", "degree" to "°", "checkmark" to "✓",
    "square" to "□", "Box" to "□", "dagger" to "†", "S" to "§", "P" to "¶", "%" to "%", "$" to "$", "&" to "&", "#" to "#", "_" to "_",
)
private val OPEN = mapOf("{" to "{", "langle" to "⟨", "lfloor" to "⌊", "lceil" to "⌈", "lvert" to "|", "lVert" to "‖", "|" to "‖")
private val CLOSE = mapOf("}" to "}", "rangle" to "⟩", "rfloor" to "⌋", "rceil" to "⌉", "rvert" to "|", "rVert" to "‖")
private val FUN = setOf(
    "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp",
    "lim", "liminf", "limsup", "max", "min", "sup", "inf", "arg", "argmax", "argmin", "det", "dim", "ker", "deg", "gcd", "lcm",
    "Pr", "hom", "mod", "bmod",
)
private val SPACE = mapOf("," to "\u2009", ":" to "\u2005", ">" to "\u2005", ";" to "\u2004", "!" to "", " " to " ", "quad" to "\u2003", "qquad" to "\u2003\u2003", "enspace" to "\u2002", "thinspace" to "\u2009")
// Accents: the combining mark set after each letter.
private val ACCENT = mapOf("hat" to '\u0302', "widehat" to '\u0302', "bar" to '\u0304', "overline" to '\u0305', "tilde" to '\u0303', "widetilde" to '\u0303', "vec" to '\u20D7', "dot" to '\u0307', "ddot" to '\u0308', "acute" to '\u0301', "grave" to '\u0300', "breve" to '\u0306', "check" to '\u030C', "underline" to '\u0332')
// Commands that only size or space what follows, and take nothing.
private val IGNORED = setOf("left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "middle", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "nonumber", "notag", "label", "tag")

private fun alpha(c: Char, upper: Int, lower: Int, digits: Int = 0, holes: Map<Char, String> = emptyMap()): String = holes[c] ?: when (c) {
    in 'A'..'Z' -> String(Character.toChars(upper + (c - 'A')))
    in 'a'..'z' -> if (lower == 0) c.toString() else String(Character.toChars(lower + (c - 'a')))
    in '0'..'9' -> if (digits == 0) c.toString() else String(Character.toChars(digits + (c - '0')))
    else -> c.toString()
}
private val BB: (Char) -> String = { alpha(it, 0x1D538, 0x1D552, 0x1D7D8, mapOf('C' to "ℂ", 'H' to "ℍ", 'N' to "ℕ", 'P' to "ℙ", 'Q' to "ℚ", 'R' to "ℝ", 'Z' to "ℤ")) }
private val CAL: (Char) -> String = { alpha(it, 0x1D49C, 0, holes = mapOf('B' to "ℬ", 'E' to "ℰ", 'F' to "ℱ", 'H' to "ℋ", 'I' to "ℐ", 'L' to "ℒ", 'M' to "ℳ", 'R' to "ℛ")) }
private val FRAK: (Char) -> String = { alpha(it, 0x1D504, 0x1D51E, holes = mapOf('C' to "ℭ", 'H' to "ℌ", 'I' to "ℑ", 'R' to "ℜ", 'Z' to "ℨ")) }

private class Parser(val s: String) {
    var i = 0

    fun all(): Node = one(seq(stop = null))

    private fun one(items: List<Node>) = if (items.size == 1) items[0] else Node.Seq(items)

    // A run of items up to a closing brace, `\end`, `&` or `\\` (the last two only inside rows), or the end.
    fun seq(stop: Char?, rows: Boolean = false): List<Node> {
        val out = mutableListOf<Node>()
        while (i < s.length) {
            val c = s[i]
            if (c == '}' && stop == '}') { i++; return out }
            if (rows && (c == '&' || s.startsWith("\\\\", i) || s.startsWith("\\end", i))) return out
            if (c == '}') { i++; continue }
            val n = atom() ?: continue
            out += scripts(n)
        }
        return out
    }

    private fun scripts(base: Node): Node {
        var sup: Node? = null; var sub: Node? = null
        while (i < s.length) {
            skipSpace()
            if (i >= s.length) break
            when (s[i]) {
                '^' -> { i++; sup = arg() }
                '_' -> { i++; sub = arg() }
                '\'' -> { var p = ""; while (i < s.length && s[i] == '\'') { p += "′"; i++ }; return scripts(Node.Seq(listOf(base, Node.Atom(p, Kind.ORD)))) }
                else -> break
            }
        }
        return if (sup == null && sub == null) base else Node.Script(base, sup, sub)
    }

    private fun skipSpace() { while (i < s.length && s[i].isWhitespace()) i++ }

    // One argument: a group in braces, a command, or one character.
    fun arg(): Node {
        skipSpace()
        if (i >= s.length) return Node.Seq(emptyList())
        if (s[i] == '{') { i++; return one(seq('}')) }
        return atom() ?: Node.Seq(emptyList())
    }

    // A group's raw text, for \text and \begin's name.
    private fun raw(): String {
        skipSpace()
        if (i >= s.length || s[i] != '{') return if (i < s.length) s[i++].toString() else ""
        var depth = 0; val st = ++i
        while (i < s.length) { if (s[i] == '{') depth++; if (s[i] == '}') { if (depth == 0) break; depth-- }; i++ }
        return s.substring(st, i).also { if (i < s.length) i++ }
    }

    private fun optional(): Node? {
        skipSpace()
        if (i >= s.length || s[i] != '[') return null
        val end = s.indexOf(']', i)
        if (end < 0) return null
        val inner = s.substring(i + 1, end); i = end + 1
        return Parser(inner).all()
    }

    fun atom(): Node? {
        val c = s[i]
        when {
            c.isWhitespace() -> { i++; return null }
            c == '{' -> { i++; return one(seq('}')) }
            c == '\\' -> return command()
            c == '&' -> { i++; return Node.Atom(" ", Kind.SPACE) }
            c == '~' -> { i++; return Node.Atom(" ", Kind.SPACE) }
            c.isLetter() -> { i++; return Node.Atom(c.toString(), if (c in 'a'..'z' || c in 'A'..'Z') Kind.LETTER else Kind.ORD) }
            c.isDigit() || c == '.' -> {
                val st = i
                while (i < s.length && (s[i].isDigit() || (s[i] == '.' && i + 1 < s.length && s[i + 1].isDigit()))) i++
                if (i == st) i++
                return Node.Atom(s.substring(st, i), Kind.ORD)
            }
            else -> {
                i++
                return when (c) {
                    '+' -> Node.Atom("+", Kind.OP); '-' -> Node.Atom("−", Kind.OP); '*' -> Node.Atom("∗", Kind.OP); '/' -> Node.Atom("/", Kind.ORD)
                    '=', '<', '>' -> Node.Atom(c.toString(), Kind.REL)
                    ':' -> Node.Atom(":", Kind.REL)
                    '(', '[' -> Node.Atom(c.toString(), Kind.OPEN); ')', ']' -> Node.Atom(c.toString(), Kind.CLOSE)
                    ',', ';' -> Node.Atom(c.toString(), Kind.PUNCT)
                    '|' -> Node.Atom("|", Kind.ORD)
                    '^', '_' -> Node.Atom(c.toString(), Kind.ORD)
                    else -> Node.Atom(c.toString(), Kind.ORD)
                }
            }
        }
    }

    private fun command(): Node? {
        i++ // the backslash
        if (i >= s.length) return Node.Atom("\\", Kind.ORD)
        val name = if (s[i].isLetter()) { val st = i; while (i < s.length && s[i].isLetter()) i++; s.substring(st, i) } else s[i++].toString()
        GREEK[name]?.let { return Node.Atom(it, if (name[0].isLowerCase()) Kind.LETTER else Kind.ORD) }
        REL[name]?.let { return Node.Atom(it, Kind.REL) }
        OP[name]?.let { return Node.Atom(it, Kind.OP) }
        OPEN[name]?.let { return Node.Atom(it, Kind.OPEN) }
        CLOSE[name]?.let { return Node.Atom(it, Kind.CLOSE) }
        ORD[name]?.let { return Node.Atom(it, Kind.ORD) }
        SPACE[name]?.let { return Node.Atom(it, Kind.SPACE) }
        if (name in FUN) return Node.Atom(if (name == "bmod") "mod" else name, Kind.FUN)
        if (name in IGNORED) {
            if (name == "label" || name == "tag") raw()
            // \left. and \right. stand for no delimiter.
            if ((name == "left" || name == "right" || name == "middle") && i < s.length && s[i] == '.') i++
            return null
        }
        ACCENT[name]?.let { return Node.Style(arg(), null, false, null, it) }
        return when (name) {
            "frac", "dfrac", "tfrac", "cfrac" -> Node.Frac(arg(), arg())
            "binom", "dbinom", "tbinom" -> { val n = arg(); val k = arg(); Node.Seq(listOf(Node.Atom("C", Kind.LETTER), Node.Atom("(", Kind.OPEN), n, Node.Atom(",", Kind.PUNCT), k, Node.Atom(")", Kind.CLOSE))) }
            "sqrt" -> { val idx = optional(); Node.Root(idx, arg()) }
            "text", "textrm", "textnormal", "mbox", "textup" -> Node.Atom(raw(), Kind.ORD)
            "textit", "emph" -> Node.Style(Node.Atom(raw(), Kind.ORD), true, false, null, null)
            "textbf" -> Node.Style(Node.Atom(raw(), Kind.ORD), false, true, null, null)
            "operatorname" -> Node.Atom(raw().replace("*", ""), Kind.FUN)
            "mathrm", "mathsf", "mathtt", "rm" -> Node.Style(arg(), false, false, null, null)
            "mathit" -> Node.Style(arg(), true, false, null, null)
            "mathbf", "boldsymbol", "bm", "bf" -> Node.Style(arg(), null, true, null, null)
            "mathbb" -> Node.Style(arg(), false, false, BB, null)
            "mathcal", "mathscr" -> Node.Style(arg(), false, false, CAL, null)
            "mathfrak" -> Node.Style(arg(), false, false, FRAK, null)
            "overset", "stackrel" -> { val over = arg(); Node.Script(arg(), over, null) }
            "underset" -> { val under = arg(); Node.Script(arg(), null, under) }
            "overbrace", "underbrace" -> arg()
            "pmod" -> Node.Seq(listOf(Node.Atom("(", Kind.OPEN), Node.Atom("mod", Kind.FUN), arg(), Node.Atom(")", Kind.CLOSE)))
            "not" -> Node.Style(arg(), null, false, null, '\u0338')
            "begin" -> rows(raw())
            "\\" -> Node.Atom("\n", Kind.SPACE)
            "{", "}" -> Node.Atom(name, if (name == "{") Kind.OPEN else Kind.CLOSE)
            else -> Node.Atom("\\$name", Kind.FUN)
        }
    }

    // An environment: its rows, split at \\, each row's cells split at &, up to its \end.
    private fun rows(env: String): Node {
        val name = env.removeSuffix("*")
        if (name == "array") raw() // the column spec
        val rows = mutableListOf<List<Node>>()
        var row = mutableListOf<Node>()
        while (i < s.length) {
            row += one(seq(null, rows = true))
            when {
                i >= s.length -> break
                s[i] == '&' -> i++
                s.startsWith("\\\\", i) -> { i += 2; optional(); rows += row; row = mutableListOf() }
                s.startsWith("\\end", i) -> { i += 4; raw(); break }
            }
        }
        if (row.any { !(it is Node.Seq && it.items.isEmpty()) }) rows += row
        val (open, close) = when (name) {
            "pmatrix" -> "(" to ")"; "bmatrix" -> "[" to "]"; "Bmatrix" -> "{" to "}"; "vmatrix" -> "|" to "|"; "Vmatrix" -> "‖" to "‖"
            "cases", "dcases" -> "{" to ""; "rcases" -> "" to "}"; else -> "" to ""
        }
        return Node.Rows(rows, open, close)
    }
}

/** TeX set as runs of text. Rows of an environment are separate lines ("\n"). */
fun mathRuns(tex: String): List<MathRun> {
    val out = mutableListOf<MathRun>()
    Writer(out).node(Parser(tex).all(), Ctx())
    return merge(out)
}

/** The same, as plain text (what a test or a copy reads). */
fun mathText(tex: String): String = mathRuns(tex).joinToString("") { it.text }

private data class Ctx(val level: Int = 0, val italic: Boolean? = null, val bold: Boolean = false, val map: ((Char) -> String)? = null, val mark: Char? = null)

private class Writer(val out: MutableList<MathRun>) {
    // The kind of the last thing written at the current level: a minus after nothing or after an
    // operator is a sign, and takes no spaces.
    var last: Kind? = null

    fun put(text: String, kind: Kind, c: Ctx) {
        if (text.isEmpty()) return
        var t = text
        c.map?.let { m -> t = t.map { m(it) }.joinToString("") }
        c.mark?.let { m -> t = t.flatMap { if (it.isWhitespace()) listOf(it) else listOf(it, m) }.joinToString("") }
        val italic = c.italic ?: (kind == Kind.LETTER)
        val spaced = c.level == 0
        when (kind) {
            Kind.REL -> t = if (spaced) " $t " else t
            Kind.OP -> t = if (spaced && last != null && last != Kind.OP && last != Kind.REL && last != Kind.OPEN && last != Kind.PUNCT) " $t " else t
            Kind.PUNCT -> t = if (spaced) "$t " else t
            Kind.FUN -> if (last == Kind.LETTER || last == Kind.ORD || last == Kind.CLOSE) t = "\u2009$t"
            else -> {}
        }
        // A word after a function name is set apart from it (sin x, log n).
        if (last == Kind.FUN && (kind == Kind.LETTER || kind == Kind.ORD)) out += MathRun("\u2009", level = c.level)
        out += MathRun(t, italic, c.bold, c.level)
        if (kind != Kind.SPACE) last = kind
    }

    fun node(n: Node, c: Ctx) {
        when (n) {
            is Node.Atom -> put(n.text, n.kind, c)
            is Node.Seq -> n.items.forEach { node(it, c) }
            is Node.Script -> {
                node(n.base, c)
                val keep = last
                last = null
                n.sub?.let { node(it, c.copy(level = c.level - 1)) }
                n.sup?.let { node(it, c.copy(level = c.level + 1)) }
                last = keep ?: Kind.ORD
            }
            is Node.Frac -> {
                group(n.num, c); put("/", Kind.ORD, c); group(n.den, c)
                last = Kind.ORD
            }
            is Node.Root -> {
                n.index?.let { node(it, c.copy(level = c.level + 1)) }
                put("√", Kind.ORD, c.copy(italic = false)); group(n.body, c)
                last = Kind.ORD
            }
            is Node.Style -> node(n.body, c.copy(italic = n.italic ?: c.italic, bold = n.bold || c.bold, map = n.map ?: c.map, mark = n.mark ?: c.mark))
            is Node.Rows -> n.rows.forEachIndexed { r, row ->
                if (r > 0) out += MathRun("\n", level = c.level)
                last = null
                // A matrix's delimiters close every row; a cases block's brace opens the first.
                if (n.open == "{" && n.close.isEmpty() && r > 0) out += MathRun("\u2007", level = c.level)
                else put(n.open, Kind.OPEN, c.copy(italic = false))
                row.forEachIndexed { j, cell ->
                    if (j > 0) out += MathRun(if (n.open.isNotEmpty() || n.close.isNotEmpty()) "\u2003" else " ", level = c.level)
                    node(cell, c)
                }
                put(n.close, Kind.CLOSE, c.copy(italic = false))
            }
        }
    }

    // A side of a fraction or a root's body: in parentheses unless it is one piece (n, 2, x², αβ).
    private fun group(n: Node, c: Ctx) {
        if (simple(n)) node(n, c)
        else { put("(", Kind.OPEN, c.copy(italic = false)); last = null; node(n, c); put(")", Kind.CLOSE, c.copy(italic = false)) }
    }

    private fun simple(n: Node): Boolean = when (n) {
        is Node.Atom -> n.kind == Kind.ORD || n.kind == Kind.LETTER
        is Node.Seq -> n.items.size <= 1 && n.items.all(::simple) || n.items.all { it is Node.Atom && (it.kind == Kind.LETTER || (it.kind == Kind.ORD && it.text.all { ch -> ch.isLetterOrDigit() })) }
        is Node.Script -> simple(n.base)
        is Node.Style -> simple(n.body)
        else -> false
    }
}

// Runs that look the same are one run, and doubled spaces are one.
private fun merge(list: List<MathRun>): List<MathRun> {
    val out = mutableListOf<MathRun>()
    for (r in list) {
        val prev = out.lastOrNull()
        if (prev != null && prev.italic == r.italic && prev.bold == r.bold && prev.level == r.level) out[out.size - 1] = prev.copy(text = prev.text + r.text)
        else out += r
    }
    return out.map { it.copy(text = it.text.replace(Regex("  +"), " ")) }.let { l ->
        // No space at the start or the end of a line.
        val joined = l.toMutableList()
        if (joined.isNotEmpty()) { joined[0] = joined[0].copy(text = joined[0].text.trimStart(' ')); joined[joined.size - 1] = joined.last().copy(text = joined.last().text.trimEnd(' ')) }
        joined.map { it.copy(text = it.text.replace(" \n", "\n").replace("\n ", "\n")) }.filter { it.text.isNotEmpty() }
    }
}
