// What a session made, in its side panel (and every session's of a project, on
// the project's page): the files it created or changed and the ones in its
// artifacts folder, newest first, with a preview of the picked one: an image,
// rendered markdown, a page in a sandbox that reaches nothing, highlighted
// code, and the diff of a changed file. Open in the editor, copy the path,
// download. The list follows the session while it works.
import { Code2, Download, ExternalLink, FileText, Globe, Image as ImageIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Artifact } from "../../../src/server/routes/artifacts.ts";
import { copyText } from "../lib/copy.ts";
import { api, onFeature, reportError } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { DiffView, type FileChange } from "./DiffView.tsx";
import { Markdown } from "./Markdown.tsx";

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

// The artifacts of a session or a project, kept current by "artifacts" frames.
export function useArtifacts(url: string, sessions: (id: string | undefined) => boolean) {
  const [list, setList] = useState<Listed[] | null>(null);
  const mine = useRef(sessions);
  mine.current = sessions;
  const load = useCallback(() => api<{ artifacts: Listed[] }>(url).then((r) => setList(r.artifacts), reportError), [url]);
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

export function ArtifactBrowser({ list, testid, withSession }: { list: Listed[] | null; testid: string; withSession?: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = (list ?? []).filter((a) => pass(filter, a));
  const key = (a: Listed) => `${a.session_id}\u0000${a.path}`;
  const cur = shown.find((a) => key(a) === picked) ?? shown[0];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={testid}>
      <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2" role="group" aria-label="Show">
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
      {list && !list.length && <p className="px-4 py-10 text-center text-ui text-faint" data-testid="artifacts-empty">Nothing made yet. Files this session writes, and what it puts in its artifacts folder, show up here as it works.</p>}
      {shown.length > 0 && (
        <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line py-1" aria-label="Artifacts">
          {shown.map((a) => {
            const Icon = ICON[a.kind];
            return (
              <li key={key(a)}>
                <button type="button" data-testid="artifact-row" data-path={a.path} data-kind={a.kind} aria-current={cur === a || undefined} onClick={() => setPicked(key(a))}
                  className={cn("flex h-9 w-full items-center gap-2.5 px-3 text-left text-ui hover:bg-hover", cur === a ? "bg-hover text-fg" : "text-muted", !a.exists && "line-through opacity-60")}>
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
      {cur && <Preview key={`${key(cur)}\u0000${cur.last_ts}`} a={cur} />}
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
      <div className="flex items-center gap-1.5 px-3 py-2">
        <div className="mr-auto flex gap-0.5 rounded-md border border-line bg-sunken p-0.5" role="tablist" aria-label="View">
          {views.map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} data-testid={`artifact-view-${v}`} onClick={() => setView(v)} className={cn("h-6 rounded-sm px-2 text-caption", view === v ? "bg-raised text-fg shadow-1" : "text-muted hover:text-fg")}>{label}</button>
          ))}
        </div>
        <button type="button" className={button} data-testid="artifact-open" title={said || "Open in your editor on this machine"} onClick={() => api(`/api/sessions/${a.session_id}/artifacts/open`, { method: "POST", body: JSON.stringify({ path: a.path }) }).then(() => setSaid("Opened"), (e) => setSaid((e as Error).message))}><ExternalLink className="size-3.5" />{said === "Opened" ? "Opened" : "Open"}</button>
        <button type="button" className={button} data-testid="artifact-copy-path" onClick={() => copyText(a.path).then(() => setSaid("Path copied"), reportError)}>{said === "Path copied" ? "Copied" : "Copy path"}</button>
        <a className={button} href={raw(a, true)} download={a.name} data-testid="artifact-download" aria-label="Download"><Download className="size-3.5" /></a>
      </div>
      <p className="truncate px-3 pb-2 font-mono text-micro text-faint" title={a.path}>{a.path}</p>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line" data-testid="artifact-body">
        {!a.exists ? <p className="p-4 text-ui text-faint">The file is gone from disk.</p>
          : view === "diff" ? <div className="p-3">{diff ? <DiffView files={diff.files} patch={diff.diff} truncated={diff.truncated} empty="No change of this file is in the session's checkpoints." /> : <p className="text-caption text-faint">Loading…</p>}</div>
          : view === "show" && a.kind === "image" ? <div className="grid place-items-center p-4"><img src={raw(a)} alt={a.name} className="max-h-full max-w-full rounded-md border border-line bg-[repeating-conic-gradient(var(--color-sunken)_0_25%,transparent_0_50%)] bg-[length:1rem_1rem]" data-testid="artifact-image" /></div>
          : view === "show" && a.kind === "html" ? <iframe title={a.name} src={raw(a)} sandbox="allow-scripts" referrerPolicy="no-referrer" className="h-full min-h-[24rem] w-full bg-white" data-testid="artifact-frame" />
          : view === "show" && a.kind === "markdown" ? <div className="px-5 py-4">{text === null ? null : <Markdown text={text} />}</div>
          : text === null ? <p className="p-4 text-caption text-faint">Loading…</p>
          : <pre className="p-3 font-mono text-caption leading-relaxed" data-testid="artifact-code">{html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}</pre>}
      </div>
    </div>
  );
}
