import { AtSign, ChevronLeft, File as FileIcon, Folder, Search } from "lucide-react";
import { langOf } from "../lib/lang.ts";
import { IMAGE, OpenInEditor, rawFile } from "./OpenInEditor.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, reportError } from "../lib/store.ts";
import { seedComposer, setUI, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

type Hit = { path: string; dir: boolean };
type Opened = { path: string; size: number; text?: string; binary?: boolean; truncated?: boolean };

function CodeView({ file, line, end }: { file: Opened; line?: number; end?: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const band = useRef<HTMLDivElement>(null);
  // A linked line is shown near the top of the view, its lines marked.
  useEffect(() => {
    const el = band.current;
    const sc = el?.closest<HTMLElement>("[data-file-scroll]");
    if (el && sc) sc.scrollTop = Math.max(0, el.offsetTop - 96);
  }, [line, file]);
  const lines = useMemo(() => (file.text ?? "").split("\n"), [file.text]);
  useEffect(() => {
    setHtml(null);
    if (!file.text || file.text.length > 200_000) return;
    import("../lib/highlight.ts").then((m) => setHtml(m.highlightHtml(file.text!, langOf(file.path)))).catch(reportError);
  }, [file]);
  return (
    <div className="relative flex min-h-full w-max min-w-full font-mono text-caption leading-[1.65]">
      {line && line <= lines.length && (
        <div ref={band} data-testid="file-line" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bg-accent-soft"
          style={{ top: `calc(12px + ${line - 1} * 1.65em)`, height: `calc(${Math.max(1, Math.min(end ?? line, lines.length) - line + 1)} * 1.65em)` }} />
      )}
      <div aria-hidden="true" className="sticky left-0 select-none border-r border-line bg-sunken px-3 py-3 text-right text-faint tabular-nums">
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      {html ? (
        <pre className="relative flex-1 px-4 py-3" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="relative flex-1 px-4 py-3">{file.text}</pre>
      )}
    </div>
  );
}

// The session's folder: find a file, read it, mention it in the message box.
// By keyboard: Down from the search box goes into the results, Up and Down
// move through them (Up from the first goes back to the box), Enter opens the
// one the keys are on. The file opened takes the keys (a region named after
// it); Back, or Escape, returns to the list as it was: the same query, the
// keys on the result that was opened, the list scrolled where it was.
export function FilesPanel({ session }: { session: Session }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<Opened | null>(null);
  const [at, setAt] = useState<{ line?: number; end?: number }>({});
  // A file a reply linked opens here at its lines.
  const linked = useUI((s) => (s.fileAt?.session === session.id ? s.fileAt : null));
  useEffect(() => {
    if (!linked) return;
    setUI({ fileAt: null });
    api<Opened>(`/api/fs/file?root=${encodeURIComponent(session.workspace)}&path=${encodeURIComponent(linked.path)}`)
      .then((f) => { setOpen(f); setAt({ line: linked.line, end: linked.end }); })
      .catch(reportError);
  }, [linked?.n]);

  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/fs/files?path=${encodeURIComponent(session.workspace)}&q=${encodeURIComponent(q)}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((r) => { setHits(r.hits ?? []); setTotal(r.total ?? 0); })
        .catch((e) => e.name !== "AbortError" && reportError(e, { kind: "files-panel" }));
    }, 80);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, session.workspace]);

  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  // Where the list was when a file was opened from it: the result the keys were on (none: the search box) and its scroll.
  const left = useRef<{ path: string | null; top: number } | null>(null);
  const results = () => [...(list.current?.querySelectorAll<HTMLElement>("[data-result]") ?? [])];
  const show = (h: Hit) => {
    // A folder narrows the list to what is in it: the keys go on in the search box.
    if (h.dir) { setQ(h.path); input.current?.focus(); return; }
    const on = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.result : undefined;
    left.current = { path: on ?? null, top: list.current?.scrollTop ?? 0 };
    api<Opened>(`/api/fs/file?root=${encodeURIComponent(session.workspace)}&path=${encodeURIComponent(h.path)}`).then((f) => { setOpen(f); setAt({}); }).catch(reportError);
  };
  // The file opened takes the keys; back in the list they return where they were.
  const shown = open?.path;
  useLayoutEffect(() => {
    if (shown) return void view.current?.focus({ preventScroll: true });
    const was = left.current;
    left.current = null;
    if (!was) return void input.current?.focus({ preventScroll: true });
    if (list.current) list.current.scrollTop = was.top;
    (results().find((el) => el.dataset.result === was.path) ?? input.current)?.focus({ preventScroll: true });
  }, [shown]);
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const all = results();
    const i = all.indexOf(e.target as HTMLElement);
    if (e.target === input.current) {
      if (e.key === "ArrowDown" && all.length) { e.preventDefault(); all[0]!.focus(); }
      // Enter in the box opens the first result.
      else if (e.key === "Enter" && hits[0]) { e.preventDefault(); show(hits[0]); }
      return;
    }
    if (i < 0) return;
    const to = e.key === "ArrowDown" ? all[i + 1] : e.key === "ArrowUp" ? (i === 0 ? input.current : all[i - 1]) : e.key === "Home" ? all[0] : e.key === "End" ? all.at(-1) : undefined;
    if (!to) return;
    e.preventDefault();
    to.focus();
  };
  const mention = (path: string) => {
    const draft = localStorage.getItem(`keel.draft.${session.id}`) ?? "";
    seedComposer(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@${path} `, session.id);
  };

  if (open) {
    return (
      <div ref={view} tabIndex={-1} role="region" aria-label={`File ${open.path}`} className="flex h-full flex-col outline-none" data-testid="file-view"
        onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setOpen(null); } }}>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-raised px-2">
          <button type="button" onClick={() => setOpen(null)} aria-label="Back to the file list" className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={open.path}>{open.path}</span>
          <button type="button" onClick={() => mention(open.path)} className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-caption text-muted hover:bg-hover hover:text-fg">
            <AtSign className="size-3.5" /> Mention
          </button>
          {!session.machine && <OpenInEditor sessionId={session.id} path={open.path} />}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-raised" data-file-scroll>
          {open.binary && IMAGE.test(open.path) && !session.machine
            ? <img src={rawFile(session.id, open.path)} alt={open.path} data-testid="file-image" className="m-4 max-w-[calc(100%-2rem)] rounded-md border border-line" />
            : open.binary ? <p className="p-6 text-ui text-faint">A binary file, {Math.round(open.size / 1024)} KB.</p> : <CodeView file={open} line={at.line} end={at.end} />}
          {open.truncated && <p className="border-t border-line p-3 text-caption text-faint">Showing the first 512 KB of {Math.round(open.size / 1024)} KB.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="files-panel" onKeyDown={keys}>
      <div className="p-2">
        <label className="flex h-9 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-ui focus-within:border-line-strong">
          <Search className="size-4 text-faint" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find a file in ${session.workspace.split("/").pop()}`} className="w-full bg-transparent outline-none placeholder:text-faint" data-testid="files-search" />
        </label>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-testid="files-list">
        {hits.map((h) => (
          <div key={h.path} className="group flex h-8 items-center gap-2 rounded-md px-2 text-ui hover:bg-hover focus-within:bg-hover touch:h-10">
            <button type="button" data-result={h.path} onClick={() => show(h)} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left">
              {h.dir ? <Folder className="size-4 shrink-0 text-faint" /> : <FileIcon className="size-4 shrink-0 text-faint" />}
              <span className={cn("truncate font-mono text-caption", h.dir ? "text-muted" : "text-fg")}>{h.path}</span>
            </button>
            {/* In the Tab order from the start; quiet until the row is hovered or holds the keyboard, shown where nothing hovers. */}
            {!h.dir && (
              <button type="button" title="Mention in the message box" aria-label={`Mention ${h.path}`} onClick={() => mention(h.path)} className="grid size-6 shrink-0 place-items-center rounded-sm text-faint opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 touch:size-8 touch:text-muted touch:opacity-100">
                <AtSign className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {hits.length === 0 && <p className="k-empty px-2 py-4">No file matches.</p>}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-micro text-faint">{total.toLocaleString()} files</div>
    </div>
  );
}

