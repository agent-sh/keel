// Loaded on first use (a dynamic import), so the highlighter and its
// languages are not part of the first page load.
import { highlight } from "@tanstack/highlight";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlightHtml(code: string, lang: string): string | null {
  try {
    const r = highlight(code, { lang: lang.toLowerCase() });
    if (r.lang === "plaintext") return null;
    return r.tokens.map((t) => (t.className ? `<span class="th-${t.className}">${esc(t.value)}</span>` : esc(t.value))).join("");
  } catch {
    return null;
  }
}
