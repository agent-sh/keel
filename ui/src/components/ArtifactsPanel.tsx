// What a session made, in its side panel (and every session's of a project, on
// the project's page): the files it created or changed and the ones in its
// artifacts folder, newest first, with a preview of the picked one: an image,
// rendered markdown, a page in a sandbox that reaches nothing, highlighted
// code, and the diff of a changed file. Open in the editor, copy the path,
// download. The list follows the session while it works.
//
// The browser lays out by the room it is given, not the window: wide, the list
// stands beside the preview; narrow and tall, above it; with room for only
// one, the list and the preview take turns, and going back to the list finds
// it where it was, on the row that was picked.
import { ArrowLeft, Code2, Download, ExternalLink, FileText, Globe, Image as ImageIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Artifact } from "../../../src/server/routes/artifacts.ts";
import { copyOrSay } from "../lib/copy.ts";
import { api, onFeature, reportError, reportUnlessGone } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { DiffView, type FileChange } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";
import { PathText } from "./PathText.tsx";
import { Seg } from "./Seg.tsx";

export type Listed = Artifact & { session_title?: string };
const ICON = { image: ImageIcon, html: Globe, markdown: FileText, code: Code2 } as const;
const raw = (a: Listed, download = false) => `/api/sessions/${a.session_id}/artifacts/raw?path=${encodeURIComponent(a.path)}${download ? "&download=1" : ""}`;
const FILTERS = [["all", "All"], ["made", "Made"], ["changed", "Changed"], ["image", "Images"], ["doc", "Pages and docs"]] as const;
type Filter = (typeof FILTERS)[number][0];
const pass = (f: Filter, a: Listed) =>
  f === "all" || (f === "made" ? a.created : f === "changed" ? !a.created : f === "image" ? a.kind === "image" : a.kind === "html" || a.kind === "markdown");
const LANG: Record<string, string> = { py: "python", rs: "rust", yml: "yaml", sh: "shell", mjs: "js", cjs: "js", tsx: "tsx", jsx: "jsx" };
const langOf = (p: string) => { const e = p.split(".").pop()!.toLowerCase(); return LANG[e] ?? e; };
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
// Where it is, in short: its folder in the session's folder, the artifacts folder, or the path from home.
const where = (a: Listed) => (a.place === "artifacts" ? ["artifacts", dirOf(a.rel)].filter(Boolean).join("/") : a.place === "folder" ? dirOf(a.rel) : dirOf(a.path).replace(/^\/(home|Users)\/[^/]+/, "~"));
const button = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-caption text-muted hover:bg-hover hover:text-fg";

// The artifacts of a session or a project, kept current by "artifacts" frames
// and read again on a reconnect: one deleted while the page was cut off is a
// state, no failure.
export function useArtifacts(url: string, sessions: (id: string | undefined) => boolean) {
  const [list, setList] = useState<Listed[] | null>(null);
  const mine = useRef(sessions);
  mine.current = sessions;
  const load = useCallback(() => api<{ artifacts: Listed[] }>(url).then((r) => setList(r.artifacts), reportUnlessGone), [url]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if (f.name === "artifacts" && mine.current(f.session_id)) load(); }, reconnect: load });
  }, [load]);
  return list;
}

export function ArtifactsPanel({ session }: { session: Session }) {
  const list = useArtifacts(`/api/sessions/${session.id}/artifacts`, (id) => id === session.id);
  if (session.machine) return <p className="p-4 text-ui text-faint">This session works on another machine; its files are there.</p>;
  return <ArtifactBrowser list={list} testid="artifacts-panel" />;
}

// The layout the browser's own box holds, in rem so the text size counts:
// beside from 46rem of width (a session's side panel stops at 40rem, so it
// never flips to two cramped columns), else stacked from 36rem of height,
// else one at a time.
type Layout = "beside" | "stack" | "one";
function useLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>("stack");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const w = el.clientWidth / rem, h = el.clientHeight / rem;
      if (w && h) setLayout(w >= 46 ? "beside" : h >= 36 ? "stack" : "one");
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, layout] as const;
}

