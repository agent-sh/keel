// TeX in replies: $$...$$ and \[...\] as display math, \(...\) and $...$ inline.
// An inline $ follows Pandoc's rule, so prices and shell variables stay text:
// the opening $ has a non-space after it, the closing one a non-space before
// it and no digit after it. The page turns each into MathML (lib/math.ts).
import type { TokenizerAndRendererExtension } from "marked";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const mathHtml = (tex: string, display: boolean) =>
  `<${display ? "div" : "span"} class="math" data-tex="${esc(tex)}"${display ? " data-display" : ""}>${esc(tex)}</${display ? "div" : "span"}>`;

// The inline math at the start of `src`, if any: [raw, tex, display].
export function inlineMath(src: string): [string, string, boolean] | undefined {
  let m = /^\$\$(?!\$)([^\n]+?)\$\$/.exec(src);
  if (m) return [m[0], m[1]!.trim(), true];
  m = /^\\\(([^\n]+?)\\\)/.exec(src);
  if (m) return [m[0], m[1]!.trim(), false];
  m = /^\$(?![\s$])((?:\\.|[^\\\n$])*?[^\s\\])\$(?!\d)/.exec(src);
  if (m) return [m[0], m[1]!, false];
  m = /^\$([^\s$\\])\$(?!\d)/.exec(src);
  if (m) return [m[0], m[1]!, false];
  return undefined;
}

export const mathExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "mathBlock",
    level: "block",
    start: (src) => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
    tokenizer(src) {
      const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]) *(?:\n+|$)/.exec(src);
      if (m) return { type: "mathBlock", raw: m[0], text: (m[1] ?? m[2])!.trim() };
    },
    renderer: (t) => mathHtml(t.text, true),
  },
  {
    name: "mathInline",
    level: "inline",
    start: (src) => { const i = src.search(/\$|\\\(/); return i < 0 ? undefined : i; },
    tokenizer(src) {
      const m = inlineMath(src);
      if (m) return { type: "mathInline", raw: m[0], text: m[1], display: m[2] };
    },
    renderer: (t) => mathHtml(t.text, t.display),
  },
];
