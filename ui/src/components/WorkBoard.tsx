// The work board: one card per agent of the session's tree, with its task and state, its branch and
// head, and four facts the daemon keeps of it (src/board/board.ts): the named checks on its head's tree,
// the latest review of its branch, whether the base holds it, and whether what runs holds it. A
// reviewer's words (its verdict's why, or its LAND line) are quoted under its card as its own.
import { Check, ChevronRight, CircleDashed, FileDiff, GitBranch, GitMerge, GitPullRequestArrow, Loader2, Minus, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode } from "react";
import type { Session } from "../../../src/core/types.ts";
import { openSession } from "../lib/automation.ts";
import { listedOnItsOwn, useFold, useNow } from "../lib/agent-fold.ts";
import { useAgentsSeen } from "../lib/agent-seen.ts";
import { EarlierRow } from "./automation/Earlier.tsx";
import { treeOrder } from "../lib/board-order.ts";
import { rememberPanel } from "../lib/ui.ts";
import { branchGone, toLand, type Change } from "../../../src/board/rules.ts";
import { loadBoard, useBoard, type Board, type BoardRow } from "../lib/board.ts";
import { checksWords } from "../lib/check-words.ts";
import { failed } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";
import { useToldStates, type SessionState, type Watch } from "../lib/watch.ts";
import { STATE_WORD, agentState, failWord } from "../../../src/core/state-words.ts";
import { goToAsk } from "./AnswerQueue.tsx";
import { Mark as StateMark } from "./Mark.tsx";
import { PicturesArea } from "./Pictures.tsx";

// The tree review: every agent's branch as one diff by area (TreeReview.tsx), read when it opens.
const TreeReviewDialog = lazy(() => import("./TreeReview.tsx").then((m) => ({ default: m.TreeReviewDialog })));

type Tone = "ok" | "bad" | "wait" | "none";
const TONE: Record<Tone, string> = { ok: "text-ok", bad: "text-danger", wait: "text-st-work", none: "text-faint" };
// A card's state is the agent's one status (src/core/state-words.ts agentState): its record with
// what its session's state says, so an agent that keeps a command going works here as on its row.
const watchOf = (r: BoardRow, told: SessionState | undefined): Watch => agentState({ status: r.state }, told).watch;
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
      <span className="flex min-w-0 items-start gap-1 text-caption text-fg"><span className="mt-0.5 flex h-[1em] items-center"><Mark tone={tone} /></span><span className="min-w-0 [overflow-wrap:anywhere]" data-testid="board-fact-value">{value}</span></span>
    </div>
  );
}

function checksFact(r: BoardRow) {
  const c = r.checks;
  if (!c) return null;
  // A repository that names no check has nothing to say here: no tile.
  if (c.state === "none") return null;
  if (c.state === "unknown") return <Fact name="Checks" tone="none" value="not known" title={c.why} testid="board-checks" state="unknown" />;
  const all = [...c.passed.map((n) => `${n} passed`), ...c.failed.map((n) => `${n} failed`), ...c.notRun.map((n) => `${n} not run`)].join(", ");
  // Checks that ran only on files not committed: they did run, so "none run" would be wrong, and they are
  // not on a commit, so they never read as passed on the head.
  const off = !c.passed.length && !c.failed.length ? c.uncommitted : undefined;
  const value = c.failed.length ? checksWords(c) : c.passed.length && !c.notRun.length ? "all passed" : c.passed.length ? checksWords(c) : off?.failed.length ? "failed on uncommitted files; none on a commit" : off?.passed.length ? "passed on uncommitted files; none on a commit" : "none run";
  const more = off ? [...off.passed.map((n) => `${n} passed on uncommitted files`), ...off.failed.map((n) => `${n} failed on uncommitted files`)].join(", ") : "";
  return <Fact name="Checks on head" tone={c.failed.length ? "bad" : c.passed.length && !c.notRun.length ? "ok" : "none"} value={value} title={[all, more].filter(Boolean).join(", ")} testid="board-checks" state={c.failed.length ? "failed" : off ? "uncommitted" : c.notRun.length ? "partial" : "passed"} />;
}

const SOURCE: Record<string, string> = {
  verdict: "its keel__verdict call",
  output: "its structured answer",
  panel: "the Review panel's verdict",
  words: "its report's words only: it gave no structured verdict, so the board takes it as neither approved nor refused",
};

