import { ChevronRight, MessageSquarePlus, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { parsePatch, type FilePatch, type PatchLine } from "../../../src/safety/patch.ts";
import { cn } from "../lib/utils.ts";

export { parsePatch };
export type FileChange = { path: string; status: string; added: number; removed: number; outside?: boolean };

const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: "added", cls: "text-ok" },
  D: { label: "deleted", cls: "text-danger" },
  M: { label: "modified", cls: "text-muted" },
};

// A comment on one line of one side: "old" is the removed text (a deleted
// line's number in the old file), "new" the file as it is now. `quote` is the
// line's text when it was written, so a refreshed diff can find it again.
export type Comment = { id: string; path: string; side: "old" | "new"; line: number; text: string; quote: string; outdated?: boolean };

// "Show this file at that line": a finding's link asks the file's block to
// open and scroll there; `found` says whether the line is in the diff.
export type JumpDetail = { path: string; line: number; end?: number; found?: boolean };
export const JUMP = "keel:diff-jump";

// A line as a comment names it: its side and its number on that side.
const lineKey = (l: PatchLine) => (l.kind === "del" ? `old:${l.old ?? 0}` : `new:${l.new ?? 0}`);
const lineName = (path: string, l: PatchLine) => `${path}, ${l.kind === "del" ? `old line ${l.old} (removed)` : `new line ${l.new}${l.kind === "add" ? " (added)" : ""}`}`;

// Files with their diffs. `actions` renders per-file buttons (revert);
// `onComment` turns line numbers into "add a comment" targets (one Tab stop a
// file; Up and Down move between lines, Page Down and Page Up to the first
// changed line of the next or the previous hunk); `onHunk`
// puts a revert button on each hunk. `truncated`/`partial` say the patch was
// cut to fit; `loadFile` fetches one file's whole diff in its place.
export type HunkRef = { path: string; index: number; header: string; body: string };
export function DiffView({
  files, patch, truncated, partial, loadFile, actions, comments, onComment, onHunk, empty,
}: {
  files: FileChange[];
  patch: string;
  truncated?: boolean;
  partial?: string;
  loadFile?: (path: string) => Promise<string>;
  actions?: (f: FileChange) => ReactNode;
  comments?: Comment[];
  onComment?: (c: Omit<Comment, "id">) => void;
  onHunk?: (h: HunkRef) => void;
  empty?: string;
}) {
  const parsed = useMemo(() => new Map(parsePatch(patch).map((p) => [p.path, p])), [patch]);
  const [whole, setWhole] = useState<Record<string, FilePatch>>({});
  useEffect(() => setWhole({}), [patch]);
  if (!files.length) return <p className="px-3 py-10 text-center text-ui text-faint">{empty ?? "No changes."}</p>;
  const load = loadFile && (async (path: string) => {
    const p = parsePatch(await loadFile(path)).find((x) => x.path === path);
    if (p) setWhole((m) => ({ ...m, [path]: p }));
  });
  return (
    <div className="flex flex-col gap-2" data-testid="diff-view">
      {files.map((f) => {
        const p = whole[f.path] ?? parsed.get(f.path);
        const cut = !whole[f.path] && truncated ? (p ? (partial === f.path ? "partial" : null) : "omitted") : null;
        return <FileBlock key={f.path} f={f} p={p} cut={cut} load={load} actions={actions} comments={comments?.filter((c) => c.path === f.path && !c.outdated)} onComment={onComment} onHunk={onHunk} />;
      })}
    </div>
  );
}

const exec = (m?: string) => !!m && (parseInt(m, 8) & 0o111) !== 0;
function modeNote(p?: FilePatch): string | null {
  if (!p?.oldMode || !p.newMode) return null;
  const a = exec(p.oldMode), b = exec(p.newMode);
  const what = a === b ? "File mode changed" : b ? "Executable bit added" : "Executable bit removed";
  return `${what} (${p.oldMode} → ${p.newMode})`;
}

