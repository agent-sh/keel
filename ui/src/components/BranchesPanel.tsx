import { Check, CircleDashed, GitBranch, GitMerge, Loader2, RefreshCw, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Clash } from "../../../src/worktree/overlap.ts";
import { openSession } from "../lib/automation.ts";
import { canLand } from "../../../src/board/rules.ts";
import { useBoard, type BoardRow } from "../lib/board.ts";
import { isLive, landInOrder, queueBranches, removeEntry, useLanding, type LandingEntry, type LandingView, type LandRun } from "../lib/landing.ts";
import { loadOverlap, otherOf, useOverlap, type OverlapView, type Pair } from "../lib/overlap.ts";
import { failed, useStore } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

const lines = ([first, last]: [number, number]) => (last < first ? `removed after ${last}` : first === last ? `${first}` : `${first}-${last}`);
const short = (b: string) => b.replace(/^keel\//, "");

// Worktrees Keel made that no live session holds: with no commit yet, or a branch whose agent ended.
function Unheld({ list }: { list: NonNullable<OverlapView["unheld"]> }) {
  const bare = list.filter((u) => u.commits === 0).length;
  return (
    <div className="flex flex-col gap-1" data-testid="overlap-unheld">
      <p className="k-empty px-1" data-testid="overlap-unheld-head">
        {bare ? `${bare} worktree${bare === 1 ? "" : "s"} with no commit yet` : "No live branch"}
        {bare < list.length && `${bare ? ", " : ": "}${list.length - bare} branch${list.length - bare === 1 ? "" : "es"} whose session is not live`}
      </p>
      <ul className="flex flex-col">
        {list.map((u) => (
          <li key={u.branch} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-caption hover:bg-hover" data-testid="overlap-unheld-row" data-branch={u.branch}>
            <GitBranch className="size-3.5 shrink-0 text-faint" />
            <span className="min-w-0 truncate font-mono text-fg" title={u.branch}>{short(u.branch)}</span>
            <button type="button" className="min-w-0 flex-1 truncate text-left text-muted hover:text-accent" onClick={() => openSession(u.session_id)}>{u.title || "a session"}</button>
            <span className="shrink-0 text-micro text-faint">
              {u.commits ? `${u.commits} commit${u.commits === 1 ? "" : "s"}` : "no commit"}
              {u.uncommitted ? ` · ${u.uncommitted} uncommitted file${u.uncommitted === 1 ? "" : "s"}` : ""}
              {` · ${u.why === "ended" ? "agent ended" : "session archived"}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The pairs given, each with its files and where the two sides meet. Seen
// from `mine` (the session's own branch) when it is one of the pair's sides.
export function OverlapList({ pairs, mine, compact }: { pairs: Pair[]; mine?: string | null; compact?: boolean }) {
  const titles = useStore((s) => s.sessions);
  return (
    <ul className={cn("flex flex-col", compact ? "mt-1.5 gap-2" : "gap-2.5")} data-testid="overlap-list">
      {pairs.map((p) => {
        const ours = !!mine && (p.a === mine || p.b === mine);
        const flip = ours && p.b === mine;
        const other = ours ? otherOf(p, mine!) : null;
        const sides = (c: Clash) => (flip ? { me: c.b, them: c.a } : { me: c.a, them: c.b });
        const who = other?.session ? titles[other.session]?.title || "a session" : null;
        return (
          <li key={`${p.a}\0${p.b}`} className="flex flex-col gap-1" data-testid="overlap-pair" data-a={p.a} data-b={p.b} data-base={p.base ? "1" : undefined}>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-caption">
              {other ? (
                <>
                  <span className="text-muted">with</span>
                  <span className="truncate font-mono text-fg" title={other.branch}>{p.base ? other.branch : short(other.branch)}</span>
                  {p.base ? <span className="text-faint">the base</span> : other.session && (
                    <button type="button" className="min-w-0 truncate text-accent hover:underline" onClick={() => openSession(other.session!)} data-testid="overlap-session">{who}</button>
                  )}
                </>
              ) : (
                <>
                  <span className="truncate font-mono text-fg" title={p.a}>{short(p.a)}</span>
                  <span className="text-faint">and</span>
                  <span className="truncate font-mono text-fg" title={p.b}>{p.base ? p.b : short(p.b)}</span>
                  {p.base && <span className="text-faint">the base</span>}
                </>
              )}
              {p.waits && <span className="text-faint" data-testid="overlap-waits" title="Not told yet: one side conflicts with the base, and a rebase onto it may change this conflict">· told after a rebase onto the base</span>}
            </div>
            {p.error ? <p className="text-micro text-danger">git could not check it: {p.error}</p> : (
              <ul className="flex flex-col gap-0.5 border-l border-line pl-2">
                {p.files.length === 0 && <li className="text-micro text-muted">a conflict git names no file for (a directory rename)</li>}
                {p.files.map((f) => (
                  <li key={f.path} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-micro" data-testid="overlap-file" data-path={f.path}>
                    <span className="min-w-0 truncate font-mono text-fg" title={f.path}>{f.path}</span>
                    {f.clashes.length === 0
                      ? <span className="text-faint">both changed it</span>
                      : f.clashes.map((c, i) => {
                        const s = sides(c);
                        return (
                          <span key={i} className="font-mono text-faint" data-testid="overlap-lines">
                            {ours ? <>yours {lines(s.me)} · {p.base ? "base" : "theirs"} {lines(s.them)}</> : <span title={`${p.a}: ${lines(c.a)}; ${p.b}: ${lines(c.b)}`}>lines {lines(c.a)} and {lines(c.b)}</span>}
                          </span>
                        );
                      })}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const STATE: Record<LandingEntry["state"], { word: string; tone: string }> = {
  queued: { word: "queued", tone: "text-muted" },
  building: { word: "building", tone: "text-accent" },
  checking: { word: "checking", tone: "text-accent" },
  resolving: { word: "rebasing", tone: "text-warn" },
  landed: { word: "landed", tone: "text-ok" },
  left: { word: "left the queue", tone: "text-danger" },
  removed: { word: "taken out", tone: "text-faint" },
};
function StateIcon({ e }: { e: LandingEntry }) {
  const cls = cn("size-3.5 shrink-0", STATE[e.state].tone);
  if (e.state === "building" || e.state === "checking") return <Loader2 className={cn(cls, "animate-spin")} />;
  if (e.state === "resolving") return <GitMerge className={cls} />;
  if (e.state === "landed") return <Check className={cls} />;
  if (e.state === "left") return <X className={cls} />;
  if (e.state === "removed") return <Undo2 className={cls} />;
  return <CircleDashed className={cls} />;
}

// The landing queue of the repository: what it runs, what waits, what landed
// and what left lately (src/landing/queue.ts), newest first.
function LandingQueue({ session, q }: { session: Session; q: LandingView }) {
  const [err, setErr] = useState("");
  const live = q.entries.filter(isLive);
  const done = q.entries.filter((e) => !isLive(e)).slice(0, 12);
  const remove = (id: string) => removeEntry(session.id, id).catch((e) => setErr(failed(e, { at: "LandingQueue" })));
  const row = (e: LandingEntry) => (
    <li key={e.id} className="flex flex-col gap-0.5 rounded-lg px-1 py-1 hover:bg-hover" data-testid="landing-entry" data-branch={e.branch} data-state={e.state}>
      <div className="flex min-w-0 items-center gap-2 text-caption">
        <StateIcon e={e} />
        <span className="min-w-0 truncate font-mono text-fg" title={e.branch}>{short(e.branch)}</span>
        <span className={cn("shrink-0 text-micro", STATE[e.state].tone)} data-testid="landing-state">{STATE[e.state].word}</span>
        {e.landed && <span className="shrink-0 font-mono text-micro text-faint">as {e.landed.slice(0, 9)}</span>}
        <span className="flex-1" />
        <span className="shrink-0 text-micro text-faint">{ago(e.updated)}</span>
        {(e.state === "queued" || e.state === "resolving") && (
          <button type="button" onClick={() => remove(e.id)} data-testid="landing-remove" title="Take it out of the queue"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-3.5" /></button>
        )}
      </div>
      {(e.step || e.why) && (() => {
        const said = e.state === "left" || e.state === "removed" ? e.why : e.step ?? e.why;
        return <p className="line-clamp-3 pl-5.5 text-micro text-muted" title={said ?? undefined} data-testid="landing-why">{said}</p>;
      })()}
    </li>
  );
  return (
    <section className="flex flex-col gap-1.5" data-testid="landing-queue">
      <div className="flex items-baseline gap-2 px-1">
        <h3 className="k-label">Landing queue</h3>
        {q.rules && <span className="min-w-0 truncate text-micro text-faint" data-testid="landing-rules">{q.rules.checks.length ? `checks ${q.rules.checks.join(", ")}` : "no checks"}{q.rules.push ? ` · pushed to ${q.rules.push}` : ""}{q.rules.after ? " · then its after-land step" : ""}{q.rules.method === "merge" ? " · merge commits" : " · fast-forward"}</span>}
      </div>
      {q.rules?.problems.map((p) => <p key={p} className="px-1 text-caption text-warn">{p}</p>)}
      {!q.rules && <p className="k-empty px-1">The repository names no checks (.keel/checks.json): nothing would be known to pass, so nothing lands.</p>}
      {err && <p className="px-1 text-caption text-danger">{err}</p>}
      {live.length === 0 && done.length === 0 ? <p className="k-empty px-1" data-testid="landing-none">Nothing queued. Land a branch from the list above: it is built on {q.base ?? "the base"} with the entries ahead of it, checked there, and {q.base ?? "the base"} moves only to what passed.</p> : (
        <ul className="flex flex-col" data-testid="landing-entries">{live.map(row)}{done.length > 0 && live.length > 0 && <li className="mx-1 my-1 border-t border-line" />}{done.map(row)}</ul>
      )}
    </section>
  );
}

// The branches whose agents ended and that wait to land (the board's own rule, src/board/rules.ts canLand), in the
// order their agents were started, next to the live branches: one place to land what is ready. Land queues one;
// Land all ready queues them in order, each after the one before it landed, and stops at the first that fails.
function ReadyToLand({ session, q, ready }: { session: Session; q: LandingView | undefined; ready: BoardRow[] }) {
  const [run, setRun] = useState<{ at: string; of: number; n: number } | null>(null);
  const [out, setOut] = useState<LandRun | null>(null);
  const [err, setErr] = useState("");
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  if (!ready.length && !run && !out) return null;
  const land = (branch: string) => {
    setErr("");
    queueBranches(session.id, [branch]).then((r) => { if (r.refused.length) setErr(r.refused.map((x) => `${short(x.branch)}: ${x.why}`).join("; ")); }).catch((e) => setErr(failed(e, { at: "ReadyToLand" })));
  };
  const all = async () => {
    const list = ready.map((r) => r.branch!);
    stop.current = false;
    setErr(""); setOut(null);
    let n = 0;
    try {
      const done = await landInOrder(session.id, list, (at) => setRun({ at, of: list.length, n: ++n }), () => stop.current);
      setOut(done);
    } catch (e) { setErr(failed(e, { at: "ReadyToLand" })); }
    setRun(null);
  };
  return (
    <section className="flex flex-col gap-1.5" data-testid="ready-section">
      <div className="flex items-center gap-2 px-1">
        <h3 className="k-label">Ready to land</h3>
        {run
          ? <><span className="min-w-0 flex-1 truncate text-micro text-muted" role="status" data-testid="ready-run">Landing {run.n} of {run.of}: {short(run.at)}</span><button type="button" className="k-btn" data-quiet="" onClick={() => { stop.current = true; }} data-testid="ready-stop">Stop after this</button></>
          : <><span className="flex-1" />{ready.length > 1 && <button type="button" className="k-btn" data-ink="" onClick={() => void all()} disabled={!q?.rules} title={`Queue ${ready.length} branches one after the other on ${q?.base ?? "the base"}; it stops at the first that does not land`} data-testid="ready-land-all"><GitMerge /> Land all ready · {ready.length}</button>}</>}
      </div>
      {err && <p className="px-1 text-caption text-danger" data-testid="ready-error">{err}</p>}
      {out && (
        <p className={cn("px-1 text-caption", out.stopped ? "text-danger" : "text-muted")} data-testid="ready-result">
          {out.landed.length ? `Landed ${out.landed.length}: ${out.landed.map(short).join(", ")}. ` : ""}{out.stopped ? `Stopped at ${short(out.stopped.branch)}: ${out.stopped.why}` : "Nothing else is ready."}
        </p>
      )}
      {ready.length > 0 && (
        <ul className="flex flex-col" data-testid="ready-rows">
          {ready.map((r) => (
            <li key={r.id} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-caption hover:bg-hover" data-testid="ready-row" data-branch={r.branch ?? undefined}>
              <GitBranch className="size-3.5 shrink-0 text-ok" />
              <span className="min-w-0 truncate font-mono text-fg" title={r.branch ?? undefined}>{short(r.branch!)}</span>
              <button type="button" className="min-w-0 flex-1 truncate text-left text-muted hover:text-accent" onClick={() => openSession(r.session_id)}>{r.title}</button>
              {r.work?.branch && <span className="shrink-0 font-mono text-micro tabular-nums"><span className="text-ok">+{r.work.branch.added}</span> <span className="text-danger">-{r.work.branch.removed}</span></span>}
              <button type="button" onClick={() => land(r.branch!)} disabled={!q?.rules || !!run} data-testid="ready-land" aria-label={`Queue ${short(r.branch!)} to land on ${q?.base ?? "the base"}`}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-muted hover:bg-hover hover:text-accent disabled:opacity-40"><GitMerge className="size-3" /> Land</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// The Branches panel: the live branches of the session's repository (worktrees
// Keel made, branches sessions committed to), which pairs would conflict and
// in which files, and what the last check cost.
export function BranchesPanel({ session }: { session: Session }) {
  const v = useOverlap(session.id);
  const q = useLanding(session.id);
  const titles = useStore((s) => s.sessions);
  const [busy, setBusy] = useState(false);
  const queued = new Set((q?.entries ?? []).filter(isLive).map((e) => e.branch));
  // Finished branches that wait to land are listed once, in their own section above, with their Land.
  const board = useBoard(session.id);
  const ready = (board?.rows ?? []).filter(canLand).sort((x, y) => x.created - y.created);
  const readyBranches = new Set(ready.map((r) => r.branch));
  const land = (branch: string) => {
    setErr("");
    queueBranches(session.id, [branch]).then((r) => { if (r.refused.length) setErr(r.refused.map((x) => `${x.branch}: ${x.why}`).join("; ")); }).catch((e) => setErr(failed(e, { at: "BranchesPanel" })));
  };
  const [err, setErr] = useState("");
  useEffect(() => { loadOverlap(session.id).catch((e) => setErr(failed(e, { at: "BranchesPanel" }))); }, [session.id]);
  const refresh = () => {
    setBusy(true);
    setErr("");
    loadOverlap(session.id, true).catch((e) => setErr(failed(e, { at: "BranchesPanel" }))).finally(() => setBusy(false));
  };
  const button = (
    <button type="button" onClick={refresh} disabled={busy} data-testid="overlap-refresh"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50">
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Check now
    </button>
  );
  if (!v) return <p className="k-empty px-3 py-4">{err || "Loading…"}</p>;
  if (!v.repo) return <p className="k-empty px-3 py-4">The session's folder is not in a git repository.</p>;
  const between = v.pairs.filter((p) => !p.base && p.conflict || !p.base && p.error);
  const withBase = v.pairs.filter((p) => p.base);
  const repoName = v.repo.split("/").filter(Boolean).at(-1);
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3" data-testid="branches-panel">
      <div className="flex items-start gap-2 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex min-w-0 items-center gap-2 text-ui"><GitMerge className="size-4 shrink-0 text-faint" /><span className="truncate font-medium">{repoName}</span></p>
          <p className="text-caption text-muted">
            {v.base ? <>landing on <span className="font-mono">{v.base}</span></> : "no base branch found"}
            {v.last && <> · checked {ago(v.last.at)} in {v.last.ms < 1000 ? `${v.last.ms} ms` : `${(v.last.ms / 1000).toFixed(1)} s`}: {v.last.merges + v.last.reused} pair{v.last.merges + v.last.reused === 1 ? "" : "s"}, {v.last.merges ? `${v.last.merges} merged again` : "none moved"}</>}
          </p>
        </div>
        {button}
      </div>
      {err && <p className="px-1 text-caption text-danger">{err}</p>}

      <ReadyToLand session={session} q={q} ready={ready} />

      <section className="flex flex-col gap-1.5">
        <h3 className="k-label px-1">Live branches</h3>
        {v.branches.length === 0 ? (
          v.unheld?.some((u) => !readyBranches.has(u.branch)) ? <Unheld list={v.unheld.filter((u) => !readyBranches.has(u.branch))} />
          : ready.length ? <p className="k-empty px-1">No other live branch.</p> : <p className="k-empty px-1">No session holds a branch of this repository: a worktree Keel makes, or a branch a session commits to, shows here.</p>
        ) : (
          <ul className="flex flex-col" data-testid="overlap-branches">
            {v.branches.map((b) => {
              const n = v.pairs.filter((p) => p.conflict && (p.a === b.branch || p.b === b.branch)).length;
              return (
                <li key={b.branch} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-caption hover:bg-hover" data-testid="overlap-branch" data-branch={b.branch}>
                  <GitBranch className={cn("size-3.5 shrink-0", n ? "text-warn" : "text-faint")} />
                  <span className="min-w-0 truncate font-mono text-fg" title={b.branch}>{short(b.branch)}</span>
                  {b.branch === v.mine && <span className="shrink-0 rounded-md bg-accent-soft px-1 text-micro text-accent-ink">this session</span>}
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-muted hover:text-accent" onClick={() => openSession(b.session_id)}>{titles[b.session_id]?.title || b.title || "a session"}</button>
                  <span className={cn("shrink-0 text-micro", n ? "text-warn" : "text-faint")}>{!b.checked ? "nothing to land" : n ? `${n} conflict${n === 1 ? "" : "s"}` : "clean"}</span>
                  {b.checked && q?.rules && (queued.has(b.branch)
                    ? <span className="shrink-0 text-micro text-accent" data-testid="land-queued">in the queue</span>
                    : v.pairs.some((p) => p.base && p.conflict && p.a === b.branch)
                      ? <span className="shrink-0 text-micro text-faint" data-testid="land-rebase-first">rebase first</span>
                      : <button type="button" onClick={() => land(b.branch)} data-testid="land-queue" aria-label={`Queue ${short(b.branch)} to land on ${v.base ?? "the base"}`}
                        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro text-muted hover:bg-hover hover:text-accent"><GitMerge className="size-3" /> Land</button>)}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {q && q.repo && <LandingQueue session={session} q={q} />}

      <section className="flex flex-col gap-1.5">
        <h3 className="k-label px-1">Would conflict with each other</h3>
        {between.length === 0 ? <p className="k-empty px-1" data-testid="overlap-none">No two live branches conflict{v.clean ? ` (${v.clean} checks merge clean)` : ""}.</p> : <div className="px-1"><OverlapList pairs={between} /></div>}
      </section>

      {withBase.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="k-label px-1">Would conflict with {v.base ?? "the base"}</h3>
          <div className="px-1"><OverlapList pairs={withBase} /></div>
        </section>
      )}
    </div>
  );
}
