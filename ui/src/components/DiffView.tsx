import { ChevronRight, MessageSquarePlus, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export type FileChange = { path: string; status: string; added: number; removed: number; outside?: boolean };
type Line = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number };
type FilePatch = { path: string; lines: Line[]; binary: boolean };

// Split a unified patch (git diff -p) into files and numbered lines.
export function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let o = 0;
  let n = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/(.*) b\/(.*)$/);
      cur = { path: m?.[2] ?? raw.slice(11), lines: [], binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("Binary files")) { cur.binary = true; continue; }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      o = Number(m?.[1] ?? 0);
      n = Number(m?.[2] ?? 0);
      cur.lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (/^(---|\+\+\+|index |new file|deleted file|old mode|new mode|similarity|rename )/.test(raw) && !cur.lines.length) continue;
    if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: raw.slice(1), new: n++ });
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: raw.slice(1), old: o++ });
    else if (raw.startsWith(" ")) cur.lines.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
  }
  return files;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: "added", cls: "text-ok" },
  D: { label: "deleted", cls: "text-danger" },
  M: { label: "modified", cls: "text-muted" },
};

export type Comment = { path: string; line: number; text: string };

// Files with their diffs. `actions` renders per-file buttons (revert);
// `onComment` turns line numbers into "add a comment" targets.
export function DiffView({
  files, patch, actions, comments, onComment, empty,
}: {
  files: FileChange[];
  patch: string;
  actions?: (f: FileChange) => ReactNode;
  comments?: Comment[];
  onComment?: (c: Comment) => void;
  empty?: string;
}) {
  const parsed = useMemo(() => new Map(parsePatch(patch).map((p) => [p.path, p])), [patch]);
  if (!files.length) return <p className="px-3 py-10 text-center text-ui text-faint">{empty ?? "No changes."}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="diff-view">
      {files.map((f) => (
        <FileBlock key={f.path} f={f} p={parsed.get(f.path)} actions={actions} comments={comments?.filter((c) => c.path === f.path)} onComment={onComment} />
      ))}
    </div>
  );
}

function FileBlock({ f, p, actions, comments, onComment }: {
  f: FileChange; p?: FilePatch; actions?: (f: FileChange) => ReactNode; comments?: Comment[]; onComment?: (c: Comment) => void;
}) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<{ line: number; text: string } | null>(null);
  const st = STATUS[f.status[0]!] ?? { label: f.status, cls: "text-muted" };
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-raised" data-testid="diff-file" data-path={f.path}>
      <header className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-1.5">
        <button onClick={() => setOpen(!open)} className="grid size-5 place-items-center rounded text-faint hover:text-fg" aria-label={open ? "Collapse" : "Expand"}>
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <span className="min-w-0 truncate font-mono text-caption">{f.path}</span>
        <span className={cn("text-micro", st.cls)}>{st.label}</span>
        {f.outside && <span className="rounded-full bg-warn/15 px-1.5 text-micro text-warn" title="Changed outside the session's turns">outside</span>}
        <span className="ml-auto font-mono text-micro tabular-nums">
          <span className="text-ok">+{f.added}</span> <span className="text-danger">-{f.removed}</span>
        </span>
        {actions?.(f)}
      </header>
      {open && (
        <div className="overflow-x-auto font-mono text-caption leading-[1.6]">
          {!p || p.binary ? (
            <p className="px-3 py-2 text-faint">{p?.binary ? "Binary file" : "No text change shown."}</p>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {p.lines.map((l, i) => {
                  const lineNo = l.new ?? l.old ?? 0;
                  const here = comments?.filter((c) => l.kind !== "del" && l.kind !== "hunk" && c.line === l.new) ?? [];
                  return [
                    <tr key={i} className={cn(
                      "group/line",
                      l.kind === "add" && "bg-ok/10",
                      l.kind === "del" && "bg-danger-soft/70",
                      l.kind === "hunk" && "bg-accent-soft/40 text-faint",
                    )}>
                      <td className="w-10 select-none px-2 text-right text-faint/80 tabular-nums">{l.kind === "hunk" ? "" : l.old ?? ""}</td>
                      <td className="relative w-10 select-none px-2 text-right text-faint/80 tabular-nums">
                        {l.kind === "hunk" ? "" : l.new ?? ""}
                        {onComment && l.kind !== "hunk" && l.kind !== "del" && (
                          <button
                            data-testid="comment-line"
                            title="Comment on this line"
                            onClick={() => setDraft({ line: lineNo, text: "" })}
                            className="absolute -right-2 top-0 grid size-[1.2rem] place-items-center rounded bg-accent text-accent-fg opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
                          >
                            <MessageSquarePlus className="size-3" />
                          </button>
                        )}
                      </td>
                      <td className="w-4 select-none pl-2 text-faint">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</td>
                      <td className="whitespace-pre pr-4">{l.text}</td>
                    </tr>,
                    ...here.map((c, j) => (
                      <tr key={`${i}-c${j}`}>
                        <td colSpan={4} className="px-3 py-1.5">
                          <div className="rounded-lg border border-accent/40 bg-accent-soft/40 px-3 py-1.5 font-sans text-caption" data-testid="line-comment">{c.text}</div>
                        </td>
                      </tr>
                    )),
                    draft && draft.line === lineNo && l.kind !== "del" && l.kind !== "hunk" ? (
                      <tr key={`${i}-draft`}>
                        <td colSpan={4} className="px-3 py-1.5">
                          <form
                            className="flex gap-2 font-sans"
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (draft.text.trim()) onComment?.({ path: f.path, line: draft.line, text: draft.text.trim() });
                              setDraft(null);
                            }}
                          >
                            <input
                              autoFocus
                              data-testid="comment-input"
                              value={draft.text}
                              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Escape") setDraft(null); }}
                              placeholder="What should change here?"
                              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-caption outline-none focus:border-line-strong"
                            />
                            <button type="submit" data-testid="comment-add" className="h-8 rounded-lg bg-accent px-3 text-caption font-medium text-accent-fg">Add</button>
                          </form>
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

export function RevertButton({ onClick, title = "Revert this file" }: { onClick: () => void; title?: string }) {
  return (
    <button data-testid="revert-file" title={title} onClick={onClick} className="grid size-6 place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger">
      <Undo2 className="size-3.5" />
    </button>
  );
}