function FileBlock({ f, p, cut, load, actions, comments, onComment, onHunk }: {
  f: FileChange; p?: FilePatch; cut: "partial" | "omitted" | null; load?: (path: string) => Promise<void>;
  actions?: (f: FileChange) => ReactNode; comments?: Comment[]; onComment?: (c: Omit<Comment, "id">) => void; onHunk?: (h: HunkRef) => void;
}) {
  const [open, setOpen] = useState(true);
  // Drafts by line: moving to another line keeps what was typed on this one.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<{ line: number; end: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const st = STATUS[f.status[0]!] ?? { label: f.status, cls: "text-muted" };
  const mode = modeNote(p);
  // The line of this file the Tab key lands on: the one last visited, else the first changed one.
  const [visited, setVisited] = useState<string | null>(null);
  const rows = p?.lines.filter((l) => l.kind !== "hunk") ?? [];
  const stop = visited && rows.some((l) => lineKey(l) === visited) ? visited : lineKey(rows.find((l) => l.kind !== "ctx") ?? rows[0] ?? { kind: "ctx", text: "" });
  const focusLine = (key: string) => body.current?.querySelector<HTMLElement>(`[data-line="${key}"]`)?.focus();
  const onKeys = (e: KeyboardEvent<HTMLTableElement>) => {
    const at = e.target as HTMLElement;
    if (at.dataset.line === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-line]")];
    const i = all.indexOf(at);
    const hunk = (el: HTMLElement) => Number(el.dataset.hunk);
    const lead = (h: number) => all.find((b) => hunk(b) === h && b.dataset.changed !== undefined) ?? all.find((b) => hunk(b) === h);
    let to: HTMLElement | undefined;
    if (e.key === "ArrowDown") to = all[i + 1];
    else if (e.key === "ArrowUp") to = all[i - 1];
    else if (e.key === "Home") to = all[0];
    else if (e.key === "End") to = all.at(-1);
    else if (e.key === "PageDown") to = lead(hunk(at) + 1);
    else if (e.key === "PageUp") to = lead(hunk(at) - 1);
    else return;
    e.preventDefault();
    to?.focus();
  };

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<JumpDetail>).detail;
      if (d.path !== f.path) return;
      const end = d.end ?? d.line;
      d.found = !!p?.lines.some((l) => l.kind !== "hunk" && l.kind !== "del" && l.new! >= d.line && l.new! <= end);
      setOpen(true);
      if (!d.found) { body.current?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      setFlash({ line: d.line, end });
      requestAnimationFrame(() => [...(body.current?.querySelectorAll<HTMLElement>("tr[data-new]") ?? [])].find((r) => Number(r.dataset.new) >= d.line && Number(r.dataset.new) <= end)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    };
    window.addEventListener(JUMP, on);
    return () => window.removeEventListener(JUMP, on);
  }, [f.path, p]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2400); return () => clearTimeout(t); }, [flash]);

  const loadButton = load && (
    <button data-testid="diff-load-file" disabled={loading} onClick={() => { setLoading(true); load(f.path).finally(() => setLoading(false)); }}
      className="ml-2 rounded px-1.5 font-sans text-micro font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
      {loading ? "Loading…" : "Show this file's whole diff"}
    </button>
  );

  let hunks = 0;
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-raised" data-testid="diff-file" data-path={f.path}>
      <header className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-1.5">
        <button onClick={() => setOpen(!open)} className="grid size-5 place-items-center rounded text-faint hover:text-fg" aria-label={open ? "Collapse" : "Expand"}>
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <span className="min-w-0 truncate font-mono text-caption">{f.path}</span>
        <span className={cn("text-micro", st.cls)}>{st.label}</span>
        {f.outside && <span className="rounded-full bg-warn/15 px-1.5 text-micro text-warn" title="Changed outside the session's own tool calls">outside</span>}
        {cut && <span className="rounded-full bg-warn/15 px-1.5 text-micro text-warn" data-testid="diff-cut">{cut === "partial" ? "partial" : "not in preview"}</span>}
        <span className="ml-auto font-mono text-micro tabular-nums">
          <span className="text-ok">+{f.added}</span> <span className="text-danger">-{f.removed}</span>
        </span>
        {actions?.(f)}
      </header>
      {open && (
        <div ref={body} className="overflow-x-auto font-mono text-caption leading-[1.6]">
          {mode && <p className="border-b border-line px-3 py-1.5 font-sans text-caption text-muted" data-testid="diff-mode">{mode}</p>}
          {cut === "omitted" ? (
            <p className="px-3 py-2 font-sans text-faint" data-testid="diff-omitted">Left out of this preview: the whole diff is over its size limit.{loadButton}</p>
          ) : p?.binary ? (
            <p className="px-3 py-2 text-faint">Binary file</p>
          ) : !p || !p.lines.length ? (
            !mode && <p className="px-3 py-2 text-faint">No text change shown.</p>
          ) : (
            <table className="w-full border-collapse" onKeyDown={onComment ? onKeys : undefined}>
              <tbody>
                {p.lines.map((l, i) => {
                  if (l.kind === "hunk") hunks++;
                  const hunkIndex = hunks - 1;
                  const side: "old" | "new" = l.kind === "del" ? "old" : "new";
                  const lineNo = (side === "old" ? l.old : l.new) ?? 0;
                  const key = lineKey(l);
                  const here = l.kind === "hunk" ? [] : comments?.filter((c) => c.side === side && c.line === lineNo) ?? [];
                  const lit = flash && l.kind !== "del" && l.kind !== "hunk" && l.new! >= flash.line && l.new! <= flash.end;
                  return [
                    <tr key={i} data-new={l.kind !== "del" && l.kind !== "hunk" ? l.new : undefined} data-old={l.kind === "del" ? l.old : undefined}
                      className={cn(
                        "group/line has-focus-visible:outline has-focus-visible:outline-1 has-focus-visible:-outline-offset-1 has-focus-visible:outline-accent",
                        l.kind === "add" && "bg-ok/10",
                        l.kind === "del" && "bg-danger-soft/70",
                        l.kind === "hunk" && "bg-accent-soft/40 text-faint",
                        lit && "outline outline-1 -outline-offset-1 outline-accent bg-accent-soft/60",
                      )}>
                      <td className="w-10 select-none px-2 text-right text-faint/80 tabular-nums">{l.kind === "hunk" ? "" : l.old ?? ""}</td>
                      <td className="relative w-10 select-none px-2 text-right text-faint/80 tabular-nums">
                        {l.kind === "hunk" ? "" : l.new ?? ""}
                        {onComment && l.kind !== "hunk" && (
                          <button
                            type="button"
                            data-testid="comment-line"
                            data-line={key}
                            data-hunk={hunkIndex}
                            data-changed={l.kind !== "ctx" ? "" : undefined}
                            tabIndex={key === stop ? 0 : -1}
                            aria-label={`Comment on ${lineName(f.path, l)}`}
                            title={side === "old" ? "Comment on this removed line" : "Comment on this line"}
                            onFocus={() => setVisited(key)}
                            onClick={() => setDrafts((d) => ({ ...d, [key]: d[key] ?? "" }))}
                            className="absolute -right-2 top-0 grid size-[1.2rem] place-items-center rounded bg-accent text-accent-fg opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
                          >
                            <MessageSquarePlus className="size-3" />
                          </button>
                        )}
                      </td>
                      <td className="w-4 select-none pl-2 text-faint">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</td>
                      <td className="whitespace-pre pr-4">
                        {l.text}
                        {l.noEol && <span className="ml-2 select-none rounded bg-sunken px-1 font-sans text-micro text-muted" data-testid="no-eol">no newline at end of file</span>}
                        {onHunk && l.kind === "hunk" && (
                          <button data-testid="revert-hunk" onClick={() => onHunk({ path: f.path, index: hunkIndex, header: l.text, body: l.body ?? "" })}
                            className="float-right ml-3 rounded px-1.5 font-sans text-micro text-muted hover:bg-hover hover:text-fg">Revert hunk</button>
                        )}
                      </td>
                    </tr>,
                    ...here.map((c) => (
                      <tr key={`${i}-c${c.id}`}>
                        <td colSpan={4} className="px-3 py-1.5">
                          <div className="rounded-lg border border-accent/40 bg-accent-soft/40 px-3 py-1.5 font-sans text-caption" data-testid="line-comment" data-side={c.side}>{c.text}</div>
                        </td>
                      </tr>
                    )),
                    drafts[key] !== undefined && l.kind !== "hunk" ? (
                      <tr key={`${i}-draft`}>
                        <td colSpan={4} className="px-3 py-1.5">
                          {/* Added or discarded, the keyboard is back on the line's comment button. */}
                          <CommentForm l={l} side={side} text={drafts[key]!} label={`Comment on ${lineName(f.path, l)}`}
                            onText={(t) => setDrafts((d) => ({ ...d, [key]: t }))}
                            onClose={() => { focusLine(key); setDrafts(({ [key]: _, ...d }) => d); }}
                            onAdd={(t) => { focusLine(key); onComment?.({ path: f.path, side, line: lineNo, text: t, quote: l.text }); setDrafts(({ [key]: _, ...d }) => d); }}
                          />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
                {cut === "partial" && (
                  <tr><td colSpan={4} className="border-t border-line px-3 py-1.5 font-sans text-caption text-warn" data-testid="diff-partial">The rest of this file's diff is cut to fit.{loadButton}</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

function CommentForm({ l, side, text, label, onText, onClose, onAdd }: { l: PatchLine; side: "old" | "new"; text: string; label: string; onText: (t: string) => void; onClose: () => void; onAdd: (t: string) => void }) {
  return (
    <form className="flex items-center gap-2 font-sans" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAdd(text.trim()); else onClose(); }}>
      {side === "old" && <span className="shrink-0 rounded bg-danger-soft px-1.5 text-micro text-danger" title={`Removed line ${l.old}`}>removed line</span>}
      <input
        autoFocus
        data-testid="comment-input"
        aria-label={label}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && !text.trim()) onClose(); }}
        placeholder={side === "old" ? "What about this removed line?" : "What should change here?"}
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-caption outline-none focus:border-line-strong"
      />
      <button type="submit" data-testid="comment-add" className="h-8 rounded-lg bg-accent px-3 text-caption font-medium text-accent-fg">Add</button>
      <button type="button" data-testid="comment-discard" onClick={onClose} className="h-8 rounded-lg px-2 text-caption text-muted hover:bg-hover">Discard</button>
    </form>
  );
}

export function RevertButton({ onClick, title = "Revert this file" }: { onClick: () => void; title?: string }) {
  return (
    <button data-testid="revert-file" title={title} onClick={onClick} className="grid size-6 place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger">
      <Undo2 className="size-3.5" />
    </button>
  );
}