function reviewFact(r: BoardRow) {
  const v = r.review;
  if (!v) return null;
  const word = v.verdict === "pending" ? "running" : v.verdict === "words" ? "words only" : v.verdict;
  // Approved is the one word the board must never say wrongly: only a structured verdict on this head says it.
  const tone: Tone = v.verdict === "approved" && v.current === true ? "ok" : v.verdict === "refused" || v.verdict === "disputed" ? "bad" : v.verdict === "pending" ? "wait" : "none";
  const who = v.how === "panel" ? "The Review panel" : `${v.title} (agent ${v.by})`;
  const said = v.was ? `; it said ${v.was}${v.of ? ` of ${sha(v.of)}` : ""}${v.verdict === "stale" ? ", not of the head now" : ", of a head not known"}` : "";
  const from = v.source ? `; read from ${SOURCE[v.source] ?? v.source}` : "";
  return <Fact name="Review" tone={tone} value={<>{word}{v.verdict === "stale" && v.of ? <span className="text-faint"> · of {sha(v.of)}</span> : v.current === false && <span className="text-faint"> · older head</span>}</>} title={`${who}${v.tip ? ` was started on ${sha(v.tip)}` : ""}${said}${from}`} testid="board-review" state={v.verdict} />;
}

function landedFact(r: BoardRow) {
  const l = r.landed;
  if (!l) return null;
  if (l.state === "yes") return <Fact name="Landed" tone="ok" value={l.how === "patch" ? "yes · as patches" : l.how === "queue" ? "yes · by the queue" : `yes · on ${r.base ?? "the base"}`} title={l.how === "patch" ? `${r.base ?? "The base"} holds a commit of the same patch for each of its commits` : l.how === "queue" ? `The landing queue landed this head; git does not see its patches on ${r.base ?? "the base"} (a squash or edited patches)` : `${r.base ?? "The base"} holds its head`} testid="board-landed" state="yes" />;
  if (l.state === "no") return <Fact name="Landed" tone={r.queue?.current && ["queued", "building", "checking"].includes(r.queue.state) ? "wait" : "none"} value={r.queue?.current && r.queue.state !== "landed" ? `no · ${r.queue.state === "left" ? "left the queue" : r.queue.state}` : `no · ${l.missing} to land`} title={r.queue?.why ?? "Git compares patches per commit: a squash or edited patches are not seen"} testid="board-landed" state="no" />;
  if (l.state === "nothing") return null;
  return <Fact name="Landed" tone="none" value="not known" title={l.why} testid="board-landed" state="unknown" />;
}

function liveFact(r: BoardRow) {
  // Not landed: nothing that runs holds it, and a tile saying so is no fact.
  if (!r.landed || r.landed.state !== "yes") return null;
  const v = r.live;
  if (!v || v.state === "unknown") return <Fact name="Live" tone="none" value="no deploy record" title={v?.why} testid="board-live" state="unknown" />;
  return <Fact name="Live" tone={v.state === "yes" ? "ok" : "none"} value={`${v.state === "yes" ? "yes" : "not yet"} · ${v.how === "after step passed" ? "after step" : v.how}`} title={`${v.how} at ${sha(v.at)}`} testid="board-live" state={v.state} />;
}

