import { announce } from "../lib/announce.ts";
import { COPY_FAILED, copyText } from "../lib/copy.ts";
import { Marked, type Token } from "marked";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { mathExtensions, mathHtml } from "../lib/mdmath.ts";
import { finishedLength, mend } from "../lib/mdstream.ts";
import { pathRef } from "../lib/paths.ts";
import { api, reportError } from "../lib/store.ts";
import { getUI, navigate, savePref, setUI } from "../lib/ui.ts";
import { whenIdle } from "../lib/utils.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const svg = (paths: string) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const FAILED_ICON = svg(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`);
// What a code block's copy button shows, and the time limit of its Copied or failed state.
const copyFace = (icon: string, words: string) => `${icon}<span>${words}</span>`;
const copyTimers = new WeakMap<HTMLElement, number>();
const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

// Raw HTML in model output is shown as text, never rendered: the renderer
// escapes every html token, so the output needs no sanitizer.
const md = new Marked({ gfm: true, breaks: false });
md.use({ extensions: mathExtensions });
md.use({
  renderer: {
    codespan({ text }) {
      // A file the reply names: linked once the daemon says it is in the session's folder.
      const ref = pathRef(text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      if (!ref) return `<code>${text}</code>`;
      return `<code class="k-fileref" data-path="${esc(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ""}${ref.end ? ` data-end="${ref.end}"` : ""}>${text}</code>`;
    },
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
      return /\.(png|jpe?g|gif|webp)$/i.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p) ? `<img data-local="${esc(p)}" alt="${esc(text)}" class="h-auto max-w-full rounded-md border border-line">` : esc(text);
    },
    code({ text, lang }) {
      // A fence with nothing in it yet (a reply streaming its opener, or an empty block) is no block.
      if (!text) return "";
      const l = (lang ?? "").trim().split(/\s/)[0] ?? "";
      if (l === "math") return mathHtml(text, true);
      return `<div class="code-block"><div class="code-head"><span class="code-lang" title="${esc(l || "text")}">${esc(l || "text")}</span><button type="button" class="code-copy" aria-label="Copy code">${copyFace(COPY_ICON, "Copy")}</button></div><pre><code data-lang="${esc(l)}">${esc(text)}</code></pre></div>`;
    },
  },
});

let hl: Promise<typeof import("../lib/highlight.ts")> | null = null;
const loadHl = () => (hl ??= import("../lib/highlight.ts"));

// Colors the code blocks under `root` that are not colored yet.
function highlightIn(root: Element) {
  const codes = root.querySelectorAll<HTMLElement>("code[data-lang]:not([data-hl])");
  if (!codes.length) return;
  loadHl()
    .then(({ highlightHtml }) => {
      codes.forEach((c) => {
        if (c.dataset.hl || !c.isConnected) return;
        c.dataset.hl = "1";
        const lang = c.dataset.lang;
        if (!lang) return;
        const out = highlightHtml(c.textContent ?? "", lang);
        if (out) c.innerHTML = out;
      });
    })
    .catch((e) => reportError(e, { kind: "highlight" }));
}

// TeX becomes MathML (lib/math.ts, loaded the first time a reply has math).
let mm: Promise<typeof import("../lib/math.ts")> | null = null;
function mathIn(root: Element) {
  const list = root.querySelectorAll<HTMLElement>(".math:not([data-done])");
  if (!list.length) return;
  (mm ??= import("../lib/math.ts"))
    .then(({ mathMl }) => list.forEach((el) => {
      if (el.dataset.done || !el.isConnected) return;
      el.dataset.done = "1";
      el.innerHTML = mathMl(el.dataset.tex ?? "", el.hasAttribute("data-display"));
    }))
    .catch((e) => reportError(e, { kind: "math" }));
}

