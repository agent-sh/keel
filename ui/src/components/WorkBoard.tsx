// The work board: one card per agent of the session's tree, with its task and state, its branch and
// head, and four facts the daemon keeps of it (src/board/board.ts): the named checks on its head's tree,
// the latest review of its branch, whether the base holds it, and whether what runs holds it. A
// reviewer's verdict line is quoted under its card as the reviewer's words.
import { Check, CircleDashed, GitBranch, Loader2, Minus, RefreshCw, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Session } from "../../../src/core/types.ts";
import { openSession } from "../lib/automation.ts";
import { branchGone } from "../../../src/board/rules.ts";
import { loadBoard, useBoard, type Board, type BoardRow } from "../lib/board.ts";
import { failed } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

type Tone = "ok" | "bad" | "wait" | "none";
const TONE: Record<Tone, string> = { ok: "text-ok", bad: "text-danger", wait: "text-st-work", none: "text-faint" };
const STATE: Record<string, { word: string; dot: string }> = {
  running: { word: "working", dot: "animate-pulse bg-st-work" },
  waiting: { word: "waiting", dot: "bg-st-wait" },
  completed: { word: "done", dot: "bg-st-done" },
  incomplete: { word: "incomplete", dot: "bg-st-need" },
  failed: { word: "failed", dot: "bg-st-fail" },
  stopped: { word: "stopped", dot: "bg-line-strong" },
};
const short = (b: string) => b.replace(/^keel\//, "");
const sha = (s: string | null | undefined) => (s ? s.slice(0, 9) : "?");

function Mark({ tone }: { tone: Tone }) {
  const cls = cn("size-3.5 shrink-0", TONE[tone]);
  if (tone === "ok") return <Check className={cls} aria-hidden="true" />;
  if (tone === "bad") return <X className={cls} aria-hidden="true" />;
  if (tone === "wait") return <Loader2 className={cn(cls, "animate-spin")} aria-hidden="true" />;
  return <Minus className={cls} aria-hidden="true" />;
}

// One fact of a card: its name over its value, the value's tone by what it says.
function Fact({ name, tone, value, title, testid, state }: { name: string; tone: Tone; value: ReactNode; title?: string; testid: string; state: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-sunken px-2 py-1.5" data-testid={testid} data-state={state} title={title}>
      <span className="k-label">{name}</span>
      <span className="flex min-w-0 items-center gap-1 text-caption text-fg"><Mark tone={tone} /><span className="min-w-0 truncate">{value}</span></span>
    </div>
  );
}

function checksFact(r: BoardRow) {
  const c = r.checks;
  if (!c) return null;
  if (c.state === "none") return <Fact name="Checks" tone="none" value="none named" testid="board-checks" state="none" />;
  if (c.state === "unknown") return <Fact name="Checks" tone="none" value="not known" title={c.why} testid="board-checks" state="unknown" />;
  const all = [...c.passed.map((n) => `${n} passed`), ...c.failed.map((n) => `${n} failed`), ...c.notRun.map((n) => `${n} not run`)].join(", ");
  const value = c.failed.length ? `${c.failed.length} failed` : c.passed.length && !c.notRun.length ? "all passed" : c.passed.length ? `${c.passed.length} of ${c.passed.length + c.notRun.length} passed` : "none run";
  return <Fact name="Checks on head" tone={c.failed.length ? "bad" : c.passed.length && !c.notRun.length ? "ok" : "none"} value={value} title={all} testid="board-checks" state={c.failed.length ? "failed" : c.notRun.length ? "partial" : "passed"} />;
}

function reviewFact(r: BoardRow) {
  const v = r.review;
  if (!v) return <Fact name="Review" tone="none" value="none" testid="board-review" state="none" />;
  const word = v.verdict === "pending" ? "running" : v.verdict;
  // Approved is the one word the board must never say wrongly: a review of another head is stale, whatever it said.
  const tone: Tone = v.verdict === "approved" && v.current === true ? "ok" : v.verdict === "refused" ? "bad" : v.verdict === "pending" ? "wait" : "none";
  const who = v.how === "panel" ? "The Review panel" : `${v.title} (agent ${v.by})`;
  const said = v.was ? `; it said ${v.was}${v.of ? ` of ${sha(v.of)}` : ""}${v.verdict === "stale" ? ", not of the head now" : ", of a head not known"}` : "";
  return <Fact name="Review" tone={tone} value={<>{word}{v.verdict === "stale" && v.of ? <span className="text-faint"> · of {sha(v.of)}</span> : v.current === false && <span className="text-faint"> · older head</span>}</>} title={`${who}${v.tip ? ` was started on ${sha(v.tip)}` : ""}${said}`} testid="board-review" state={v.verdict} />;
}

function landedFact(r: BoardRow) {
  const l = r.landed;
  if (!l) return null;
  if (l.state === "yes") return <Fact name="Landed" tone="ok" value={l.how === "patch" ? "yes · as patches" : l.how === "queue" ? "yes · by the queue" : `yes · on ${r.base ?? "the base"}`} title={l.how === "patch" ? `${r.base ?? "The base"} holds a commit of the same patch for each of its commits` : l.how === "queue" ? `The landing queue landed this head; git does not see its patches on ${r.base ?? "the base"} (a squash or edited patches)` : `${r.base ?? "The base"} holds its head`} testid="board-landed" state="yes" />;
  if (l.state === "no") return <Fact name="Landed" tone={r.queue?.current && ["queued", "building", "checking"].includes(r.queue.state) ? "wait" : "none"} value={r.queue?.current && r.queue.state !== "landed" ? `no · ${r.queue.state === "left" ? "left the queue" : r.queue.state}` : `no · ${l.missing} to land`} title={r.queue?.why ?? "Git compares patches per commit: a squash or edited patches are not seen"} testid="board-landed" state="no" />;
  if (l.state === "nothing") return <Fact name="Landed" tone="none" value="nothing to land" testid="board-landed" state="nothing" />;
  return <Fact name="Landed" tone="none" value="not known" title={l.why} testid="board-landed" state="unknown" />;
}

function liveFact(r: BoardRow) {
  if (!r.landed || r.landed.state !== "yes") return r.landed ? <Fact name="Live" tone="none" value="n/a" title="Not landed, so nothing that runs holds it" testid="board-live" state="n/a" /> : null;
  const v = r.live;
  if (!v || v.state === "unknown") return <Fact name="Live" tone="none" value="no deploy record" title={v?.why} testid="board-live" state="unknown" />;
  return <Fact name="Live" tone={v.state === "yes" ? "ok" : "none"} value={`${v.state === "yes" ? "yes" : "not yet"} · ${v.how === "after step passed" ? "after step" : v.how}`} title={`${v.how} at ${sha(v.at)}`} testid="board-live" state={v.state} />;
}

function Card({ r, below }: { r: BoardRow; below: Board["rows"] }) {
  const st = STATE[r.state] ?? { word: r.state, dot: "bg-line-strong" };
  const reviewing = r.reviews.length > 0;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-2.5" data-testid="board-row" data-agent={r.id} data-branch={r.branch ?? undefined} data-state={r.state}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", st.dot)} aria-hidden="true" />
        <button type="button" onClick={() => openSession(r.session_id)} className="min-w-0 flex-1 truncate text-left text-ui font-medium text-fg hover:text-accent" title={r.title} data-testid="board-title">{r.title}</button>
        <span className="shrink-0 text-micro text-muted" data-testid="board-state">{st.word}</span>
        <span className="shrink-0 font-mono text-micro text-faint">{r.id}</span>
      </div>
      {r.branch ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
          <GitBranch className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
          <span className="min-w-0 truncate font-mono text-fg" title={r.branch}>{short(r.branch)}</span>
          {r.head && <span className="shrink-0 font-mono text-micro text-muted" data-testid="board-head">{sha(r.head)}</span>}
          {!!r.behind && r.landed?.state !== "yes" && <span className="shrink-0 text-micro text-warn">{r.behind} behind {r.base ?? "the base"}</span>}
          {r.worktree === "gone" && !branchGone(r) && <span className="shrink-0 text-micro text-faint">worktree removed</span>}
        </div>
      ) : (
        <p className="text-caption text-muted">{reviewing ? <>reviews <span className="font-mono text-fg">{r.reviews.map(short).join(", ")}</span></> : "no branch of its own"}{r.ended ? ` · ended ${ago(r.ended)}` : ""}</p>
      )}
      {r.branch && branchGone(r) && <p className="text-caption text-muted" data-testid="board-gone">{r.reviews.length > 0 && <>reviews <span className="font-mono text-fg">{r.reviews.map(short).join(", ")}</span> · </>}Branch removed at its end; nothing left to land{r.ended ? ` · ended ${ago(r.ended)}` : ""}</p>}
      {r.branch && !branchGone(r) && (
        <div className="grid grid-cols-2 gap-1.5 @[30rem]:grid-cols-4">
          {checksFact(r)}{reviewFact(r)}{landedFact(r)}{liveFact(r)}
        </div>
      )}
      {r.review?.line && (
        <blockquote className="k-quote text-caption text-muted" data-testid="board-verdict">
          <span className="block text-micro text-faint" data-testid="board-reviewer">
            {r.review.how === "panel" ? "The Review panel" : below.some((x) => x.id === r.review!.by) ? <button type="button" className="hover:text-accent" onClick={() => openSession(below.find((x) => x.id === r.review!.by)!.session_id)}>Reviewer {r.review.title}</button> : `Reviewer ${r.review.title}`} wrote:
          </span>
          <span className="line-clamp-2">{r.review.line}</span>
        </blockquote>
      )}
    </li>
  );
}