// The branches this one was checked together with at its head (src/landing/together.ts): each pair
// that fails together and passes alone in a block of its own, with the failing tests and both heads;
// the rest as one line.
function Together({ r, below }: { r: BoardRow; below: Board["rows"] }) {
  const t = r.together ?? [];
  if (!t.length) return null;
  const red = t.filter((p) => p.state === "red");
  const green = t.filter((p) => p.state === "green").length, running = t.filter((p) => p.state === "running").length, broken = t.filter((p) => p.state === "broken").length;
  const rest = [green ? `green with ${green}` : "", running ? `checking with ${running}` : "", broken ? "setup or base broken where pairs run" : ""].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-1.5" data-testid="board-together">
      {red.map((p) => {
        const other = below.find((x) => x.id === p.with_agent);
        const tests = p.checks.flatMap((c) => (c.tests ?? []).map((n) => ({ check: c.name, n })));
        return (
          <div key={p.with} className="flex flex-col gap-1 rounded-md bg-danger-soft px-2 py-1.5" data-testid="board-together-red" data-with={p.with}>
            <span className="flex min-w-0 items-center gap-1.5 text-caption text-danger">
              <GitMerge className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">
                Fails together with{" "}
                {other ? <button type="button" className="font-mono hover:underline" onClick={() => openSession(other.session_id)} title={other.title}>{short(p.with)}</button> : <span className="font-mono">{short(p.with)}</span>}
                , passes alone
              </span>
            </span>
            {tests.length > 0 ? (
              <ul className="flex flex-col gap-0.5 pl-5 text-micro text-fg">
                {tests.slice(0, 4).map((x) => <li key={`${x.check}:${x.n}`} className="truncate font-mono" title={x.n} data-testid="board-together-test">{x.n}</li>)}
                {tests.length > 4 && <li className="text-muted">{tests.length - 4} more</li>}
              </ul>
            ) : (
              <span className="pl-5 text-micro text-fg">{p.checks.map((c) => c.name).join(", ")}</span>
            )}
            <span className="pl-5 font-mono text-micro text-muted" data-testid="board-together-heads">{sha(p.head)} + {sha(p.with_head)} on {sha(p.base_tip)}</span>
          </div>
        );
      })}
      {rest && <p className="flex items-center gap-1.5 px-0.5 text-micro text-faint" data-testid="board-together-rest"><GitMerge className="size-3" aria-hidden="true" />Checked together: {rest}</p>}
    </div>
  );
}

// A reviewer's own words under a card, named as its.
function Quote({ by, how, title, line, below, testid }: { by: string; how: string; title: string; line: string; below: Board["rows"]; testid: string }) {
  const agent = below.find((x) => x.id === by);
  return (
    <blockquote className="k-quote text-caption text-muted" data-testid={testid}>
      <span className="block text-micro text-faint" data-testid={testid === "board-verdict" ? "board-reviewer" : undefined}>
        {how === "panel" ? "The Review panel" : agent ? <button type="button" className="text-left hover:text-accent" onClick={() => openSession(agent.session_id)}>Reviewer {title}</button> : `Reviewer ${title}`} wrote:
      </span>
      <span className="line-clamp-2">{line}</span>
    </blockquote>
  );
}

// What a worktree changes: its files and lines, and where they are (uncommitted, or committed on the branch).
function Changed({ c, where, testid }: { c: Change; where: string; testid: string }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1" data-testid={testid}>
      <span className="whitespace-nowrap text-fg">{c.files}{c.more ? "+" : ""} {c.files === 1 ? "file" : "files"}</span>
      <span className="font-mono text-micro text-ok">+{c.added}{c.more ? "+" : ""}</span>
      <span className="font-mono text-micro text-danger">-{c.removed}{c.more ? "+" : ""}</span>
      <span className="text-muted">{where}</span>
    </span>
  );
}