// Paths in inline code are asked about in one request per session and burst;
// the answers are kept for the page's life (a file named once is named again).
// A lookup that failed is no answer: it is asked again, later each time,
// while any of its paths is still on the page.
const known = new Map<string, Map<string, string | null>>();
const asking = new Map<string, Set<HTMLElement>>();
const RETRY_MS = 2000;
const RETRY_MAX_MS = 60_000;
function markPath(el: HTMLElement, have: Map<string, string | null>) {
  const rel = have.get(el.dataset.path!);
  if (rel === undefined) return false;
  el.dataset.checked = "1";
  if (rel !== null) {
    el.dataset.rel = rel;
    el.setAttribute("role", "link");
    el.tabIndex = 0;
    el.title = `Open ${rel}${el.dataset.line ? ` at line ${el.dataset.line}` : ""} in Files`;
  }
  return true;
}
function askPaths(sessionId: string, els: Set<HTMLElement>, wait: number, failures = 0) {
  const have = known.get(sessionId) ?? known.set(sessionId, new Map()).get(sessionId)!;
  asking.set(sessionId, els);
  setTimeout(() => {
    // What joined the batch while it waited is asked with it; what left the page is dropped.
    const batch = [...els].filter((el) => el.isConnected && !markPath(el, have));
    const paths = [...new Set(batch.map((el) => el.dataset.path!))];
    if (!paths.length) return void asking.delete(sessionId);
    api<{ files: Record<string, string> }>(`/api/sessions/${sessionId}/files/exist`, { method: "POST", body: JSON.stringify({ paths }) }).then(
      (r) => {
        for (const p of paths) have.set(p, r.files[p] ?? null);
        // A path that joined while the request was out is asked next.
        const rest = new Set([...els].filter((el) => el.isConnected && !markPath(el, have)));
        if (rest.size) askPaths(sessionId, rest, 30);
        else asking.delete(sessionId);
      },
      (e) => {
        // The session is gone: nothing of it links.
        if ((e as { status?: number }).status === 404) {
          for (const p of paths) have.set(p, null);
          els.forEach((el) => markPath(el, have));
          return void asking.delete(sessionId);
        }
        reportError(e, { kind: "file-links" });
        askPaths(sessionId, els, Math.min(RETRY_MS * 2 ** failures, RETRY_MAX_MS), failures + 1);
      },
    );
  }, wait);
}
function pathsIn(root: Element, sessionId?: string) {
  if (!sessionId) return;
  const els = [...root.querySelectorAll<HTMLElement>("code.k-fileref:not([data-checked])")];
  if (!els.length) return;
  const have = known.get(sessionId) ?? known.set(sessionId, new Map()).get(sessionId)!;
  const fresh = els.filter((el) => !markPath(el, have));
  if (!fresh.length) return;
  const wait = asking.get(sessionId);
  if (wait) fresh.forEach((el) => wait.add(el));
  else askPaths(sessionId, new Set(fresh), 30);
}

const enhance = (root: Element, sessionId?: string) => { highlightIn(root); mathIn(root); pathsIn(root, sessionId); };

// Opens a linked file in the session's Files panel, at its lines.
function openLinked(el: HTMLElement, sessionId: string) {
  const r = getUI().route;
  if (r.name !== "session" || r.id !== sessionId) navigate({ name: "session", id: sessionId });
  setUI({ fileAt: { session: sessionId, path: el.dataset.rel!, line: el.dataset.line ? Number(el.dataset.line) : undefined, end: el.dataset.end ? Number(el.dataset.end) : undefined, n: Date.now() } });
  savePref("panel", "files");
}

// Code is colored when it comes near the view, not when the reply mounts: a
// long session opens without coloring (and holding the spans of) every block
// it ever showed.
// Math and file links wait for the view the same way.
let seen: IntersectionObserver | null = null;
const sessionOf = new WeakMap<Element, string | undefined>();
const watch = (el: Element, sessionId?: string) => {
  seen ??= new IntersectionObserver((list) => {
    // In idle time, so coloring what scrolls in never takes a frame of the scroll itself.
    for (const x of list) if (x.isIntersecting) { seen!.unobserve(x.target); const t = x.target; whenIdle(() => enhance(t, sessionOf.get(t)), 400); }
  }, { rootMargin: "800px 0px" });
  sessionOf.set(el, sessionId);
  seen.observe(el);
  return () => seen!.unobserve(el);
};

