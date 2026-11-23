import { ChevronRight, MessageSquarePlus, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { parsePatch, type FilePatch, type PatchLine } from "../../../src/safety/patch.ts";
import { cn, scrollMotion } from "../lib/utils.ts";
import { langOf } from "../lib/lang.ts";
import { foldOver, foldsOf } from "../lib/diff-folds.ts";
import { reportError } from "../lib/store.ts";

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
// puts a revert button on each hunk. A long line pans under its numbers: the
// gutter (both numbers and the comment mark) stays at the left edge, and what
// is not code (a hunk's head, a comment, the comment form) keeps the width on
// screen. Where nothing hovers, the comment mark of every line is shown. `truncated`/`partial` say the patch was
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
  if (!files.length) return <p className="k-empty px-3 py-4">{empty ?? "No changes."}</p>;
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

// A change shown where it was made (a tool call of the transcript): the same
// block as in Changes and Review, from lines the call itself carries.
export type CallFile = FileChange & { lines: PatchLine[]; full?: string };
export function CallDiff({ files, actions }: { files: CallFile[]; actions?: (f: FileChange) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2" data-testid="diff">
      {files.map((f, i) => <FileBlock key={`${f.path}:${i}`} f={f} p={{ path: f.path, lines: f.lines, binary: false }} cut={null} actions={actions} bare={files.length === 1} />)}
    </div>
  );
}

// The highlighter loads on first use; a diff shown before it did is colored when it has.
type Colorer = (code: string, lang: string) => string | null;
let colorer: Colorer | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();
function useColorer(want: boolean): Colorer | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!want || colorer) return;
    const on = () => tick((n) => n + 1);
    waiting.add(on);
    loading ??= import("../lib/highlight.ts").then((m) => { colorer = m.highlightHtml; waiting.forEach((f) => f()); waiting.clear(); }).catch((e) => { loading = null; reportError(e, { kind: "highlight" }); });
    return () => void waiting.delete(on);
  }, [want]);
  return want ? colorer : null;
}
// Lines are colored one at a time (a diff holds parts of a file), up to this many a file.
const COLOR_MAX = 3000;
// A change of more than LONG lines under a call's line shows its first LONG_SHOWN.
const LONG = 80, LONG_SHOWN = 60;

const exec = (m?: string) => !!m && (parseInt(m, 8) & 0o111) !== 0;
function modeNote(p?: FilePatch): string | null {
  if (!p?.oldMode || !p.newMode) return null;
  const a = exec(p.oldMode), b = exec(p.newMode);
  const what = a === b ? "File mode changed" : b ? "Executable bit added" : "Executable bit removed";
  return `${what} (${p.oldMode} → ${p.newMode})`;
}

