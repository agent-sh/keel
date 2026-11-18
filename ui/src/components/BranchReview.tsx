import { GitBranch, MessageSquare, Send, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, onFeature, reportError } from "../lib/store.ts";
import { DiffView, type Comment, type FileChange } from "./DiffView.tsx";

type Branch = { is_git: boolean; branch: string | null; base: string | null; merge_base: string | null; commits: number; files: FileChange[]; diff: string; truncated: boolean };

// Review the session's branch: its diff over the merge base (uncommitted
// work included), comments on lines, and one message that sends them all
// to the model.
export function BranchReview({ sessionId, onSent }: { sessionId: string; onSent?: () => void }) {
  const [b, setB] = useState<Branch | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<Branch>(`/api/sessions/${sessionId}/changes/branch`).then(setB).catch((e) => { setErr(e.message); reportError(e); }), [sessionId]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if ((f.name === "checkpoints" || f.name === "worktree") && f.session_id === sessionId) load(); } });
  }, [load]);

  if (!b) return <p className="py-10 text-center text-ui text-faint">{err || "Loading…"}</p>;
  if (!b.is_git) return <p className="py-10 text-center text-ui text-faint">The session's folder is not in a git repository.</p>;

  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      await api(`/api/sessions/${sessionId}/review`, { method: "POST", body: JSON.stringify({ comments, note }) });
      setComments([]);
      setNote("");
      onSent?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="branch-review">
      <div className="flex items-center gap-2 text-ui text-muted">
        <GitBranch className="size-4 text-faint" />
        <span className="font-mono text-fg">{b.branch ?? "detached"}</span>
        {b.base && <span>over <span className="font-mono">{b.base}</span></span>}
        <span>· {b.commits} commit{b.commits === 1 ? "" : "s"}, {b.files.length} file{b.files.length === 1 ? "" : "s"}</span>
        {b.truncated && <span className="text-warn">· diff cut at 400 KB</span>}
        <span className="ml-auto text-caption text-faint">Hover a line number to comment</span>
      </div>
      <DiffView
        files={b.files}
        patch={b.diff}
        empty={b.base ? "The branch carries no changes over its base." : "No default branch to compare with."}
        comments={comments}
        onComment={(c) => setComments((l) => [...l, c])}
      />
      <div className="sticky bottom-0 rounded-xl border border-line bg-raised p-3 shadow-2">
        {comments.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1" data-testid="review-comments">
            {comments.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-caption">
                <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span className="font-mono text-faint">{c.path}:{c.line}</span>
                <span className="min-w-0 flex-1">{c.text}</span>
                <button onClick={() => setComments(comments.filter((_, j) => j !== i))} className="text-faint hover:text-danger" title="Remove"><X className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={1}
            placeholder="Overall note for the model (optional)"
            data-testid="review-note"
            className="min-h-8 flex-1 resize-none rounded-lg border border-line bg-bg px-2.5 py-1.5 text-ui outline-none focus:border-line-strong"
          />
          <button
            data-testid="review-send"
            disabled={busy || (!comments.length && !note.trim())}
            onClick={send}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
          >
            <Send className="size-3.5" /> Send {comments.length ? `${comments.length} comment${comments.length === 1 ? "" : "s"}` : "note"} to the model
          </button>
        </div>
        {err && <p className="mt-2 text-caption text-danger">{err}</p>}
      </div>
    </div>
  );
}