export function ArtifactBrowser({ list, testid, withSession }: { list: Listed[] | null; testid: string; withSession?: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [root, layout] = useLayout();
  // With room for one: which of the two is on screen, and where the list was left.
  const [reading, setReading] = useState(false);
  const rows = useRef<HTMLUListElement>(null);
  const left = useRef(0);
  const shown = (list ?? []).filter((a) => pass(filter, a));
  const key = (a: Listed) => `${a.session_id}\u0000${a.path}`;
  const cur = shown.find((a) => key(a) === picked) ?? (layout === "one" && !reading ? undefined : shown[0]);
  const one = layout === "one";
  const preview = !!cur && (!one || reading);
  const back = () => {
    setReading(false);
    // After the list is drawn again: its place, and the keyboard on the row that was open.
    requestAnimationFrame(() => {
      const ul = rows.current;
      if (!ul) return;
      ul.scrollTop = left.current;
      ul.querySelector<HTMLElement>("[aria-current]")?.focus({ preventScroll: true });
    });
  };
  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" data-testid={testid} data-layout={layout}>
      {/* The filters belong to the list: with room for one, they leave with it. */}
      <div className={cn("flex flex-wrap gap-1 border-b border-line px-3 py-2", one && reading && "hidden")} role="group" aria-label="Show">
        {FILTERS.map(([f, label]) => {
          const n = (list ?? []).filter((a) => pass(f, a)).length;
          return (
            <button key={f} type="button" aria-pressed={filter === f} data-testid={`artifacts-filter-${f}`} onClick={() => setFilter(f)}
              className={cn("h-6 rounded-xs px-2 text-caption", filter === f ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-hover hover:text-fg")}>
              {label} <span className="tabular-nums text-faint">{n}</span>
            </button>
          );
        })}
      </div>
      {list && !list.length && <p className="k-empty px-4 py-4" data-testid="artifacts-empty">Nothing made yet. Files this session writes, and what it puts in its artifacts folder, show up here as it works.</p>}
      {list && list.length > 0 && !shown.length && <p className="k-empty px-4 py-4">None of this kind yet.</p>}
      <div className={cn("flex min-h-0 flex-1", layout === "beside" ? "flex-row" : "flex-col")}>
        {shown.length > 0 && (
          <ul
            ref={rows}
            aria-label="Artifacts"
            data-testid="artifact-list"
            className={cn(
              "overflow-y-auto border-line py-1",
              layout === "beside" ? "w-[19rem] shrink-0 border-r" : layout === "stack" ? "max-h-[40%] shrink-0 border-b" : "min-h-0 flex-1",
              one && reading && "hidden",
            )}
          >
            {shown.map((a) => {
              const Icon = ICON[a.kind];
              return (
                <li key={key(a)}>
                  <button type="button" data-testid="artifact-row" data-path={a.path} data-kind={a.kind} aria-current={cur === a || undefined}
                    onClick={() => { setPicked(key(a)); if (one) { left.current = rows.current?.scrollTop ?? 0; setReading(true); } }}
                    className={cn("flex w-full items-center focus-visible:-outline-offset-2 gap-2.5 px-3 text-left text-ui hover:bg-hover", one ? "h-11" : "h-9", cur === a ? "k-picked" : "text-muted", !a.exists && "line-through opacity-60")}>
                    <Icon className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate"><span className="text-fg">{a.name}</span> <span className="text-caption text-faint">{[withSession && a.session_title, where(a)].filter(Boolean).join(" · ")}</span></span>
                    <span className={cn("rounded-xs px-1.5 text-micro", a.created ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted")}>{a.created ? "new" : "changed"}</span>
                    <span className="w-8 text-right text-caption tabular-nums text-faint" title={when(a.last_ts)}>{ago(a.last_ts)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {preview && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {one && (
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-sunken pl-1.5 pr-3">
                <button type="button" data-testid="artifacts-back" onClick={back} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui font-medium text-muted hover:bg-hover hover:text-fg">
                  <ArrowLeft className="size-4" />Artifacts <span className="font-normal tabular-nums text-faint">{shown.length}</span>
                </button>
                <span className="min-w-0 flex-1 truncate text-right text-ui font-medium" data-testid="artifact-name">{cur.name}</span>
              </div>
            )}
            <Preview key={`${key(cur)}\u0000${cur.last_ts}`} a={cur} />
          </div>
        )}
      </div>
    </div>
  );
}

function Preview({ a }: { a: Listed }) {
  const inFolder = a.place === "folder";
  const [view, setView] = useState<"show" | "source" | "diff">("show");
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ files: FileChange[]; diff: string; truncated: boolean } | null>(null);
  const [said, setSaid] = useState("");
  const needsText = a.kind === "markdown" || a.kind === "code" || view === "source";
  useEffect(() => {
    if (!needsText || text !== null || !a.exists) return;
    fetch(raw(a)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`)))).then(setText, reportError);
  }, [needsText]);
  useEffect(() => {
    if (text === null || !(a.kind === "code" || view === "source")) return;
    import("../lib/highlight.ts").then((m) => setHtml(m.highlightHtml(text.slice(0, 400_000), langOf(a.path)))).catch(reportError);
  }, [text, view]);
  useEffect(() => {
    if (view !== "diff" || diff) return;
    (async () => {
      const t = await api<{ turns: { turn: number; elsewhere?: string }[] }>(`/api/sessions/${a.session_id}/checkpoints`);
      const first = t.turns.find((x) => !x.elsewhere)?.turn;
      setDiff(first === undefined ? { files: [], diff: "", truncated: false } : await api(`/api/sessions/${a.session_id}/checkpoints/diff?from=${first}&path=${encodeURIComponent(a.rel)}`));
    })().catch(reportError);
  }, [view]);
  const views: ["show" | "source" | "diff", string][] = [["show", a.kind === "code" ? "Code" : "Preview"], ...(a.kind === "html" || a.kind === "markdown" ? [["source", "Source"]] as ["source", string][] : []), ...(inFolder ? [["diff", "Diff"]] as ["diff", string][] : [])];
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-preview" data-kind={a.kind}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2" data-testid="artifact-toolbar">
        <Seg kind="tabs" label="View" value={view} onChange={setView} options={views.map(([v, label]) => ({ value: v, label, testid: `artifact-view-${v}` }))} />
        <div className="ml-auto flex items-center gap-1.5">
        <button type="button" className={button} data-testid="artifact-open" title={said || "Open in your editor on this machine"} onClick={() => api(`/api/sessions/${a.session_id}/artifacts/open`, { method: "POST", body: JSON.stringify({ path: a.path }) }).then(() => setSaid("Opened"), (e) => setSaid((e as Error).message))}><ExternalLink className="size-3.5" />{said === "Opened" ? "Opened" : "Open"}</button>
        <button type="button" className={button} data-testid="artifact-copy-path" onClick={(e) => copyOrSay(a.path, e.currentTarget).then((ok) => { if (ok) setSaid("Path copied"); })}>{said === "Path copied" ? "Copied" : "Copy path"}</button>
        <a className={button} href={raw(a, true)} download={a.name} data-testid="artifact-download" aria-label="Download"><Download className="size-3.5" /></a>
        </div>
      </div>
      <p className="flex px-3 pb-2"><PathText path={a.path} className="font-mono text-micro text-faint" /></p>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line" data-testid="artifact-body">
        {!a.exists ? <p className="p-4 text-ui text-faint">The file is gone from disk.</p>
          : view === "diff" ? <div className="p-3">{diff ? <DiffView files={diff.files} patch={diff.diff} truncated={diff.truncated} empty="No change of this file is in the session's checkpoints." /> : <p className="text-caption text-faint">Loading…</p>}</div>
          : view === "show" && a.kind === "image" ? <div className="grid place-items-center p-4"><img src={raw(a)} alt={a.name} className="max-h-full max-w-full rounded-md border border-line bg-[repeating-conic-gradient(var(--color-sunken)_0_25%,transparent_0_50%)] bg-[length:1rem_1rem]" data-testid="artifact-image" /></div>
          : view === "show" && a.kind === "html" ? <iframe title={a.name} src={raw(a)} sandbox="allow-scripts" referrerPolicy="no-referrer" className="block h-full min-h-[12rem] w-full bg-white" data-testid="artifact-frame" />
          : view === "show" && a.kind === "markdown" ? <div className="px-5 py-4">{text === null ? null : <Markdown text={text} />}</div>
          : text === null ? <p className="p-4 text-caption text-faint">Loading…</p>
          : <pre className="p-3 font-mono text-caption leading-relaxed" data-testid="artifact-code">{html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}</pre>}
      </div>
    </div>
  );
}
