import { Check, CircleAlert, Loader2, ScanSearch, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Finding, Review } from "../../../src/safety/review.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { Segmented } from "./Settings.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

const PRIORITY = ["P0", "P1", "P2", "P3"];
const PCLS = ["bg-danger text-accent-fg", "bg-danger-soft text-danger", "bg-warn/15 text-warn", "bg-sunken text-muted"];

// The independent reviewer in the Review panel: start a review of the
// session's change on a model the owner picks, read its findings, send the
// chosen ones to the working model or dismiss them.
export function ReviewFindings({ session }: { session: Session }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [scope, setScope] = useState<Review["scope"]>("uncommitted");
  const [kind, setKind] = useState<Review["kind"]>("code");
  const [model, setModel] = useState<string>("");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<{ reviews: Review[] }>(`/api/sessions/${session.id}/reviews`).then((r) => setReviews(r.reviews)).catch(reportError), [session.id]);
  useEffect(() => {
    load();
    api<{ model: string | null }>("/api/reviews/settings").then((r) => setModel((m) => m || r.model || session.model)).catch(reportError);
    return onFeature({ frame: (f) => { if (f.name === "reviews" && f.session_id === session.id) setReviews((l) => [...l.filter((r) => r.id !== f.data.id), f.data].sort((a, b) => a.created - b.created)); } });
  }, [load]);

  const start = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ review: Review; skipped: boolean; note?: string }>(`/api/sessions/${session.id}/reviews`, { method: "POST", body: JSON.stringify({ scope, kind, model, focus: focus.trim() || undefined }) });
      if (r.skipped) setErr(r.note ?? "This change was reviewed already.");
      setReviews((l) => [...l.filter((x) => x.id !== r.review.id), r.review]);
    } catch (e) {
      setErr(failed(e, { at: "ReviewFindings" }));
    } finally {
      setBusy(false);
    }
  };
  const latest = [...reviews].reverse();

  return (
    <section className="rounded-xl border border-line bg-raised p-3" data-testid="reviewer">
      <div className="flex items-center gap-2 px-0.5">
        <ScanSearch className="size-4 text-accent" />
        <h3 className="text-ui font-medium">Independent review</h3>
        <span className="text-caption text-faint">a read-only reviewer with its own context</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Segmented label="What to review" value={scope} onChange={setScope} options={[{ value: "uncommitted", label: "Uncommitted" }, { value: "branch", label: "Branch" }, { value: "commit", label: "Last commit" }]} />
        <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: "code", label: "Bugs" }, { value: "security", label: "Security" }]} />
        <div className="flex items-center gap-1 text-caption text-faint" data-testid="review-model">on <ModelPicker value={model || session.model} onChange={(m) => { setModel(m); api("/api/reviews/settings", { method: "PUT", body: JSON.stringify({ model: m }) }).catch(reportError); }} compact /></div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Focus (optional): what to look at hardest"
          data-testid="review-focus"
          className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 text-ui outline-none placeholder:text-faint focus:border-line-strong"
        />
        <button data-testid="review-start" disabled={busy} onClick={start} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ScanSearch className="size-3.5" />} Review
        </button>
      </div>
      {err && <p className="mt-2 text-caption text-warn" data-testid="review-note-err">{err}</p>}
      <div className="mt-3 flex flex-col gap-3">
        {latest.slice(0, 5).map((r) => <ReviewCard key={r.id} r={r} sessionId={session.id} />)}
      </div>
    </section>
  );
}