export function WorkBoard({ session }: { session: Session }) {
  const b = useBoard(session.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const refresh = () => {
    setBusy(true);
    setErr("");
    loadBoard(session.id, true).catch((e) => setErr(failed(e, { at: "WorkBoard" }))).finally(() => setBusy(false));
  };
  if (!b) return <p className="k-empty px-3 py-4">{err || "Loading…"}</p>;
  const repo = b.repos.length === 1 ? b.repos[0] : undefined;
  const working = b.rows.filter((r) => r.state === "running" || r.state === "waiting").length;
  const landed = b.rows.filter((r) => r.landed?.state === "yes").length;
  return (
    <div className="@container flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="work-board">
      <div className="flex items-start gap-2 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-ui font-medium text-fg">{b.total} {b.total === 1 ? "agent" : "agents"}</p>
          <p className="text-caption text-muted" data-testid="board-summary">
            {working} working · {landed} landed
            {repo?.base && <> · base <span className="font-mono">{repo.base}</span> at <span className="font-mono">{sha(repo.base_tip)}</span></>}
            {repo?.deploys.map((d) => <span key={d.how}> · live at <span className="font-mono">{sha(d.sha)}</span> ({d.how})</span>)}
          </p>
        </div>
        <button type="button" onClick={refresh} disabled={busy} data-testid="board-refresh"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Refresh
        </button>
      </div>
      {err && <p className="px-1 text-caption text-danger">{err}</p>}
      {b.rows.length === 0 ? (
        <p className="k-empty px-1"><b>No agents yet</b>Each agent this session starts shows here with its branch, checks, review and whether it landed, kept from what Keel sees.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="board-rows">
          {b.rows.map((r) => <Card key={r.id} r={r} below={b.rows} />)}
        </ul>
      )}
      {b.total > b.rows.length && <p className="px-1 text-micro text-faint"><CircleDashed className="mr-1 inline size-3" />{b.total - b.rows.length} older agents are not shown.</p>}
      <p className="px-1 text-micro text-faint">Read {ago(b.at)} in {b.took_ms} ms, from git, the check ledger and the landing queue.</p>
    </div>
  );
}