function localImages(root: Element, sessionId?: string) {
  // Images of the session's folder: served raw by the daemon; without a
  // session, or when the file is not there, the alt text stands.
  root.querySelectorAll<HTMLImageElement>("img[data-local]:not([src])").forEach((img) => {
    const alt = () => img.replaceWith(document.createTextNode(img.alt));
    if (!sessionId) return alt();
    img.onerror = alt;
    const src = `/api/sessions/${sessionId}/file?raw=1&path=${encodeURIComponent(img.dataset.local!)}`;
    // A picture that was drawn before stands in its own box from the first layout: the row that takes a
    // streamed reply's place draws its pictures again, and without their size it would stand lower
    // until they are decoded, and every line under it would move.
    const size = imageSizes.get(src);
    if (size) { img.width = size.w; img.height = size.h; }
    img.onload = () => { if (img.naturalWidth) { if (imageSizes.size > 400) imageSizes.clear(); imageSizes.set(src, { w: img.naturalWidth, h: img.naturalHeight }); } };
    img.src = src;
  });
}
// The size of each picture drawn so far, by its address.
const imageSizes = new Map<string, { w: number; h: number }>();

const onClick = (sessionId?: string) => (e: React.MouseEvent | React.KeyboardEvent) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>("code.k-fileref[data-rel]");
  if (link && sessionId) {
    if ("key" in e && e.key !== "Enter") return;
    e.preventDefault();
    return openLinked(link, sessionId);
  }
  if ("key" in e) return;
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
  if (!btn) return;
  const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
  // Copied or failed, the button says which for a moment: its words, its
  // name and, failed, its glyph. A second press starts the moment again.
  const face = (mark: "copied" | "failed" | null, words: string) => {
    delete btn.dataset.copied;
    delete btn.dataset.failed;
    if (mark) btn.dataset[mark] = "";
    btn.setAttribute("aria-label", mark ? words : "Copy code");
    btn.innerHTML = copyFace(mark === "failed" ? FAILED_ICON : COPY_ICON, words);
  };
  const say = (mark: "copied" | "failed", words: string, ms: number) => {
    clearTimeout(copyTimers.get(btn));
    face(mark, words);
    copyTimers.set(btn, window.setTimeout(() => face(null, "Copy"), ms));
  };
  copyText(code).then(
    () => { say("copied", "Copied", 1400); announce("Copied"); },
    (err) => { say("failed", COPY_FAILED, 2600); announce(`${COPY_FAILED}: the browser refused the clipboard.`, "alert"); reportError(err, { kind: "clipboard" }); },
  );
};

// A reply being written. Only its unfinished last block is lexed and rendered
// again per delta; finished blocks are added once, stay in the page as they
// are, and their code is colored right away. A text that is not the previous
// one plus more starts over.
function LiveMarkdown({ text, sessionId }: { text: string; sessionId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({ src: "", done: 0, nodes: 0 });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const s = st.current;
    if (!text.startsWith(s.src.slice(0, s.done))) { root.textContent = ""; s.done = 0; s.nodes = 0; }
    s.src = text;
    const tokens = md.lexer(text.slice(s.done));
    const { done, count } = finishedLength(tokens);
    while (root.childNodes.length > s.nodes) root.lastChild!.remove();
    if (count > 0) {
      root.insertAdjacentHTML("beforeend", md.parser(Object.assign(tokens.slice(0, count), { links: tokens.links }) as Token[] as any));
      s.done += done;
      s.nodes = root.childNodes.length;
      enhance(root, sessionId);
      localImages(root, sessionId);
    }
    const rest = text.slice(s.done);
    if (rest.trim()) root.insertAdjacentHTML("beforeend", md.parse(mend(rest.replace(/\s+$/, "")), { async: false }) as string);
  }, [text, sessionId]);
  const click = onClick(sessionId);
  return <div ref={ref} className="prose-keel" data-live aria-busy="true" onClick={click} onKeyDown={click} />;
}

export const Markdown = memo(function Markdown({ text, live, sessionId }: { text: string; live?: boolean; sessionId?: string }) {
  if (live) return <LiveMarkdown text={text} sessionId={sessionId} />;
  return <StoredMarkdown text={text} sessionId={sessionId} />;
});

function StoredMarkdown({ text, sessionId }: { text: string; sessionId?: string }) {
  const html = useMemo(() => md.parse(text, { async: false }) as string, [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) localImages(ref.current, sessionId); }, [html, sessionId]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !el.querySelector("code[data-lang]:not([data-hl]), .math:not([data-done]), code.k-fileref:not([data-checked])")) return;
    return watch(el, sessionId);
  }, [html, sessionId]);
  const click = onClick(sessionId);
  return <div ref={ref} className="prose-keel" dangerouslySetInnerHTML={{ __html: html }} onClick={click} onKeyDown={click} />;
}
