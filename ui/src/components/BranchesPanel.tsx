import { GitBranch, GitMerge, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Clash } from "../../../src/worktree/overlap.ts";
import { openSession } from "../lib/automation.ts";
import { loadOverlap, otherOf, useOverlap, type Pair } from "../lib/overlap.ts";
import { failed, useStore } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

const lines = ([first, last]: [number, number]) => (last < first ? `removed after ${last}` : first === last ? `${first}` : `${first}-${last}`);
const short = (b: string) => b.replace(/^keel\//, "");

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

// The Branches panel: the live branches of the session's repository (worktrees
// Keel made, branches sessions committed to), which pairs would conflict and
// in which files, and what the last check cost.
export function BranchesPanel({ session }: { session: Session }) {
  const v = useOverlap(session.id);
  const titles = useStore((s) => s.sessions);
  const [busy, setBusy] = useState(false);
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

      <section className="flex flex-col gap-1.5">
        <h3 className="k-label px-1">Live branches</h3>
        {v.branches.length === 0 ? <p className="k-empty px-1">No session holds a branch of this repository: a worktree Keel makes, or a branch a session commits to, shows here.</p> : (
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
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
