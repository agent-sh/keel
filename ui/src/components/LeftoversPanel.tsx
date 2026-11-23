// Settings > Leftovers: what sessions left behind. Commands whose processes still run, with the session that
// started them; worktrees no live session works in; branches no worktree has out, with what each holds that
// is not on the base, and who each is known by (Keel made it for a session, or it was new when an agent ended).
// Every act is the owner's and asked first: stop a command, remove a worktree with nothing uncommitted in it,
// delete a branch whose commits are all on the base, or all of those at once. Each names the item as it was
// shown, and one that changed since is refused.
import { useCallback, useEffect, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { PathText } from "./PathText.tsx";
import { Card } from "./Settings.tsx";

type By = { session_id: string; title: string; how?: "keel" | "found" };
type Proc = { session_id: string; title: string; agent?: { id: string; status: string }; job_id: string; command: string; cwd: string; started: number; running: boolean; pids: number[]; ports: number[]; contain?: string };
type Tree = { repo: string; top: string; path: string; branch?: string; head: string; made?: number; dirty?: number; ignored?: string[]; ahead?: number; base?: string; locked?: boolean; missing?: boolean; by?: By; removable: boolean; why?: string };
type Branch = { repo: string; top: string; name: string; sha: string; at: number; base?: string; ahead?: number; behind?: number; merged: boolean; by?: By };
type Survey = { processes: Proc[]; worktrees: Tree[]; branches: Branch[]; repos: string[] };

const btn = "k-btn";
const tag = "shrink-0 rounded-xs px-1.5 text-micro";
const SHOWN = 40;
// What git deletes with a worktree without asking: its ignored files, said by count and the first names.
const ignoredSay = (names: string[]) => `${names.length === 1 ? "1 ignored path goes" : `${names.length} ignored paths go`} with it: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}.`;

function Head({ title, hint, n }: { title: string; hint: string; n?: number }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-line py-4">
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{title}{n !== undefined && <span className="ml-2 font-normal tabular-nums text-faint">{n}</span>}</div>
        <div className="mt-0.5 text-ui text-muted">{hint}</div>
      </div>
    </div>
  );
}

// Who an item is known by. "found": it was new in the repository when that agent ended, and who made it is not
// known (the agent, something it started, the owner, another session).
const HOW = { keel: "Keel made it for this session", found: "New in the repository when this agent ended; who made it is not known" };
function Who({ by }: { by?: By }) {
  if (!by) return <span className="w-52 shrink-0 truncate text-caption text-faint">no session known</span>;
  return (
    <span className="flex w-52 shrink-0 items-baseline gap-1.5 truncate text-caption" data-testid="leftover-by" data-how={by.how}>
      {by.how === "found" && <span className="shrink-0 text-faint" title={HOW.found}>found by</span>}
      <button type="button" className="k-link min-w-0 truncate text-left hover:underline" title={`${by.title}${by.how ? `\n${HOW[by.how]}` : ""}`} onClick={() => navigate({ name: "session", id: by.session_id })}>
        {by.title || "Untitled"}
      </button>
    </span>
  );
}

