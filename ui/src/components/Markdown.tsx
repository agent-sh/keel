import { Marked } from "marked";
import { memo, useEffect, useMemo, useRef } from "react";
import { reportError } from "../lib/store.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

// Raw HTML in model output is shown as text, never rendered: the renderer
// escapes every html token, so the output needs no sanitizer.
const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    html({ text }) {
      return esc(text);
    },
    link({ href, title, tokens }) {
      const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
      const t = title ? ` title="${esc(title)}"` : "";
      return `<a href="${safe.replace(/"/g, "%22")}"${t} target="_blank" rel="noreferrer">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, text }) {
      // Remote images are not fetched: a link stands in for them. An image file
      // of the session's folder is shown from it (the page fills in the address).
      if (/^https?:/i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text || href)}</a>`;
      const p = href.replace(/^file:\/\//, "");
      return /\.(png|jpe?g|gif|webp)$/i.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p) ? `<img data-local="${esc(p)}" alt="${esc(text)}" class="max-w-full rounded-md border border-line">` : esc(text);
    },
    code({ text, lang }) {
      const l = (lang ?? "").trim().split(/\s/)[0] ?? "";
      return `<div class="code-block"><div class="code-head"><span>${esc(l || "text")}</span><button type="button" class="code-copy" aria-label="Copy code">${COPY_ICON}<span>Copy</span></button></div><pre><code data-lang="${esc(l)}">${esc(text)}</code></pre></div>`;
    },
  },
});

let hl: Promise<typeof import("../lib/highlight.ts")> | null = null;
const loadHl = () => (hl ??= import("../lib/highlight.ts"));

export const Markdown = memo(function Markdown({ text, live, sessionId }: { text: string; live?: boolean; sessionId?: string }) {
  const html = useMemo(() => md.parse(text, { async: false }) as string, [text]);
  const ref = useRef<HTMLDivElement>(null);

  // Images of the session's folder: served raw by the daemon; without a
  // session, or when the file is not there, the alt text stands.
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLImageElement>("img[data-local]:not([src])").forEach((img) => {
      const alt = () => img.replaceWith(document.createTextNode(img.alt));
      if (!sessionId) return alt();
      img.onerror = alt;
      img.src = `/api/sessions/${sessionId}/file?raw=1&path=${encodeURIComponent(img.dataset.local!)}`;
    });
  }, [html, sessionId]);

  // Highlight once the text stops changing (a streaming reply is highlighted when it ends).
  useEffect(() => {
    if (live) return;
    const codes = ref.current?.querySelectorAll<HTMLElement>("code[data-lang]:not([data-hl])");
    if (!codes?.length) return;
    let cancelled = false;
    loadHl()
      .then(({ highlightHtml }) => {
        if (cancelled) return;
        codes.forEach((c) => {
          c.dataset.hl = "1";
          const lang = c.dataset.lang;
          if (!lang) return;
          const out = highlightHtml(c.textContent ?? "", lang);
          if (out) c.innerHTML = out;
        });
      })
      .catch((e) => reportError(e, { kind: "highlight" }));
    return () => { cancelled = true; };
  }, [html, live]);

  return (
    <div
      ref={ref}
      className="prose-keel"
      data-live={live || undefined}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
        if (!btn) return;
        const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
        navigator.clipboard.writeText(code).then(() => {
          btn.dataset.copied = "";
          btn.lastElementChild!.textContent = "Copied";
          setTimeout(() => { delete btn.dataset.copied; btn.lastElementChild!.textContent = "Copy"; }, 1400);
        }, (err) => reportError(err, { kind: "clipboard" }));
      }}
    />
  );
});