// How long an agent worked: from its start to its end, or to now while it works.
export function lasted(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// An agent with no branch and no changes of its own (a reader, a reviewer, one that only asked) has nothing
// to land, check or review: one line, not a card of facts that are all empty.
const compact = (r: BoardRow) => !r.branch && !r.work;

// What waits as a card the owner answers (the daemon's reason for a state that needs them).
const CARD_ASKS = new Set(["approval", "question", "plan", "secret"]);

function Line({ r, indent, w, st }: { r: BoardRow; indent: number; w: Watch; st: SessionState | undefined }) {
  // The state in a word, and for a failure its class: what to see to. A needs-you row has a verb: Answer goes to its card.
  const why = w === "fail" ? failWord(st?.cls) : "";
  const word = STATE_WORD[w].toLowerCase() + (why ? `: ${why}` : "");
  const answers = w === "need" && CARD_ASKS.has(st?.why ?? "");
  return (
    <li className="group/line flex min-w-0 items-center gap-2 rounded-md px-2.5 py-1 hover:bg-hover" style={indent ? { marginLeft: `${Math.min(indent, 4) * 1.25}rem` } : undefined} data-testid="board-row" data-compact="" data-agent={r.id} data-state={r.state} data-indent={indent} data-watch={w}
      // The whole row opens the agent (its title is the control for a keyboard); its own buttons keep their own press.
      onClick={(e) => { if (e.target === e.currentTarget || !(e.target as Element).closest("button")) openSession(r.session_id); }}>
      <StateMark w={w} />
      <button type="button" onClick={() => openSession(r.session_id)} className="min-w-0 flex-1 truncate text-left text-caption font-medium text-fg group-hover/line:text-accent" title={`Open ${r.title} (agent ${r.id})`} data-testid="board-title">{r.title}</button>
      {r.reviews.length > 0 && <span className="min-w-0 max-w-[40%] shrink truncate font-mono text-micro text-muted" title={`reviews ${r.reviews.map(short).join(", ")}`}>reviews {r.reviews.map(short).join(", ")}</span>}
      <span className={cn("shrink-0 text-micro", w === "fail" ? "text-danger" : "text-muted")} data-testid="board-state">{word}</span>
      <span className="shrink-0 text-micro text-faint tabular-nums" data-testid="board-lasted" title={r.ended ? `Worked ${lasted(r.created, r.ended)}; ended ${ago(r.ended)}` : "Working since it started"}>{lasted(r.created, r.ended ?? Date.now())}</span>
      {answers && <button type="button" onClick={() => goToAsk(r.session_id)} data-testid="board-answer" title="Go to what it asks and answer it" className="inline-flex h-6 shrink-0 items-center rounded-md border border-accent/40 bg-accent-soft px-2 text-micro font-medium text-accent-ink hover:border-accent">Answer</button>}
      <ChevronRight className="size-3.5 shrink-0 text-faint group-hover/line:text-accent" aria-hidden="true" data-testid="board-opens" />
    </li>
  );
}

function Card({ r, below, indent, w, st }: { r: BoardRow; below: Board["rows"]; indent: number; w: Watch; st: SessionState | undefined }) {
  if (compact(r)) return <Line r={r} indent={indent} w={w} st={st} />;
  const reviewing = r.reviews.length > 0;
  // A tile shows only a fact: a check the repository names, a review, a landing, a live record.
  const facts = [checksFact(r), reviewFact(r), landedFact(r), liveFact(r)].filter(Boolean);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-raised p-2.5" style={indent ? { marginLeft: `${Math.min(indent, 4) * 1.25}rem` } : undefined} data-testid="board-row" data-agent={r.id} data-branch={r.branch ?? undefined} data-state={r.state} data-indent={indent} data-watch={w}>
      <div className="flex min-w-0 items-center gap-2">
        <StateMark w={w} />
        <button type="button" onClick={() => openSession(r.session_id)} className="min-w-0 flex-1 truncate text-left text-ui font-medium text-fg hover:text-accent" title={`${r.title} (agent ${r.id})`} data-testid="board-title">{r.title}</button>
        <span className="shrink-0 text-micro text-muted" data-testid="board-state">{STATE_WORD[w].toLowerCase()}</span>
        
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
      {r.work && (
        <div className="flex min-w-0 items-start gap-x-3 text-caption" data-testid="board-work">
          <FileDiff className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            {r.work.uncommitted && <Changed c={r.work.uncommitted} where="uncommitted" testid="board-uncommitted" />}
            {r.work.branch && <Changed c={r.work.branch} where="on branch" testid="board-on-branch" />}
            {!r.work.uncommitted && !r.work.branch && <span className="text-muted" data-testid="board-no-changes">no changes yet</span>}
          </div>
          {(r.work.uncommitted || r.work.branch) && (
            <button type="button" onClick={() => { rememberPanel(r.session_id, "changes"); openSession(r.session_id); }} data-testid="board-open-changes"
              className="inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-micro text-accent hover:bg-hover">Open changes</button>
          )}
        </div>
      )}
      {r.branch && branchGone(r) && <p className="text-caption text-muted" data-testid="board-gone">{r.reviews.length > 0 && <>reviews <span className="font-mono text-fg">{r.reviews.map(short).join(", ")}</span> · </>}Branch removed at its end; nothing left to land{r.ended ? ` · ended ${ago(r.ended)}` : ""}</p>}
      {r.branch && !branchGone(r) && facts.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5 @[30rem]:grid-cols-4">
          {facts}
        </div>
      )}
      {r.branch && !branchGone(r) && <Together r={r} below={below} />}
      {r.branch && !branchGone(r) && r.pictures && <PicturesArea fact={r.pictures} sessionId={r.session_id} repo={r.repo} />}
      {r.review?.line && <Quote by={r.review.by} how={r.review.how} title={r.review.title} line={r.review.line} below={below} testid="board-verdict" />}
      {r.review?.against && <Quote by={r.review.against.by} how={r.review.against.how} title={r.review.against.title} line={r.review.against.line || "(no words)"} below={below} testid="board-verdict-against" />}
    </li>
  );
}

