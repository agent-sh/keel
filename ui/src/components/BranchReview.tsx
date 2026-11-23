import { GitBranch, MessageSquare, RefreshCw, Send, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, onFeature, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { DiffView, parsePatch, type Comment, type FileChange } from "./DiffView.tsx";
import { ReviewFindings } from "./ReviewFindings.tsx";

type Branch = { is_git: boolean; missing?: boolean; branch: string | null; base: string | null; merge_base: string | null; commits: number; files: FileChange[]; diff: string; truncated: boolean; partial?: string };

// Unsent feedback per session, kept in this browser the way the message box
// keeps its text: closing the panel, switching to Changes or reloading the
// page keeps it; another session never sees it.
type ReviewDraft = { comments: Comment[]; note: string };
const draftKey = (id: string) => `keel.review-draft.${id}`;
function loadDraft(id: string): ReviewDraft | null {
  try {
    const v = JSON.parse(localStorage.getItem(draftKey(id)) ?? "null");
    return v && Array.isArray(v.comments) && typeof v.note === "string" ? v : null;
  } catch { return null; }
}

// A refreshed diff moves lines: each comment stays on the text it was written
// on (same side and number, else the one line with that text), or is marked
// outdated rather than landing on another line.
function reconcile(comments: Comment[], patch: string): Comment[] {
  const files = new Map(parsePatch(patch).map((p) => [p.path, p]));
  return comments.map((c) => {
    const lines = (files.get(c.path)?.lines ?? []).filter((l) => l.kind !== "hunk" && (c.side === "old" ? l.kind === "del" : l.kind !== "del"));
    const num = (l: (typeof lines)[0]) => (c.side === "old" ? l.old : l.new);
    if (lines.some((l) => num(l) === c.line && l.text === c.quote)) return c.outdated ? { ...c, outdated: false } : c;
    const same = lines.filter((l) => l.text === c.quote);
    return same.length === 1 ? { ...c, line: num(same[0]!)!, outdated: false } : { ...c, outdated: true };
  });
}

// Review the session's branch: its diff over the merge base (uncommitted
// work included), comments on lines, and one message that sends them all
// to the model.
export function BranchReview({ session }: { session: Session }) {
  const sessionId = session.id;
  const [b, setB] = useState<Branch | null>(null);
  const [saved] = useState(() => loadDraft(sessionId));
  const [comments, setComments] = useState<Comment[]>(saved?.comments ?? []);
  const [note, setNote] = useState(saved?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [sendErr, setSendErr] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (comments.length || note) localStorage.setItem(draftKey(sessionId), JSON.stringify({ comments, note }));
    else localStorage.removeItem(draftKey(sessionId));
  }, [sessionId, comments, note]);

  // Only the newest read lands: a slow answer from before a park or a
  // restore never replaces the one that came after it.
  const load = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const r = await api<Branch>(`/api/sessions/${sessionId}/changes/branch`);
      if (n !== seq.current) return;
      setB(r);
      setLoadErr("");
      setComments((l) => (l.length ? reconcile(l, r.diff) : l));
    } catch (e) {
      if (n === seq.current) setLoadErr(failed(e, { at: "BranchReview load" }));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [sessionId]);
  // A turn that ends may have changed files: read again on the move to idle.
  const phase = useRef(session.phase);
  useEffect(() => {
    const was = phase.current;
    phase.current = session.phase;
    if (session.phase === "idle" && was !== "idle") load();
  }, [session.phase, load]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if ((f.name === "checkpoints" || f.name === "worktree") && f.session_id === sessionId) load(); }, reconnect: load });
  }, [load]);

  const refresh = (
    <button data-testid="branch-refresh" onClick={load} disabled={loading} title="Read the branch again (edits made outside Keel too)"
      className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
      <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> {b ? "Refresh" : "Retry"}
    </button>
  );
  if (!b) {
    return (
      <div className="k-empty px-3 py-4">
        <p data-testid="branch-load-error">{loadErr || "Loading…"}</p>
        {loadErr && <div className="k-empty-act">{refresh}</div>}
      </div>
    );
  }
  if (b.missing) return <p className="k-empty px-3 py-4">The worktree is parked: its folder is off disk. Restore it from the branch menu in the header.</p>;
  if (!b.is_git) return <p className="k-empty px-3 py-4">The session's folder is not in a git repository.</p>;

  // What was sent is cleared once acknowledged; anything written since stays.
  const send = async () => {
    const sent = comments;
    const sentNote = note;
    setBusy(true);
    setSendErr("");
    try {
      await api(`/api/sessions/${sessionId}/review`, { method: "POST", body: JSON.stringify({ comments: sent, note: sentNote }) });
      const ids = new Set(sent.map((c) => c.id));
      setComments((l) => l.filter((c) => !ids.has(c.id)));
      setNote((n) => (n === sentNote ? "" : n));
    } catch (e) {
      setSendErr(failed(e, { at: "BranchReview" }));
    } finally {
      setBusy(false);
    }
  };
  const hasDraft = comments.length > 0 || !!note.trim();
  const fileDiff = async (path: string) => (await api<Branch>(`/api/sessions/${sessionId}/changes/branch?path=${encodeURIComponent(path)}`)).diff;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="branch-review">
      <ReviewFindings session={session} />
      <div className="flex items-start gap-2 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2 text-ui">
            <GitBranch className="size-4 shrink-0 text-faint" />
            <span className="truncate font-mono">{b.branch ?? "detached"}</span>
          </div>
          <p className="text-caption text-muted">
            {b.base && <>over <span className="font-mono">{b.base}</span> · </>}
            {b.commits} commit{b.commits === 1 ? "" : "s"}, {b.files.length} file{b.files.length === 1 ? "" : "s"}
            {b.truncated && <span className="text-warn" data-testid="branch-truncated"> · diff cut at 400 KB</span>}
          </p>
          <p className="text-caption text-faint" data-testid="review-keys">
            <span className="[@media(hover:none)]:hidden">Hover or Tab to a line to comment. Arrows move, Page Up/Down jump hunks.</span>
            <span className="hidden [@media(hover:none)]:inline">Tap the mark beside a line's number to comment on it.</span>
          </p>
        </div>
        {refresh}
      </div>
      {loadErr && <p className="rounded-lg bg-warn/10 px-3 py-1.5 text-caption text-warn" data-testid="branch-stale">This is the last diff read; reading it again failed: {loadErr}</p>}
      <DiffView
        files={b.files}
        patch={b.diff}
        truncated={b.truncated}
        partial={b.partial}
        loadFile={fileDiff}
        empty={b.base ? "The branch carries no changes over its base." : "No default branch to compare with."}
        comments={comments}
        onComment={(c) => setComments((l) => [...l, { ...c, id: crypto.randomUUID() }])}
      />
      <div className="sticky bottom-0 rounded-xl border border-line bg-raised p-3 shadow-2">
        {hasDraft && (
          <div className="mb-2 flex items-center gap-2 text-micro" data-testid="review-draft">
            <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">Draft</span>
            <span className="text-faint">not sent yet</span>
            <button data-testid="review-discard" onClick={() => { setComments([]); setNote(""); }} className="ml-auto text-faint hover:text-danger">Discard draft</button>
          </div>
        )}
        {comments.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1" data-testid="review-comments">
            {comments.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-caption" data-outdated={c.outdated ? "" : undefined}>
                <MessageSquare className={cn("mt-0.5 size-3.5 shrink-0", c.outdated ? "text-warn" : "text-accent")} />
                <span className="font-mono text-faint">{c.path}:{c.side === "old" ? `removed ${c.line}` : c.line}</span>
                {c.outdated && <span className="rounded bg-warn/15 px-1 text-micro text-warn" title={`It was on: ${c.quote}`}>line changed</span>}
                <span className="min-w-0 flex-1">{c.text}</span>
                <button onClick={() => setComments((l) => l.filter((x) => x.id !== c.id))} className="text-faint hover:text-danger" title="Remove"><X className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end justify-end gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={1}
            placeholder="Overall note for the model (optional)"
            data-testid="review-note"
            className="k-field h-auto min-h-8 min-w-[14rem] flex-1 resize-none py-1.5"
          />
          <button
            data-testid="review-send"
            disabled={busy || (!comments.length && !note.trim())}
            onClick={send}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
          >
            <Send className="size-3.5" /> Send {comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "note"} to the model
          </button>
        </div>
        {sendErr && <p className="mt-2 text-caption text-danger" data-testid="review-send-error">{sendErr}</p>}
      </div>
    </div>
  );
}
