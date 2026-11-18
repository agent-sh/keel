import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type KeyboardEvent } from "react";
import type { BoardRow, BoardState } from "../../../src/server/routes/board.ts";
import { markSeen, seenAt } from "../lib/board.ts";
import { actions, api, onFeature, reportError, useStore } from "../lib/store.ts";
import { navigate, useUI } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { SidebarButton } from "./SessionHeader.tsx";

const Approvals = lazy(() => import("./ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));

const COLUMNS: { id: BoardState; label: string; empty: string }[] = [
  { id: "needs", label: "Needs you", empty: "Nothing waits for you." },
  { id: "working", label: "Working", empty: "No session is working." },
  { id: "done", label: "Done", empty: "No finished sessions yet." },
];
const DONE_SHOWN = 30;

// Sessions as columns by what they need: an approval, an answer or a failed
// turn first, then the ones working, then the finished ones. Arrows move,
// Enter opens, Space peeks (latest output, the approval, a reply box).
export function Board() {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<{ col: number; idx: number }>({ col: 0, idx: 0 });
  const [peek, setPeek] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);
  const sessions = useStore((s) => s.sessions);
  const grid = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<{ rows: BoardRow[] }>("/api/board").then((r) => { setRows(r.rows); setError(""); }).catch((e) => { setError((e as Error).message); reportError(e, { at: "board" }); });
  }, []);
  // Live: a session or approval change reloads (coalesced); a working row's
  // latest step is read again every few seconds.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(load, 300); }, [load]);
  useEffect(() => { soon(); }, [sessions, soon]);
  useEffect(() => onFeature({ frame: (f) => { if (f.name === "approval" || f.name === "approvals" || f.name === "question") soon(); }, reconnect: load }), [soon, load]);
  const working = rows?.some((r) => r.state === "working");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [working, load]);
  useEffect(() => { document.title = "Board - Keel"; }, []);

  const cols = useMemo(() => COLUMNS.map((c) => {
    const list = (rows ?? []).filter((r) => r.state === c.id);
    return c.id === "done" && !allDone ? list.slice(0, DONE_SHOWN) : list;
  }), [rows, allDone]);
  const doneTotal = rows?.filter((r) => r.state === "done").length ?? 0;
  const counts = COLUMNS.map((c) => rows?.filter((r) => r.state === c.id).length ?? 0);

  // Keep the selection on a card that exists.
  const at = (col: number, idx: number) => cols[col]?.[Math.min(idx, (cols[col]?.length ?? 1) - 1)];
  const current = at(sel.col, sel.idx);
  useEffect(() => {
    if (!rows || current) return;
    const col = cols.findIndex((c) => c.length > 0);
    if (col >= 0) setSel({ col, idx: 0 });
  }, [rows, current, cols]);
  useEffect(() => {
    if (!current) return;
    grid.current?.querySelector<HTMLElement>(`[data-card="${current.id}"]`)?.focus({ preventScroll: false });
  }, [current?.id]);

  const open = (id: string) => { markSeen(id); navigate({ name: "session", id }); };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, [data-peek]")) return;
    const move = (col: number, idx: number) => { e.preventDefault(); setSel({ col, idx }); };
    const n = cols[sel.col]?.length ?? 0;
    if (e.key === "ArrowDown" || e.key === "j") return move(sel.col, Math.min(sel.idx + 1, n - 1));
    if (e.key === "ArrowUp" || e.key === "k") return move(sel.col, Math.max(sel.idx - 1, 0));
    const side = (d: number) => {
      for (let c = sel.col + d; c >= 0 && c < cols.length; c += d) if (cols[c]!.length) return move(c, Math.min(sel.idx, cols[c]!.length - 1));
    };
    if (e.key === "ArrowRight" || e.key === "l") return side(1);
    if (e.key === "ArrowLeft" || e.key === "h") return side(-1);
    if (!current) return;
    if (e.key === "Enter") { e.preventDefault(); open(current.id); }
    if (e.key === " ") { e.preventDefault(); setPeek(peek === current.id ? null : current.id); }
    if (e.key === "Escape" && peek) { e.preventDefault(); setPeek(null); }
  };

  const peeked = rows?.find((r) => r.id === peek);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="board">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-2 md:px-4">
        <SidebarButton />
        <h1 className="text-base font-medium">Board</h1>
        <span className="text-caption text-faint" data-testid="board-counts" aria-live="polite">
          {rows ? `${counts[0]} ${counts[0] === 1 ? "needs" : "need"} you, ${counts[1]} working, ${counts[2]} done` : ""}
        </span>
      </header>
      <Dispatch onStarted={soon} />
      {error && !rows && (
        <div className="m-4 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-ui text-danger" role="alert">
          The board did not load: {error}. <button type="button" className="underline" onClick={load}>Try again</button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div ref={grid} className="grid min-h-0 min-w-0 flex-1 grid-cols-1 auto-rows-min gap-4 overflow-y-auto p-3 md:auto-rows-auto md:grid-cols-3 md:p-4" onKeyDown={onKey}>
          {COLUMNS.map((c, ci) => (
            <section key={c.id} className="flex min-h-0 min-w-0 flex-col gap-2" data-testid={`board-col-${c.id}`} aria-label={c.label}>
              <h2 className="flex items-center gap-2 px-1 text-caption font-medium text-muted">
                {c.label}
                <span className="tabular-nums text-faint">{counts[ci]}</span>
              </h2>
              {!rows ? (
                <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-caption text-faint">Loading</div>
              ) : cols[ci]!.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-caption text-faint">{c.empty}</div>
              ) : (
                <div className="flex flex-col gap-2 md:min-h-0 md:overflow-y-auto">
                  {cols[ci]!.map((r, i) => (
                    <Card
                      key={r.id}
                      row={r}
                      selected={sel.col === ci && sel.idx === i}
                      unseen={r.state !== "working" && r.turns > 0 && r.updated > seenAt(r.id) && !!sessions[r.id]}
                      onSelect={() => setSel({ col: ci, idx: i })}
                      onOpen={() => open(r.id)}
                      onPeek={() => setPeek(peek === r.id ? null : r.id)}
                    />
                  ))}
                  {c.id === "done" && doneTotal > DONE_SHOWN && (
                    <button type="button" onClick={() => setAllDone(!allDone)} className="h-8 rounded-md text-caption text-faint hover:bg-hover hover:text-muted">
                      {allDone ? "Show fewer" : `${doneTotal - DONE_SHOWN} more`}
                    </button>
                  )}
                </div>
              )}
            </section>
          ))}
          {rows && rows.length > 0 && (
            <p className="hidden text-caption text-faint md:col-span-3 md:block pointer-coarse:hidden">Arrows move, Enter opens, Space peeks.</p>
          )}
        </div>
        {peeked && <Peek row={peeked} onClose={() => { setPeek(null); grid.current?.querySelector<HTMLElement>(`[data-card="${peeked.id}"]`)?.focus(); }} onOpen={() => open(peeked.id)} />}
      </div>
    </div>
  );
}

