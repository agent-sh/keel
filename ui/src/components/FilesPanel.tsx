import { AtSign, ChevronLeft, File as FileIcon, Folder, Search } from "lucide-react";
import { FileBody, type Opened } from "./FileBody.tsx";
import { OpenInEditor } from "./OpenInEditor.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { autoState } from "../lib/automation.ts";
import { api, getState, reportError } from "../lib/store.ts";
import { seedComposer, setUI, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

type Hit = { path: string; dir: boolean };

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
  // The session whose folder the open file is in: this one, or the agent whose report linked it
  // (its worktree, as it is now). `gone`: the linked file is not there any more.
  const [from, setFrom] = useState<Session | null>(null);
  const [gone, setGone] = useState<{ path: string; title: string } | null>(null);
  // A file a reply linked opens here at its lines.
  const linked = useUI((s) => (s.fileAt?.session === session.id ? s.fileAt : null));
  useEffect(() => {
    if (!linked) return;
    setUI({ fileAt: null });
    // (An agent's session the list does not hold is known by its record: its worktree and title.)
    const rec = linked.of ? Object.values(autoState().agents).find((a) => a.session_id === linked.of) : undefined;
    const of = !linked.of ? null : getState().sessions[linked.of] ?? (rec ? { ...session, id: rec.session_id, title: rec.title, workspace: rec.worktree ?? session.workspace } : null);
    if (linked.of && !of) return;
    const src = of ?? session;
    setGone(null);
    api<Opened>(`/api/fs/file?root=${encodeURIComponent(src.workspace)}&path=${encodeURIComponent(linked.path)}`)
      .then((f) => { setFrom(of); setOpen(f); setAt({ line: linked.line, end: linked.end }); })
      .catch((e) => {
        // A file of an agent's worktree that went since its report named it: said here, not an error.
        // (A worktree that is gone whole is no folder the daemon reads from: refused as outside the home.)
        const st = (e as { status?: number }).status;
        if (of && (st === 404 || (st === 403 && /outside the home/.test((e as Error).message)))) return setGone({ path: linked.path, title: of.title });
        reportError(e);
      });
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
    api<Opened>(`/api/fs/file?root=${encodeURIComponent(session.workspace)}&path=${encodeURIComponent(h.path)}`).then((f) => { setFrom(null); setOpen(f); setAt({}); }).catch(reportError);
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

  if (gone) {
    return (
      <div className="flex h-full flex-col" data-testid="file-gone">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-raised px-2">
          <button type="button" onClick={() => setGone(null)} aria-label="Back to the file list" className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={gone.path}>{gone.path}</span>
        </div>
        <p className="k-empty px-4 py-4">Not in {gone.title}'s worktree any more.</p>
      </div>
    );
  }

  if (open) {
    const src = from ?? session;
    // A file of an agent's worktree is mentioned by its whole path: the message box is this session's.
    const named = from ? `${from.workspace}/${open.path}` : open.path;
    const back = () => { setOpen(null); setFrom(null); };
    return (
      <div ref={view} tabIndex={-1} role="region" aria-label={`File ${open.path}`} className="flex h-full flex-col outline-none" data-testid="file-view" data-of={from?.id}
        onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); back(); } }}>
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-raised px-2">
          <button type="button" onClick={back} aria-label="Back to the file list" className="grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg">
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={named}>{open.path}</span>
          <button type="button" onClick={() => mention(named)} className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-2 text-caption text-muted hover:bg-hover hover:text-fg">
            <AtSign className="size-3.5" /> Mention
          </button>
          {!src.machine && <OpenInEditor sessionId={src.id} path={open.path} />}
        </div>
        {from && <div className="truncate border-b border-line px-3 py-1.5 text-caption text-faint" data-testid="file-of" title={from.workspace}>In {from.title}'s worktree</div>}
        <FileBody session={src} first={open} line={at.line} end={at.end} />
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