export function LeftoversPanel() {
  const [s, setS] = useState<Survey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(() => api<Survey>("/api/leftovers").then(setS).catch(reportError), []);
  useEffect(() => { void load(); }, [load]);

  const act = async (key: string, ask: Parameters<typeof confirmAction>[0], path: string, body: unknown, done: string) => {
    if (!(await confirmAction(ask))) return;
    setBusy(key);
    try {
      const r = await api<any>(path, { method: "POST", body: JSON.stringify(body) });
      setSaid(r?.left?.length ? `Still running: pid ${r.left.join(", ")}.` : done);
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (!s) return <p className="k-empty py-4" data-testid="leftovers-loading">Reading what sessions left behind.</p>;
  const branches = all ? s.branches : s.branches.slice(0, SHOWN);
  // The whole list in one act: every worktree that can be removed and every branch that is all on its base, as shown.
  const trees = s.worktrees.filter((w) => w.removable), merged = s.branches.filter((b) => b.merged);
  const ignoredAll = trees.reduce((n, w) => n + (w.ignored?.length ?? 0), 0);
  // What the button removes, said on it: how many of each, and the ignored files that go with the worktrees.
  const allLabel = trees.length + merged.length
    ? `Remove ${[trees.length ? `${trees.length} ${trees.length === 1 ? "worktree" : "worktrees"}` : "", merged.length ? `${merged.length} ${merged.length === 1 ? "branch" : "branches"}` : ""].filter(Boolean).join(" and ")}${ignoredAll ? `, ${ignoredAll} ignored ${ignoredAll === 1 ? "path" : "paths"} with them` : ""}`
    : "Nothing to remove without losing work";
  const removeAll = async () => {
    const parts = [trees.length ? `${trees.length} ${trees.length === 1 ? "worktree" : "worktrees"} with nothing uncommitted (their branches and commits stay${ignoredAll ? `; ${ignoredAll} ignored ${ignoredAll === 1 ? "path goes" : "paths go"} with them` : ""})` : "", merged.length ? `${merged.length} ${merged.length === 1 ? "branch" : "branches"} whose commits are all on the base` : ""].filter(Boolean);
    if (!(await confirmAction({ title: `${allLabel}?`, body: `${parts.join(", and ")}.\n\nEach is checked again first: one that changed since it was listed stays. Nothing else is touched.`, action: "Remove all", danger: true }))) return;
    setBusy("all");
    try {
      const r = await api<{ removed: string[]; deleted: string[]; refused: { what: string; why: string }[] }>("/api/leftovers/remove-all", { method: "POST", body: JSON.stringify({
        worktrees: trees.map((w) => ({ repo: w.repo, path: w.path, head: w.head, ignored: w.ignored?.length ?? 0 })),
        branches: merged.map((b) => ({ repo: b.repo, branch: b.name, sha: b.sha })),
      }) });
      const done = [r.removed.length ? `Removed ${r.removed.length} ${r.removed.length === 1 ? "worktree" : "worktrees"}` : "", r.deleted.length ? `deleted ${r.deleted.length} ${r.deleted.length === 1 ? "branch" : "branches"}` : ""].filter(Boolean).join(", ");
      setSaid(`${done || "Nothing removed"}.${r.refused.length ? ` Kept ${r.refused.length}: ${r.refused.slice(0, 3).map((x) => `${x.what} (${x.why})`).join("; ")}${r.refused.length > 3 ? "; ..." : ""}` : ""}`);
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };
  return (
    <div className="space-y-5" data-testid="leftovers">
      <div className="flex items-center gap-3">
        <p role="status" className="min-w-0 flex-1 text-ui text-muted" data-testid="leftovers-said">{said ?? "Keel removes by itself only the worktrees it made for agents, when nothing in them would be lost. The rest is yours to remove here."}</p>
        <button type="button" className={btn} data-testid="leftovers-remove-all" disabled={busy !== null || !(trees.length + merged.length)}
          title={trees.length + merged.length ? "Every worktree with nothing uncommitted and every branch whose commits are all on its base" : undefined} onClick={removeAll}>
          {allLabel}
        </button>
      </div>

      <Card>
        <Head title="Left running" n={s.processes.length} hint="Commands of sessions whose processes still run after the command's call ended. An agent's are stopped when it ends, unless something else is connected to their port." />
        {s.processes.length === 0 && <p className="k-empty py-4">Nothing is left running.</p>}
        {s.processes.map((p) => (
          <div key={`${p.session_id}:${p.job_id}`} className="flex min-h-10 items-center gap-3 border-b border-line/60 py-1.5 text-ui last:border-0" data-testid="leftover-process" data-job={p.job_id}>
            <span className="min-w-0 flex-1 truncate font-mono text-caption" title={`${p.command}\n${p.cwd}`}>{p.command}</span>
            {p.ports.map((port) => <span key={port} className={cn(tag, "bg-accent-soft font-mono text-accent-ink")} data-testid="leftover-port">:{port}</span>)}
            {!p.running && <span className={cn(tag, "bg-sunken text-muted")} title="Its command ended; what it started runs on.">command ended</span>}
            {p.agent && <span className={cn(tag, p.agent.status === "running" || p.agent.status === "waiting" ? "bg-sunken text-muted" : "bg-warn/15 text-warn")}>agent {p.agent.status}</span>}
            <span className="w-24 shrink-0 text-right text-caption tabular-nums text-faint" title={`pid ${p.pids.join(", ")}`}>pid {p.pids[0]}{p.pids.length > 1 ? ` +${p.pids.length - 1}` : ""}</span>
            <Who by={{ session_id: p.session_id, title: p.title }} />
            <span className="w-16 shrink-0 text-right text-caption tabular-nums text-faint" title={when(p.started)}>{ago(p.started)}</span>
            <button type="button" className={btn} data-testid="leftover-stop" disabled={busy !== null}
              onClick={() => act(`p:${p.job_id}`, { title: "Stop this command?", body: `${p.command}\n\nEvery process it started is stopped (${p.pids.length}), and nothing else.`, action: "Stop", danger: true }, "/api/leftovers/stop", { session_id: p.session_id, job_id: p.job_id }, "Every process of it has ended.")}>
              Stop
            </button>
          </div>
        ))}
      </Card>

      <Card>
        <Head title="Worktrees" n={s.worktrees.length} hint="Worktrees of the repositories sessions work in that no live session works in now. One with nothing uncommitted can be removed: its branch and commits stay, and the ignored files in it go with it (you are told how many first)." />
        {s.worktrees.length === 0 && <p className="k-empty py-4">No worktree is left without a session.</p>}
        {s.worktrees.map((w) => (
          <div key={w.path} className="flex min-h-10 items-center gap-3 border-b border-line/60 py-1.5 text-ui last:border-0" data-testid="leftover-worktree" data-path={w.path}>
            <PathText path={w.path} className="font-mono text-caption" />
            <span className="w-48 shrink-0 truncate font-mono text-caption text-muted" title={w.branch ?? `detached at ${w.head.slice(0, 10)}`}>{w.branch ?? "detached"}</span>
            <span className="w-[22rem] shrink-0 truncate text-caption tabular-nums" data-testid="leftover-worktree-holds">
              {w.missing ? <span className="text-faint">folder gone</span>
                : <>
                  <span className={w.dirty ? "text-warn" : "text-faint"}>{w.dirty === undefined ? "status unknown" : `${w.dirty} uncommitted`}</span>
                  {!!w.ignored?.length && <span className="text-warn" title={w.ignored.join("\n")}>, {w.ignored.length} ignored</span>}
                  {w.ahead !== undefined && <span className={w.ahead ? "text-fg" : "text-faint"}>, {w.ahead} {w.ahead === 1 ? "commit" : "commits"} not on {w.base}</span>}
                </>}
            </span>
            <Who by={w.by} />
            <span className="w-16 shrink-0 text-right text-caption tabular-nums text-faint" title={w.made ? when(w.made) : undefined}>{w.made ? ago(w.made) : ""}</span>
            <button type="button" className={btn} data-testid="leftover-remove" disabled={busy !== null || !w.removable} title={w.removable ? undefined : `Kept: ${w.why}`}
              onClick={() => act(`w:${w.path}`, { title: "Remove this worktree?", body: `${w.path}\n\nThe folder goes. ${w.branch ? `Branch ${w.branch} and its commits stay.` : "It is detached and holds no commit of its own."}${w.ignored?.length ? `\n\n${ignoredSay(w.ignored)}` : ""}`, action: "Remove", danger: true }, "/api/leftovers/worktree/remove", { repo: w.repo, path: w.path, head: w.head, ignored: w.ignored?.length ?? 0 }, "Removed.")}>
              Remove
            </button>
          </div>
        ))}
      </Card>

      <Card>
        <Head title="Branches" n={s.branches.length} hint="Branches no worktree has out and no live session holds, those with work not on the base first. One whose commits are all on the base can be deleted." />
        {s.branches.length === 0 && <p className="k-empty py-4">No branch is left without a session.</p>}
        {branches.map((b) => (
          <div key={`${b.repo}:${b.name}`} className="flex min-h-10 items-center gap-3 border-b border-line/60 py-1.5 text-ui last:border-0" data-testid="leftover-branch" data-name={b.name}>
            <span className="min-w-0 flex-1 truncate font-mono text-caption" title={`${b.name}\n${b.top}`}>{b.name}</span>
            <span className="w-56 shrink-0 truncate text-caption text-faint" title={b.top}>{b.top.split("/").pop()}</span>
            <span className="w-64 shrink-0 whitespace-nowrap text-caption tabular-nums">
              {b.ahead === undefined ? <span className="text-faint">no base to compare</span>
                : b.merged ? <span className="text-ok">all on {b.base}</span>
                : <span className="text-fg">{b.ahead} {b.ahead === 1 ? "commit" : "commits"} not on {b.base}</span>}
            </span>
            <Who by={b.by} />
            <span className="w-16 shrink-0 text-right text-caption tabular-nums text-faint" title={when(b.at)}>{ago(b.at)}</span>
            <button type="button" className={btn} data-testid="leftover-delete" disabled={busy !== null || !b.merged} title={b.merged ? undefined : "Kept: it holds commits that are not on the base"}
              onClick={() => act(`b:${b.name}`, { title: "Delete this branch?", body: `${b.name} in ${b.top}\n\nEvery commit of it is on ${b.base}: nothing is lost.`, action: "Delete", danger: true }, "/api/leftovers/branch/delete", { repo: b.repo, branch: b.name, sha: b.sha }, "Deleted.")}>
              Delete
            </button>
          </div>
        ))}
        {s.branches.length > SHOWN && (
          <div className="py-3">
            <button type="button" className={btn} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${s.branches.length}`}</button>
          </div>
        )}
      </Card>
    </div>
  );
}
