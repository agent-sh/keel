import { Check, CircleAlert, CircleStop, Loader2, ScanSearch, Send, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Finding, Review } from "../../../src/safety/review.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { cn, scrollMotion } from "../lib/utils.ts";
import { JUMP, type JumpDetail } from "./DiffView.tsx";
import { Segmented } from "./Settings.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

const PCLS: Record<string, string> = { P0: "bg-danger text-accent-fg", P1: "bg-danger-soft text-danger", P2: "bg-warn/15 text-warn", P3: "bg-sunken text-muted", unrated: "border border-line text-faint" };
const RECENT = 5;
const priorityLabel = (p: Finding["priority"]) => (p === null ? "unrated" : `P${p}`);
const byCreated = (l: Review[]) => [...l].sort((a, b) => a.created - b.created);

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
  // The review a "reviewed already" answer points at, shown wherever it is in the history.
  const [existing, setExisting] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const [older, setOlder] = useState(false);

  const load = useCallback(() => api<{ reviews: Review[] }>(`/api/sessions/${session.id}/reviews`).then((r) => setReviews(byCreated(r.reviews))).catch(reportError), [session.id]);
  useEffect(() => {
    load();
    api<{ model: string | null }>("/api/reviews/settings").then((r) => setModel((m) => m || r.model || session.model)).catch(reportError);
    return onFeature({ frame: (f) => { if (f.name === "reviews" && f.session_id === session.id) setReviews((l) => byCreated([...l.filter((r) => r.id !== f.data.id), f.data])); } });
  }, [load]);

  const start = async () => {
    setBusy(true);
    setErr("");
    setExisting(null);
    try {
      const r = await api<{ review: Review; skipped: boolean; note?: string }>(`/api/sessions/${session.id}/reviews`, { method: "POST", body: JSON.stringify({ scope, kind, model, focus: focus.trim() || undefined }) });
      // A reused review keeps its place in the history (it is not the newest).
      setReviews((l) => byCreated([...l.filter((x) => x.id !== r.review.id), r.review]));
      if (r.skipped) { setErr(r.note ?? "This change was reviewed already."); setExisting(r.review.id); }
    } catch (e) {
      setErr(failed(e, { at: "ReviewFindings" }));
    } finally {
      setBusy(false);
    }
  };
  const openExisting = () => {
    if (!existing) return;
    if (!reviews.slice(-RECENT).some((r) => r.id === existing)) setOlder(true);
    setLit(existing);
    requestAnimationFrame(() => document.querySelector(`[data-review-id="${CSS.escape(existing)}"]`)?.scrollIntoView({ behavior: scrollMotion(), block: "nearest" }));
  };
  const latest = [...reviews].reverse();
  const shown = older ? latest : latest.slice(0, RECENT);
  const hidden = latest.slice(RECENT);
  const hiddenOpen = hidden.reduce((n, r) => n + (r.state === "done" ? r.findings.filter((f) => f.state === "open").length : 0), 0);

  return (
    <section className="k-reviewer rounded-xl border border-line bg-raised p-3" data-testid="reviewer">
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
      {err && (
        <p className="mt-2 flex items-center gap-2 text-caption text-warn" data-testid="review-note-err">
          {err}
          {existing && <button data-testid="review-open-existing" onClick={openExisting} className="font-medium text-accent hover:underline">Open that review</button>}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-3">
        {shown.map((r) => <ReviewCard key={r.id} r={r} sessionId={session.id} lit={lit === r.id} />)}
      </div>
      {hidden.length > 0 && (
        <button data-testid="reviews-older" onClick={() => setOlder(!older)} className="mt-2 text-caption text-muted hover:text-fg">
          {older ? "Show the recent reviews only" : `${hidden.length} older review${hidden.length === 1 ? "" : "s"}`}
          {!older && hiddenOpen > 0 && <span className="ml-1 font-medium text-warn">with {hiddenOpen} open finding{hiddenOpen === 1 ? "" : "s"}</span>}
        </button>
      )}
    </section>
  );
}

function ReviewCard({ r, sessionId, lit }: { r: Review; sessionId: string; lit: boolean }) {
  const open = r.findings.filter((f) => f.state === "open");
  const openKey = open.map((f) => f.id).join();
  // Every open finding is picked when the review arrives; after that only the
  // owner's checks change the pick (a finding that closes leaves it).
  const [picked, setPicked] = useState<Set<number>>(() => new Set(open.map((f) => f.id)));
  const seeded = useRef(r.state === "done");
  useEffect(() => {
    if (!seeded.current && r.state === "done") { seeded.current = true; setPicked(new Set(open.map((f) => f.id))); return; }
    setPicked((s) => new Set([...s].filter((id) => open.some((f) => f.id === id))));
  }, [r.state, openKey]);
  const [err, setErr] = useState("");
  const [gone, setGone] = useState(false);
  const [pending, setPending] = useState(false);
  const act = async (action: "fix" | "dismiss" | "reopen", ids: number[], to?: "session") => {
    if (pending) return;
    setErr("");
    setPending(true);
    try {
      await api(`/api/sessions/${sessionId}/reviews/${r.id}/findings`, { method: "POST", body: JSON.stringify({ action, ids, to }) });
      setGone(false);
    } catch (e) {
      setGone(!!(e as any).body?.agent_gone);
      setErr(failed(e, { at: "ReviewFindings" }));
    } finally {
      setPending(false);
    }
  };
  const what = r.scope === "uncommitted" ? "uncommitted work" : r.scope === "branch" ? `branch over ${r.target}` : `commit ${r.target}`;
  // Which agent's work, by name and branch (and a short id: two may share a title).
  const agent = r.agent_id ? (r.agent_title ?? "an agent") : null;
  const recipient = agent ?? "the model";
  return (
    <div className={cn("k-review rounded-lg border border-line bg-bg transition-shadow", lit && "ring-2 ring-accent/40")} data-testid="review" data-state={r.state} data-review-id={r.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line px-3 py-2 text-caption">
        {r.state === "running" ? <Loader2 className="size-3.5 animate-spin text-accent" /> : r.state === "failed" ? <CircleAlert className="size-3.5 text-danger" /> : r.state === "stopped" ? <CircleStop className="size-3.5 text-faint" /> : <Check className="size-3.5 text-ok" />}
        <span className="font-medium">
          {r.kind === "security" ? "Security review" : "Review"} of {agent ? <>{agent}'s </> : ""}{what}
        </span>
        {r.agent_id && (
          <span className="font-mono text-micro text-faint" data-testid="review-agent" title={`agent ${r.agent_id}`}>
            {r.agent_branch ? `${r.agent_branch} · ` : ""}{r.agent_id.slice(0, 6)}
          </span>
        )}
        <span className="text-faint">· {r.files} file{r.files === 1 ? "" : "s"} · {r.model.split(":").pop()}</span>
        {r.state !== "running" && r.state !== "stopped" && (
          <span className={cn("text-micro", r.cut ? "text-warn" : "text-faint")} data-testid="review-coverage" title={r.cut ? "The diff given to the reviewer was cut to fit; it was told to read the files for the rest" : "The reviewer got the whole diff"}>
            · {r.cut ? "diff cut to fit" : "whole diff"}
          </span>
        )}
        {r.state === "done" && (
          <span className={cn("ml-auto rounded-full px-2 py-0.5 text-micro font-medium", r.verdict === "correct" ? "bg-ok/15 text-ok" : r.verdict === "incorrect" ? "bg-danger-soft text-danger" : "bg-sunken text-muted")}>
            {r.verdict === "correct" ? "looks correct" : r.verdict === "incorrect" ? "has problems" : "no verdict given"}
          </span>
        )}
        {r.state === "running" && (
          <button className="ml-auto inline-flex items-center gap-1 text-faint hover:text-danger" title="Stop the review" onClick={() => api(`/api/sessions/${sessionId}/reviews/${r.id}`, { method: "DELETE" }).catch(reportError)}>
            <Square className="size-3" /> Stop
          </button>
        )}
      </div>
      {r.state === "failed" && <p className="px-3 py-2 text-caption text-danger">{r.error}</p>}
      {r.state === "stopped" && <p className="px-3 py-2 text-caption text-muted" data-testid="review-stopped">Stopped by you, before the reviewer answered.</p>}
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
      {r.state === "done" && !r.findings.length && <p className="k-empty px-3 py-2">No findings.</p>}
      {(!!r.rejected || !!r.omitted) && (
        <p className="px-3 pt-2 text-caption text-warn" data-testid="review-rejected">
          {r.rejected ? `${r.rejected} finding${r.rejected === 1 ? "" : "s"} in the answer could not be read (${(r.rejected_why ?? []).join(", ")}).` : ""}
          {r.omitted ? ` ${r.omitted} more of the lowest priority were left out.` : ""}
        </p>
      )}
      {r.findings.length > 0 && (
        <ul className="flex flex-col py-1" data-testid="findings">
          {r.findings.map((f) => <FindingRow key={f.id} f={f} checked={picked.has(f.id)} onCheck={(v) => setPicked((s) => { const n = new Set(s); v ? n.add(f.id) : n.delete(f.id); return n; })} onReopen={() => act("reopen", [f.id])} />)}
        </ul>
      )}
      {open.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
          <button data-testid="findings-fix" disabled={!picked.size || pending} onClick={() => act("fix", [...picked])} className="k-findings-fix inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40">
            {pending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />} Send {picked.size} to {recipient}
          </button>
          <button data-testid="findings-dismiss" disabled={!picked.size || pending} onClick={() => act("dismiss", [...picked])} className="inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-40">
            <X className="size-3" /> Dismiss
          </button>
          {err && <span className="ml-auto text-micro text-danger">{err}</span>}
          {gone && (
            <button data-testid="findings-fix-session" disabled={pending} onClick={() => act("fix", [...picked], "session")} className="text-micro font-medium text-accent hover:underline">
              Send to this session's model instead
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FindingRow({ f, checked, onCheck, onReopen }: { f: Finding; checked: boolean; onCheck: (v: boolean) => void; onReopen: () => void }) {
  const [miss, setMiss] = useState("");
  const p = priorityLabel(f.priority);
  // The file's block in the branch diff opens at the cited lines; a line the
  // diff does not hold is said, not silently ignored.
  const jump = () => {
    const d: JumpDetail = { path: f.file, line: f.line, end: f.end_line };
    window.dispatchEvent(new CustomEvent(JUMP, { detail: d }));
    setMiss(d.found === undefined ? `${f.file} is not in this diff.` : d.found ? "" : `Line ${f.line}${f.end_line ? `-${f.end_line}` : ""} is outside the changed lines shown.`);
  };
  return (
    <li className={cn("k-finding flex items-start gap-2.5 px-3 py-1.5", f.state !== "open" && "opacity-60")} data-testid="finding" data-state={f.state}>
      {f.state === "open" ? (
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} className="mt-1 size-3.5 accent-[var(--color-accent)]" aria-label={`Pick ${f.title}`} />
      ) : (
        <button onClick={onReopen} className="mt-0.5 text-micro text-faint hover:text-fg" title={f.sent_to ? `Sent to ${f.sent_to}. Open it again` : "Open it again"}>{f.state === "fix_requested" ? "sent" : "dismissed"}</button>
      )}
      <span className={cn("mt-0.5 shrink-0 rounded px-1 font-mono text-micro font-medium", PCLS[p])} data-testid="finding-priority" title={f.priority === null ? "The reviewer gave no priority" : undefined}>{p}</span>
      <div className="min-w-0 flex-1">
        <div className="text-caption font-medium">{f.title}</div>
        <button onClick={jump} data-testid="finding-jump" className="font-mono text-micro text-faint hover:text-accent">{f.file}:{f.line}{f.end_line ? `-${f.end_line}` : ""}</button>
        {miss && <span className="ml-2 text-micro text-warn" data-testid="finding-miss">{miss}</span>}
        {f.body && <p className="mt-0.5 text-caption text-muted whitespace-pre-wrap">{f.body}</p>}
      </div>
    </li>
  );
}