function ReviewCard({ r, sessionId }: { r: Review; sessionId: string }) {
  const open = r.findings.filter((f) => f.state === "open");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  useEffect(() => setPicked(new Set(open.map((f) => f.id))), [r.id, r.findings.map((f) => f.state).join()]);
  const [err, setErr] = useState("");
  const act = async (action: "fix" | "dismiss" | "reopen", ids: number[]) => {
    setErr("");
    try { await api(`/api/sessions/${sessionId}/reviews/${r.id}/findings`, { method: "POST", body: JSON.stringify({ action, ids }) }); } catch (e) { setErr(failed(e, { at: "ReviewFindings" })); }
  };
  const what = r.scope === "uncommitted" ? "uncommitted work" : r.scope === "branch" ? `branch over ${r.target}` : `commit ${r.target}`;
  const whose = r.agent_id ? "an agent's " : "";
  return (
    <div className="rounded-lg border border-line bg-bg" data-testid="review" data-state={r.state}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-caption">
        {r.state === "running" ? <Loader2 className="size-3.5 animate-spin text-accent" /> : r.state === "failed" ? <CircleAlert className="size-3.5 text-danger" /> : <Check className="size-3.5 text-ok" />}
        <span className="font-medium">{r.kind === "security" ? "Security review" : "Review"} of {whose}{what}</span>
        <span className="text-faint">· {r.files} file{r.files === 1 ? "" : "s"} · {r.model.split(":").pop()}</span>
        {r.state === "done" && r.verdict && <span className={cn("ml-auto rounded-full px-2 py-0.5 text-micro font-medium", r.verdict === "correct" ? "bg-ok/15 text-ok" : "bg-danger-soft text-danger")}>{r.verdict === "correct" ? "looks correct" : "has problems"}</span>}
        {r.state === "running" && (
          <button className="ml-auto inline-flex items-center gap-1 text-faint hover:text-danger" title="Stop the review" onClick={() => api(`/api/sessions/${sessionId}/reviews/${r.id}`, { method: "DELETE" }).catch(reportError)}>
            <Square className="size-3" /> Stop
          </button>
        )}
      </div>
      {r.state === "failed" && <p className="px-3 py-2 text-caption text-danger">{r.error}</p>}
      {r.state === "running" && <p className="px-3 py-2 text-caption text-muted">The reviewer is reading the change.</p>}
      {r.summary && <p className="px-3 pt-2 text-caption text-muted">{r.summary}</p>}
      {!!r.reading_order?.length && (
        <details className="px-3 pt-2 text-caption" data-testid="reading-order">
          <summary className="cursor-pointer text-muted">Reading order ({r.reading_order.length})</summary>
          <ol className="mt-1 list-decimal pl-5 text-muted">
            {r.reading_order.map((x, i) => <li key={i}><span className="font-mono text-fg">{x.section}</span>{x.why ? `: ${x.why}` : ""}</li>)}
          </ol>
        </details>
      )}
      {r.state === "done" && !r.findings.length && <p className="px-3 py-2 text-caption text-muted">No findings.</p>}
      {r.findings.length > 0 && (
        <ul className="flex flex-col py-1" data-testid="findings">
          {r.findings.map((f) => <FindingRow key={f.id} f={f} checked={picked.has(f.id)} onCheck={(v) => setPicked((s) => { const n = new Set(s); v ? n.add(f.id) : n.delete(f.id); return n; })} onReopen={() => act("reopen", [f.id])} />)}
        </ul>
      )}
      {open.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-line px-3 py-2">
          <button data-testid="findings-fix" disabled={!picked.size} onClick={() => act("fix", [...picked])} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">
            <Send className="size-3" /> Send {picked.size} to {r.agent_id ? "the agent" : "the model"}
          </button>
          <button data-testid="findings-dismiss" disabled={!picked.size} onClick={() => act("dismiss", [...picked])} className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
            <X className="size-3" /> Dismiss
          </button>
          {err && <span className="ml-auto text-micro text-danger">{err}</span>}
        </div>
      )}
    </div>
  );
}

function FindingRow({ f, checked, onCheck, onReopen }: { f: Finding; checked: boolean; onCheck: (v: boolean) => void; onReopen: () => void }) {
  const jump = () => document.querySelector(`[data-testid="branch-review"] [data-path="${CSS.escape(f.file)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <li className={cn("flex items-start gap-2.5 px-3 py-1.5", f.state !== "open" && "opacity-60")} data-testid="finding" data-state={f.state}>
      {f.state === "open" ? (
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} className="mt-1 size-3.5 accent-[var(--color-accent)]" aria-label={`Pick ${f.title}`} />
      ) : (
        <button onClick={onReopen} className="mt-0.5 text-micro text-faint hover:text-fg" title="Open it again">{f.state === "fix_requested" ? "sent" : "dismissed"}</button>
      )}
      <span className={cn("mt-0.5 shrink-0 rounded px-1 font-mono text-micro font-medium", PCLS[f.priority])}>{PRIORITY[f.priority]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-caption font-medium">{f.title}</div>
        <button onClick={jump} className="font-mono text-micro text-faint hover:text-accent">{f.file}:{f.line}{f.end_line ? `-${f.end_line}` : ""}</button>
        {f.body && <p className="mt-0.5 text-caption text-muted whitespace-pre-wrap">{f.body}</p>}
      </div>
    </li>
  );
}