// `bare`: the block stands under a line that already names its file and its counts
// (a call of the transcript): no head, and what the head would offer sits in its corner.
function FileBlock({ f, p, cut, load, actions, comments, onComment, onHunk, bare }: {
  bare?: boolean;
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
  const color = useColorer(open && !!p?.lines.length && p.lines.length <= COLOR_MAX);
  const html = useMemo(() => {
    const lang = langOf(f.path);
    return color && p ? p.lines.map((l) => (l.kind === "hunk" || !l.text ? null : color(l.text, lang))) : null;
  }, [color, p, f.path]);
  // Unchanged lines in a row fold until asked for (lib/diff-folds.ts); not a run with a comment on it or one being written.
  const pinned = useMemo(() => {
    const keys = new Set([...(comments ?? []).map((c) => `${c.side}:${c.line}`), ...Object.keys(drafts)]);
    const out = new Set<number>();
    if (keys.size) p?.lines.forEach((l, i) => { if (l.kind !== "hunk" && keys.has(lineKey(l))) out.add(i); });
    return out;
  }, [p, comments, drafts]);
  const folds = useMemo(() => foldsOf(p?.lines ?? [], pinned), [p, pinned]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setUnfolded(new Set()), [p]);
  // Under a call's line a long change shows its start, and the rest when asked for.
  const [whole, setWhole] = useState(false);
  const shown = bare && !whole && (p?.lines.length ?? 0) > LONG ? LONG_SHOWN : Infinity;
  // The line of this file the Tab key lands on: the one last visited, else the
  // first changed one. Moving along the lines renders nothing: the stop is kept
  // in a ref and moved between the two buttons by the table's one focus handler.
  const visited = useRef<string | null>(null);
  const rows = p?.lines.filter((l) => l.kind !== "hunk") ?? [];
  // Both number columns are as wide as the file's longest number, so they line up down the rows.
  const digits = Math.max(2, String(rows.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length);
  // Lines whose place in the file is not known (an edit recorded without it) show no numbers.
  const numbered = rows.some((l) => l.old !== undefined || l.new !== undefined);
  const stop = visited.current && rows.some((l) => lineKey(l) === visited.current) ? visited.current : lineKey(rows.find((l) => l.kind !== "ctx") ?? rows[0] ?? { kind: "ctx", text: "" });
  const focusLine = (key: string) => body.current?.querySelector<HTMLElement>(`[data-line="${key}"]`)?.focus();
  const onFocusLine = (e: FocusEvent<HTMLTableElement>) => {
    const at = e.target as HTMLElement;
    if (at.dataset.line === undefined) return;
    visited.current = at.dataset.line;
    const was = e.currentTarget.querySelector<HTMLElement>('[data-line][tabindex="0"]');
    if (was === at) return;
    if (was) was.tabIndex = -1;
    at.tabIndex = 0;
  };
  const onClickLine = (e: MouseEvent<HTMLTableElement>) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-line]")?.dataset.line;
    if (key !== undefined) setDrafts((d) => ({ ...d, [key]: d[key] ?? "" }));
  };
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
    // On the first or the last hunk the Page keys page the panel as usual.
    if (to || !e.key.startsWith("Page")) e.preventDefault();
    to?.focus();
  };

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<JumpDetail>).detail;
      if (d.path !== f.path) return;
      const end = d.end ?? d.line;
      d.found = !!p?.lines.some((l) => l.kind !== "hunk" && l.kind !== "del" && l.new! >= d.line && l.new! <= end);
      setOpen(true);
      if (!d.found) { body.current?.closest("section")?.scrollIntoView({ behavior: scrollMotion(), block: "start" }); return; }
      setFlash({ line: d.line, end });
      // A line inside a folded run is shown first, then brought into view.
      const hidden = foldOver(folds, p!.lines.findIndex((l) => l.kind !== "hunk" && l.kind !== "del" && l.new! >= d.line && l.new! <= end));
      if (hidden !== undefined) setUnfolded((u) => new Set(u).add(hidden));
      const show = () => [...(body.current?.querySelectorAll<HTMLElement>("tr[data-new]") ?? [])].find((r) => Number(r.dataset.new) >= d.line && Number(r.dataset.new) <= end)?.scrollIntoView({ behavior: scrollMotion(), block: "center" });
      requestAnimationFrame(hidden === undefined ? show : () => requestAnimationFrame(show));
    };
    window.addEventListener(JUMP, on);
    return () => window.removeEventListener(JUMP, on);
  }, [f.path, p, folds]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 2400); return () => clearTimeout(t); }, [flash]);

  const loadButton = load && (
    <button data-testid="diff-load-file" disabled={loading} onClick={() => { setLoading(true); load(f.path).finally(() => setLoading(false)); }}
      className="ml-2 rounded px-1.5 font-sans text-micro font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
      {loading ? "Loading…" : "Show this file's whole diff"}
    </button>
  );

  let hunks = 0;
  let foldedTo = -1;
  return (
    <section className="k-diff-file" data-testid="diff-file" data-path={f.path} data-bare={bare ? "" : undefined}>
      {bare ? actions && <div className="k-diff-corner">{actions(f)}</div> : <header className="flex items-center gap-2 border-b border-line bg-sunken/60 px-3 py-1.5">
        <button onClick={() => setOpen(!open)} className="grid size-ctl-sm place-items-center rounded text-faint hover:text-fg" aria-label={open ? "Collapse" : "Expand"}>
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
      </header>}
      {open && (
        <div ref={body} className="k-diff-body overflow-x-auto font-mono text-caption leading-[1.6]">
          {mode && <p className="border-b border-line px-3 py-1.5 font-sans text-caption text-muted" data-testid="diff-mode">{mode}</p>}
          {cut === "omitted" ? (
            <p className="px-3 py-2 font-sans text-faint" data-testid="diff-omitted">Left out of this preview: the whole diff is over its size limit.{loadButton}</p>
          ) : p?.binary ? (
            <p className="px-3 py-2 text-faint">Binary file</p>
          ) : !p || !p.lines.length ? (
            !mode && <p className="k-empty px-3 py-2">No text change shown.</p>
          ) : (
            <table className="w-full border-collapse" data-plain={numbered ? undefined : ""} data-marks={onComment ? "" : undefined} style={{ "--k-diff-digits": digits } as CSSProperties} onKeyDown={onComment ? onKeys : undefined} onFocus={onComment ? onFocusLine : undefined} onClick={onComment ? onClickLine : undefined}>
              <tbody>
                {p.lines.map((l, i) => {
                  if (l.kind === "hunk") hunks++;
                  const hunkIndex = hunks - 1;
                  if (i < foldedTo || i >= shown) return null;
                  const to = folds.get(i);
                  if (to !== undefined && !unfolded.has(i)) {
                    foldedTo = to;
                    return (
                      <tr key={`fold-${i}`} className="k-diff-line" data-kind="fold">
                        <td colSpan={3} className="p-0">
                          <div className="k-diff-wide">
                            <button type="button" data-testid="diff-unfold" onClick={() => setUnfolded((u) => new Set(u).add(i))} className="k-diff-fold">{to - i} unchanged lines</button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  const side: "old" | "new" = l.kind === "del" ? "old" : "new";
                  const lineNo = (side === "old" ? l.old : l.new) ?? 0;
                  const key = lineKey(l);
                  const here = l.kind === "hunk" ? [] : comments?.filter((c) => c.side === side && c.line === lineNo) ?? [];
                  const lit = flash && l.kind !== "del" && l.kind !== "hunk" && l.new! >= flash.line && l.new! <= flash.end;
                  return [
                    <tr key={i} data-kind={l.kind} data-lit={lit ? "" : undefined} data-new={l.kind !== "del" && l.kind !== "hunk" ? l.new : undefined} data-old={l.kind === "del" ? l.old : undefined} className="k-diff-line group/line">
                      {l.kind === "hunk" ? (
                        <td colSpan={3} className="p-0">
                          <div className="k-diff-wide flex items-center gap-3 pl-3 pr-2">
                            <span className="min-w-0 flex-1 truncate">{l.text}</span>
                            {onHunk && (
                              <button data-testid="revert-hunk" onClick={() => onHunk({ path: f.path, index: hunkIndex, header: l.text, body: l.body ?? "" })}
                                className="inline-flex h-ctl-sm shrink-0 items-center rounded px-1.5 font-sans text-micro text-muted hover:bg-hover hover:text-fg">Revert hunk</button>
                            )}
                          </div>
                        </td>
                      ) : (
                        <>
                          <td className="k-diff-gutter select-none p-0 tabular-nums">
                            <span className="flex">
                              <span className="k-diff-no">{l.old ?? ""}</span>
                              <span className="k-diff-no relative">
                                {l.new ?? ""}
                                {onComment && (
                                  <button
                                    type="button"
                                    data-testid="comment-line"
                                    data-line={key}
                                    data-hunk={hunkIndex}
                                    data-changed={l.kind !== "ctx" ? "" : undefined}
                                    data-open={drafts[key] !== undefined ? "" : undefined}
                                    tabIndex={key === stop ? 0 : -1}
                                    aria-label={`Comment on ${lineName(f.path, l)}`}
                                    className="absolute -right-[1.05rem] top-1/2 grid size-ctl-sm -translate-y-1/2 place-items-center rounded bg-accent text-accent-fg opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
                                  >
                                    <MessageSquarePlus className="size-3" />
                                  </button>
                                )}
                              </span>
                            </span>
                          </td>
                          <td className="w-4 select-none px-2 text-faint">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</td>
                          <td className="whitespace-pre pr-4">
                            {html?.[i] != null ? <span dangerouslySetInnerHTML={{ __html: html[i]! }} /> : l.text}
                            {l.noEol && <span className="ml-2 select-none rounded bg-sunken px-1 font-sans text-micro text-muted" data-testid="no-eol">no newline at end of file</span>}
                          </td>
                        </>
                      )}
                    </tr>,
                    ...here.map((c) => (
                      <tr key={`${i}-c${c.id}`}>
                        <td colSpan={3} className="p-0">
                          <div className="k-diff-wide px-3 py-1.5">
                            <div className="rounded-lg border border-accent/40 bg-accent-soft/40 px-3 py-1.5 font-sans text-caption" data-testid="line-comment" data-side={c.side}>{c.text}</div>
                          </div>
                        </td>
                      </tr>
                    )),
                    drafts[key] !== undefined && l.kind !== "hunk" ? (
                      <tr key={`${i}-draft`}>
                        <td colSpan={3} className="p-0">
                          {/* Added or discarded, the keyboard is back on the line's comment button. */}
                          <div className="k-diff-wide px-3 py-1.5">
                            <CommentForm l={l} side={side} text={drafts[key]!} label={`Comment on ${lineName(f.path, l)}`}
                              onText={(t) => setDrafts((d) => ({ ...d, [key]: t }))}
                              onClose={() => { focusLine(key); setDrafts(({ [key]: _, ...d }) => d); }}
                              onAdd={(t) => { focusLine(key); onComment?.({ path: f.path, side, line: lineNo, text: t, quote: l.text }); setDrafts(({ [key]: _, ...d }) => d); }}
                            />
                          </div>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
                {shown < (p.lines.length ?? 0) && (
                  <tr className="k-diff-line" data-kind="fold">
                    <td colSpan={3} className="p-0">
                      <div className="k-diff-wide"><button type="button" data-testid="diff-rest" onClick={() => setWhole(true)} className="k-diff-fold">{p.lines.length - shown} more lines</button></div>
                    </td>
                  </tr>
                )}
                {cut === "partial" && (
                  <tr><td colSpan={3} className="border-t border-line p-0 font-sans text-caption text-warn" data-testid="diff-partial"><div className="k-diff-wide px-3 py-1.5">The rest of this file's diff is cut to fit.{loadButton}</div></td></tr>
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
    <form className="flex flex-wrap items-center gap-2 font-sans" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAdd(text.trim()); else onClose(); }}>
      {side === "old" && <span className="shrink-0 rounded bg-danger-soft px-1.5 text-micro text-danger" title={`Removed line ${l.old}`}>removed line</span>}
      <input
        autoFocus
        data-testid="comment-input"
        aria-label={label}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape" && !text.trim()) onClose(); }}
        placeholder={side === "old" ? "What about this removed line?" : "What should change here?"}
        className="k-field min-w-[10rem] flex-1 text-caption"
      />
      <span className="ml-auto flex shrink-0 gap-2">
        <button type="submit" data-testid="comment-add" className="h-8 rounded-lg bg-accent px-3 text-caption font-medium text-accent-fg">Add</button>
        <button type="button" data-testid="comment-discard" onClick={onClose} className="h-8 rounded-lg px-2 text-caption text-muted hover:bg-hover">Discard</button>
      </span>
    </form>
  );
}

// A file's revert, said in words: the button reads "Revert" and names its file to a screen reader.
export function RevertButton({ path, onClick }: { path: string; onClick: () => void }) {
  return (
    <button type="button" data-testid="revert-file" aria-label={`Revert ${path}`} title={`Put ${path} back as it was before the session changed it`} onClick={onClick}
      className="inline-flex h-ctl-sm shrink-0 items-center gap-1 rounded-md px-1.5 font-sans text-micro font-medium text-muted hover:bg-danger-soft hover:text-danger">
      <Undo2 className="size-3" aria-hidden="true" />Revert
    </button>
  );
}

// The changed files as a list above their diffs: a path goes to its diff, `actions` stand at each row's end.
export function FileList({ files, onJump, actions }: { files: FileChange[]; onJump: (path: string) => void; actions?: (f: FileChange) => ReactNode }) {
  return (
    <ul className="mb-3 overflow-hidden rounded-xl border border-line bg-raised" data-testid="changes-files" aria-label="Changed files">
      {files.map((f) => {
        const st = STATUS[f.status[0]!] ?? { label: f.status, cls: "text-muted" };
        const slash = f.path.lastIndexOf("/");
        return (
          <li key={f.path} data-testid="changes-file" data-file={f.path} className="flex items-center gap-2 border-b border-line py-1 pl-1 pr-2 last:border-b-0">
            <button type="button" aria-label={`Show the diff of ${f.path}`} onClick={() => onJump(f.path)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover">
              <span className={cn("w-3 shrink-0 text-center font-mono text-micro font-semibold", st.cls)} title={st.label} aria-label={st.label}>{f.status[0]}</span>
              <span className="min-w-0 truncate font-mono text-caption">
                {slash > 0 && <span className="text-faint">{f.path.slice(0, slash + 1)}</span>}{f.path.slice(slash + 1)}
              </span>
              {f.outside && <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-micro text-warn" title="Changed outside the session's own tool calls">outside</span>}
              <span className="ml-auto shrink-0 font-mono text-micro tabular-nums">
                <span className="text-ok">+{f.added}</span> <span className="text-danger">-{f.removed}</span>
              </span>
            </button>
            {actions?.(f)}
          </li>
        );
      })}
    </ul>
  );
}