export function WorkBoard({ session }: { session: Session }) {
  const b = useBoard(session.id);
  const told = useToldStates();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const refresh = () => {
    setBusy(true);
    setErr("");
    loadBoard(session.id, true).catch((e) => setErr(failed(e, { at: "WorkBoard" }))).finally(() => setBusy(false));
  };
  const seen = useAgentsSeen();
  const now = useNow(!!b && b.rows.length > 0);
  const rows = b?.rows ?? [];
  const ordered = treeOrder(rows, session.id, Object.fromEntries(rows.map((r) => [r.session_id, told[r.session_id]?.watch])));
  // Working counts the agents that work, by the one status: the tree line under the row counts the same.
  const watches = new Map(rows.map((r) => [r.id, watchOf(r, told[r.session_id])]));
  // The cards of what is live and of what ended lately or since the owner looked; "N earlier" opens the rest a page at a time.
  const fold = useFold(ordered.map((o) => o.indent + 1), ordered.map((o) => listedOnItsOwn({ id: o.row.id, status: o.row.state, ended: o.row.ended }, watches.get(o.row.id), seen, now)), session.id, "first");
  if (!b) return <p className="k-empty px-3 py-4">{err || "Loading…"}</p>;
  const repo = b.repos.length === 1 ? b.repos[0] : undefined;
  const toLandLeft = ordered.filter((_, i) => !fold.show[i] && toLand(ordered[i]!.row)).length;
  const working = b.rows.filter((r) => watches.get(r.id) === "work").length;
  const landed = b.rows.filter((r) => r.landed?.state === "yes").length;
  return (
    <div className="@container flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="work-board" data-quote-from="the work board">
      {/* The summary keeps a measure of its own (16rem); where the panel has no room for it and the buttons, they stand under it. */}
      <div className="flex flex-wrap items-start gap-2 px-1">
        <div className="flex min-w-0 basis-64 grow flex-col gap-0.5">
          <p className="text-ui font-medium text-fg">{b.total} {b.total === 1 ? "agent" : "agents"}</p>
          <p className="text-caption text-muted" data-testid="board-summary">
            {working} working · {landed} landed
            {repo?.base && <> · base <span className="font-mono">{repo.base}</span> at <span className="font-mono">{sha(repo.base_tip)}</span></>}
            {repo?.deploys.map((d) => <span key={d.how}> · live at <span className="font-mono">{sha(d.sha)}</span> ({d.how})</span>)}
          </p>
        </div>
        {b.rows.some((r) => toLand(r)) && (
          <button type="button" onClick={() => setReviewing(true)} data-testid="board-review-tree" title="Every agent's branch as one diff by area: land, send back or drop each area"
            className="k-btn">
            <GitPullRequestArrow /> Review the tree
          </button>
        )}
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
          {ordered.map(({ row, indent }, i) => fold.show[i] ? <Card key={row.id} r={row} below={b.rows} indent={indent} w={watches.get(row.id)!} st={told[row.session_id]} /> : null)}
          {fold.earlier > 0 && <li className="list-none"><EarlierRow n={fold.earlier} onMore={fold.more} extra={toLandLeft ? `${toLandLeft} to land` : undefined} testid="board-earlier" className="k-earlier" /></li>}
        </ul>
      )}
      {b.total > b.rows.length && <p className="px-1 text-micro text-faint"><CircleDashed className="mr-1 inline size-3" />{b.total - b.rows.length} older agents are not shown.</p>}
      <p className="px-1 text-micro text-faint">Read {ago(b.at)} in {b.took_ms} ms, from git, the check ledger and the landing queue.</p>
      {reviewing && <Suspense fallback={null}><TreeReviewDialog session={session} onClose={() => { setReviewing(false); loadBoard(session.id, true).catch(() => {}); }} /></Suspense>}
    </div>
  );
}