const STATE_DOT: Record<BoardState, string> = { needs: "bg-warn", working: "bg-brass animate-pulse-dot", done: "bg-ok" };

function Card({ row, selected, unseen, onSelect, onOpen, onPeek }: { row: BoardRow; selected: boolean; unseen: boolean; onSelect: () => void; onOpen: () => void; onPeek: () => void }) {
  const line = row.needs?.text ?? row.activity?.text ?? (row.turns ? "" : "No messages yet");
  return (
    <div
      role="button"
      tabIndex={selected ? 0 : -1}
      data-card={row.id}
      data-testid="board-card"
      data-state={row.state}
      aria-label={`${row.title || "New session"}, ${row.state === "needs" ? "needs you" : row.state}`}
      onFocus={onSelect}
      onClick={onOpen}
      className={cn(
        "group flex min-w-0 flex-col gap-1 rounded-lg border bg-raised px-3 py-2.5 text-left outline-none",
        selected ? "border-line-strong" : "border-line hover:border-line-strong",
        "focus-visible:ring-2 focus-visible:ring-ring",
        row.state === "needs" && "border-warn/50",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[row.state])} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{row.title || "New session"}</span>
        {unseen && <span className="shrink-0 text-micro font-medium text-accent" data-testid="board-unseen">new</span>}
        <span className="shrink-0 text-micro tabular-nums text-faint" title={when(row.updated)}>{ago(row.updated)}</span>
      </div>
      {line && (
        <p className={cn("line-clamp-2 text-caption", row.needs ? "text-fg" : "text-muted", row.activity?.kind === "tool" && !row.needs && "font-mono")} data-testid="board-line">
          {line}
        </p>
      )}
      <div className="flex items-center gap-2 text-micro text-faint">
        <span className="truncate">{row.workspace.split("/").pop()}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPeek(); }}
          className="ml-auto rounded-sm px-1.5 py-0.5 hover:bg-hover hover:text-fg"
          data-testid="board-peek"
        >
          Peek
        </button>
      </div>
    </div>
  );
}

// The latest of a session without leaving the board: what it waits on (with
// the approval card itself), its last reply, and a box to answer.
function Peek({ row, onClose, onOpen }: { row: BoardRow; onClose: () => void; onOpen: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(""); setErr(""); setSent(false); box.current?.focus(); }, [row.id]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      await actions.send(row.id, t);
      setText("");
      setSent(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <aside
      data-peek
      data-testid="board-peek-panel"
      aria-label={`Peek: ${row.title}`}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      className="flex w-full max-w-[30rem] shrink-0 flex-col border-l border-line bg-panel max-md:fixed max-md:inset-0 max-md:z-40 max-md:max-w-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{row.title || "New session"}</span>
        <button type="button" onClick={onOpen} className="h-7 rounded-md px-2 text-caption text-accent hover:bg-hover" data-testid="peek-open">Open</button>
        <button type="button" onClick={onClose} className="h-7 rounded-md px-2 text-caption text-muted hover:bg-hover" aria-label="Close the peek">Close</button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {row.needs && <p className="text-ui text-fg">{row.needs.text}</p>}
        {row.needs?.kind === "approval" && <Suspense fallback={null}><Approvals sessionId={row.id} /></Suspense>}
        {row.activity && (
          <div className="text-caption text-muted">
            <div className="mb-1 text-micro text-faint">{row.activity.kind === "tool" ? "Last step" : row.activity.kind === "reply" ? "Last reply" : row.activity.kind === "error" ? "Failed" : "Last prompt"}, {when(row.activity.ts)}</div>
            <p className={cn("whitespace-pre-wrap", row.activity.kind === "tool" && "font-mono")}>{row.activity.text}</p>
          </div>
        )}
      </div>
      <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={box}
          rows={2}
          value={text}
          onChange={(e) => { setText(e.target.value); setSent(false); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={row.state === "working" ? "Steer it, Enter sends" : "Reply, Enter sends"}
          aria-label="Reply"
          data-testid="peek-reply"
          className="w-full resize-none rounded-md border border-line bg-raised px-3 py-2 text-ui outline-none placeholder:text-faint focus:border-line-strong"
        />
        <div className="mt-1 h-4 text-micro" aria-live="polite">
          {err ? <span className="text-danger">{err}</span> : sent ? <span className="text-faint">Sent.</span> : null}
        </div>
      </form>
    </aside>
  );
}

// The dispatch box: a new session on a task, started without leaving the board.
function Dispatch({ onStarted }: { onStarted: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const workspace = useUI((s) => s.newWorkspace);
  const model = useUI((s) => s.newModel);
  const start = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr("");
    try {
      await actions.create(t, model || undefined, workspace || undefined, []);
      setText("");
      onStarted();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="flex items-center gap-2 border-b border-line px-3 py-2 md:px-4" onSubmit={(e) => { e.preventDefault(); start(); }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Start a task${workspace ? ` in ${workspace.split("/").pop()}` : ""}, Enter starts it here`}
        aria-label="Start a task"
        data-testid="board-dispatch"
        className="h-8 min-w-0 flex-1 rounded-md border border-line bg-raised px-3 text-ui outline-none placeholder:text-faint focus:border-line-strong"
      />
      {err && <span className="text-caption text-danger" role="alert">{err}</span>}
    </form>
  );
}
