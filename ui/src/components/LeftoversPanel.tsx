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
import { Empty, Group, Item, List, More, Page, Status } from "./settings/kit.tsx";

type By = { session_id: string; title: string; how?: "keel" | "found" };
// `scope`: what the daemon's last look at the command's job scope found (its memory, since when it idles, its
// build daemons) and what becomes of it. `earlier`: a daemon before this one started it.
type Fate = { act: "stop" | "stop-builds" | "keep"; why: string };
type Scope = { memory_bytes: number; idle_since: number; command_ended: boolean; builds: { pid: number; kind: string; idle_since: number; memory_bytes: number }[]; fate: Fate; keep: boolean };
type Proc = { session_id: string; title: string; agent?: { id: string; status: string }; job_id: string; command: string; cwd: string; started: number; running: boolean; pids: number[]; ports: number[]; contain?: string; earlier?: boolean; scope?: Scope };
type Held = { scopes: number; memory_bytes: number; others: { scopes: number; memory_bytes: number }; at: number; bounds: { idle_ms: number; build_idle_ms: number } };
type Tree = { repo: string; top: string; path: string; branch?: string; head: string; made?: number; dirty?: number; ignored?: string[]; ahead?: number; base?: string; locked?: boolean; missing?: boolean; by?: By; removable: boolean; why?: string;
  // The base holds its branch's work though not its commits: "whole" (its branch goes too), "earlier" (an older base commit
  // held it, the tip no longer does) or "changed" (landed edited): the branch stays for those two.
  landed?: { how: "whole" | "earlier" | "changed"; at: string; words: string }; bytes?: number;
  // Commits only its HEAD's reflog reaches (a detached HEAD, an unfinished rebase): only its own Remove takes it.
  reflog?: number };
type Branch = { repo: string; top: string; name: string; sha: string; at: number; base?: string; ahead?: number; behind?: number; merged: boolean; by?: By };
// A job scope that is not this daemon's job (another daemon's, or one whose processes carry another daemon's mark).
// `daemon_live`: a daemon of the state folder its processes were started over runs now. `holds_self`: this daemon is in it.
type Foreign = { cgroup: string; unit: string; why?: string; tasks: number; cpu_ms?: number; memory_bytes: number; since?: number; commands: string[]; marks: string[]; sessions: string[]; cwd?: string; gone?: boolean; states?: string[]; daemon_live?: boolean; holds_self?: boolean };
type Survey = { processes: Proc[]; worktrees: Tree[]; branches: Branch[]; repos: string[]; held?: Held; foreign?: Foreign[] };

// Processor time, as a person reads it: "12 s", "7 min", "4 h 38 min".
const cpuText = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
const mb = (b: number) => `${b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) : Math.round(b / (1 << 20))} ${b >= 1 << 30 ? "GB" : "MB"}`;
// What becomes of a command's scope, in one line under it.
function fateLine(sc: Scope): string {
  if (sc.fate.act === "stop") return `Being stopped: ${sc.fate.why}.`;
  if (sc.fate.act === "stop-builds") return `Its build daemon is being stopped: ${sc.fate.why}.`;
  const idle = Date.now() - sc.idle_since;
  return `Kept: ${sc.fate.why}.${idle >= 60_000 ? ` Idle ${ago(sc.idle_since).replace(/ ago$/, "")}.` : ""}`;
}

const SHOWN = 40;
// What git deletes with a worktree without asking: its ignored files, said by count and the first names.
// Commits only the worktree's HEAD reflog reaches: what its own Remove lets go, said in its dialog.
const reflogSay = (n: number) => `${n === 1 ? "1 commit only its HEAD's reflog reaches goes" : `${n} commits only its HEAD's reflog reaches go`} with it (made on a detached HEAD or by a rebase that did not finish, often the picks of an aborted rebase). No branch holds ${n === 1 ? "it" : "them"}.`;
const ignoredSay = (names: string[]) => `${names.length === 1 ? "1 ignored path goes" : `${names.length} ignored paths go`} with it: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}.`;

// Who an item is known by. "found": it was new in the repository when that agent ended, and who made it is not
// known (the agent, something it started, the owner, another session).
const HOW = { keel: "Keel made it for this session", found: "New in the repository when this agent ended; who made it is not known" };
function Who({ by }: { by?: By }) {
  if (!by) return <span className="text-faint">no session known</span>;
  return (
    <span className="flex max-w-52 items-baseline gap-1.5 k-truncate" data-testid="leftover-by" data-how={by.how}>
      {by.how === "found" && <span className="shrink-0 text-faint" title={HOW.found}>found by</span>}
      <button type="button" className="k-link min-w-0 k-truncate text-left hover:underline" title={`${by.title}${by.how ? `\n${HOW[by.how]}` : ""}`} onClick={() => navigate({ name: "session", id: by.session_id })}>
        {by.title || "Untitled"}
      </button>
    </span>
  );
}

// Who a whole group is known by, when it is one session for every row of two or more: said once under the group's
// name, not on each row.
function sameBy(rows: { by?: By }[]): By | undefined {
  const first = rows[0]?.by;
  return first && rows.length > 1 && rows.every((r) => r.by && r.by.session_id === first.session_id && r.by.how === first.how) ? first : undefined;
}
const ByLine = ({ by }: { by: By }) => <p className="mt-0.5">All of them: <Who by={by} /></p>;

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

  const keep = async (p: Proc, on: boolean) => {
    setBusy(`k:${p.job_id}`);
    try {
      await api("/api/leftovers/keep", { method: "POST", body: JSON.stringify({ session_id: p.session_id, job_id: p.job_id, keep: on }) });
      setSaid(on ? "Kept: Keel will not stop it." : "Keel stops it again once it idles and its session has ended.");
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (!s) return <Empty testid="leftovers-loading">Reading what sessions left behind.</Empty>;
  const procBy = sameBy(s.processes.map((p) => ({ by: { session_id: p.session_id, title: p.title } })));
  const treeBy = sameBy(s.worktrees), branchBy = sameBy(s.branches);
  const branches = all ? s.branches : s.branches.slice(0, SHOWN);
  // The whole list in one act: every worktree that can be removed and every branch that is all on its base, as shown.
  const trees = s.worktrees.filter((w) => w.removable && !w.reflog), merged = s.branches.filter((b) => b.merged);
  const ignoredAll = trees.reduce((n, w) => n + (w.ignored?.length ?? 0), 0);
  // What the button removes, said on it: how many of each, and the ignored files that go with the worktrees.
  const allLabel = trees.length + merged.length
    ? `Remove all: ${[trees.length ? `${trees.length} ${trees.length === 1 ? "worktree" : "worktrees"}` : "", merged.length ? `${merged.length} ${merged.length === 1 ? "branch" : "branches"}` : ""].filter(Boolean).join(" and ")}${ignoredAll ? `, ${ignoredAll} ignored ${ignoredAll === 1 ? "path" : "paths"} with them` : ""}`
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
  // The landed pass: the worktrees whose branch's work the base holds, with what they hold on disk.
  const landed = s.worktrees.filter((w) => w.removable && w.branch && !w.missing && w.landed && !w.reflog);
  const landedWhole = landed.filter((w) => w.landed!.how === "whole").length;
  const landedBytes = landed.reduce((n, w) => n + (w.bytes ?? 0), 0);
  const landedIgnored = landed.reduce((n, w) => n + (w.ignored?.length ?? 0), 0);
  // Told apart from the whole list's button: it names the landing, the branches it deletes and what it frees.
  const landedLabel = `Remove ${landed.length} landed ${landed.length === 1 ? "worktree" : "worktrees"}${landedWhole ? ` and ${landedWhole} ${landedWhole === 1 ? "branch" : "branches"}` : ""}${landedBytes >= 1 << 20 ? `, ${mb(landedBytes)}` : ""}`;
  const removeLanded = async () => {
    const changed = landed.length - landedWhole;
    const body = [landedWhole ? `${landedWhole} ${landedWhole === 1 ? "worktree goes with its branch" : "worktrees go with their branches"}: the base holds every line of their work.` : "",
      changed ? `${changed} ${changed === 1 ? "worktree goes and its branch stays" : "worktrees go and their branches stay"}: their work landed with changes, or the base changed it since, so their commits are kept.` : "",
      landedIgnored ? `${landedIgnored} ignored ${landedIgnored === 1 ? "path goes" : "paths go"} with them (build output, installed packages, copied files).` : ""].filter(Boolean).join("\n");
    if (!(await confirmAction({ title: `${landedLabel}?`, body: `${body}\n\nNothing uncommitted is in any of them. Each is checked again first: one that changed since it was listed stays.`, action: "Remove", danger: true }))) return;
    setBusy("landed");
    try {
      const r = await api<{ removed: string[]; deleted: string[]; refused: { what: string; why: string }[]; bytes: number }>("/api/leftovers/remove-landed", { method: "POST", body: JSON.stringify({
        worktrees: landed.map((w) => ({ repo: w.repo, path: w.path, head: w.head, ignored: w.ignored?.length ?? 0, how: w.landed!.how })),
      }) });
      setSaid(`Removed ${r.removed.length} ${r.removed.length === 1 ? "worktree" : "worktrees"}${r.bytes ? ` (${mb(r.bytes)})` : ""}${r.deleted.length ? ` and ${r.deleted.length} ${r.deleted.length === 1 ? "branch" : "branches"}` : ""}.${r.refused.length ? ` Kept ${r.refused.length}: ${r.refused.slice(0, 3).map((x) => `${x.what} (${x.why})`).join("; ")}${r.refused.length > 3 ? "; ..." : ""}` : ""}`);
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(null);
      void load();
    }
  };
  const foreign = s.foreign ?? [];
  const left = foreign.filter((f) => !f.daemon_live), running = foreign.filter((f) => f.daemon_live);
  const foreignItem = (f: Foreign) => (
    <Item key={f.cgroup} testid="leftover-foreign" data-unit={f.unit} mono name={f.commands[0] ?? "no process"}
      title={f.commands.join("\n")}
      sub={<span className="block k-truncate" title={[f.cgroup, f.why, f.marks.length ? `marks ${f.marks.join(", ")}` : "", f.sessions.length ? `sessions ${f.sessions.join(", ")}` : ""].filter(Boolean).join("\n")}>
        {f.commands.length > 1 ? `+${f.commands.length - 1} more kinds · ` : ""}{f.unit}{f.cwd ? ` · ${f.cwd}${f.gone ? " (folder gone)" : ""}` : ""}
      </span>}
      meta={<>
        <span data-testid="leftover-foreign-tasks">{f.tasks} {f.tasks === 1 ? "task" : "tasks"}</span>
        <span data-testid="leftover-foreign-cpu" title="Processor time its processes have used">{f.cpu_ms === undefined ? "" : `${cpuText(f.cpu_ms)} CPU`}</span>
        <span className="w-14 text-right" title="Memory of its scope">{mb(f.memory_bytes)}</span>
        <span className="w-14 text-right text-faint" title={f.since ? `Its oldest process started ${when(f.since)}` : undefined}>{f.since ? ago(f.since) : ""}</span>
      </>}
      status={f.holds_self ? <Status tone="warn" testid="leftover-foreign-self" title="This daemon runs in that scope: stopping it would end this daemon too.">holds this daemon</Status>
        : f.daemon_live ? <Status tone="warn" testid="leftover-foreign-live" title="A daemon runs over the state folder these commands were started from: this is its live work.">its daemon is running</Status> : undefined}
      actions={f.holds_self ? undefined : <button type="button" className="k-btn" data-testid="leftover-foreign-stop" disabled={busy !== null}
        onClick={() => act(`f:${f.cgroup}`, { title: "Stop this job scope?", body: `${f.daemon_live ? "Its daemon is running: this is its live work, and it will not be told.\n\n" : ""}${f.unit}\n\n${f.commands.join("\n")}\n\n${f.tasks} ${f.tasks === 1 ? "process" : "processes"}, ${cpuText(f.cpu_ms ?? 0)} of processor time${f.cwd ? `, working in ${f.cwd}` : ""}. It is not this daemon's job: whatever started it will not be told.`, action: "Stop", danger: true }, "/api/leftovers/foreign/stop", { cgroup: f.cgroup, marks: f.marks }, "Every process of it has ended.")}>
        Stop
      </button>} />
  );
  const age = (t: number | undefined) => <span className="w-14 text-right text-faint" title={t ? when(t) : undefined}>{t ? ago(t) : ""}</span>;
  return (
    <Page testid="leftovers">
      <Group hint={<span role="status" data-testid="leftovers-said">{said ?? "Keel removes by itself only the worktrees it made for agents, when nothing in them would be lost. The rest is yours to remove here."}</span>}
        actions={<>{!!landed.length && <button type="button" className="k-btn k-btn-lg" data-testid="leftovers-remove-landed" disabled={busy !== null}
          title="Worktrees with nothing uncommitted whose branch's work is on the base: a branch goes too when the base holds its every line" onClick={removeLanded}>
          {landedLabel}
        </button>}<button type="button" className="k-btn k-btn-lg" data-testid="leftovers-remove-all" disabled={busy !== null || !(trees.length + merged.length)}
          title={trees.length + merged.length ? "Every worktree with nothing uncommitted and every branch whose commits are all on its base" : undefined} onClick={removeAll}>
          {allLabel}
        </button></>} />

      <Group title="Left running" count={s.processes.length} hint={<>
        <p>{`Commands of sessions whose processes still run after the command's call ended, from this daemon and the ones before it.${s.held?.at ? ` They hold ${mb(s.held.memory_bytes)}.` : ""} ${s.held ? `One whose session ended is stopped once it idles for ${Math.round(s.held.bounds.idle_ms / 60_000)} minutes; a build daemon (Gradle, Kotlin, Bazel, sccache) when its session ends or it builds nothing for ${Math.round(s.held.bounds.build_idle_ms / 60_000)}.` : ""} One with a terminal in it (tmux, script, an editor) or a process put in it from outside is kept until you stop it. Keep one to leave it running.${s.held?.others.scopes ? ` ${s.held.others.scopes} job ${s.held.others.scopes === 1 ? "scope" : "scopes"} of other Keel daemons (${mb(s.held.others.memory_bytes)}) are not this daemon's and are left alone.` : ""}`}</p>
        {procBy && <ByLine by={{ session_id: s.processes[0]!.session_id, title: s.processes[0]!.title }} />}
      </>}>
        {s.processes.length === 0 ? <Empty>Nothing is left running.</Empty> : (
          <List label="Left running">
            {s.processes.map((p) => (
              <Item key={`${p.session_id}:${p.job_id}`} testid="leftover-process" data-job={p.job_id} mono name={p.command} title={`${p.command}\n${p.cwd}`}
                sub={p.scope && <span className={cn("block k-truncate", p.scope.fate.act !== "keep" && "text-warn")} data-testid="leftover-fate" data-act={p.scope.fate.act}
                  title={p.scope.builds.length ? p.scope.builds.map((b) => `${b.kind}, pid ${b.pid}, ${mb(b.memory_bytes)}`).join("\n") : undefined}>{fateLine(p.scope)}</span>}
                meta={<>
                  {p.ports.map((port) => <Status key={port} tone="info" testid="leftover-port">:{port}</Status>)}
                  {!p.running && <Status bare title="Its command ended; what it started runs on.">command ended</Status>}
                  {p.earlier && <Status bare title="A daemon before this one started it; this one took it back at its start." testid="leftover-earlier">before restart</Status>}
                  {!!p.scope?.builds.length && <Status bare>{[...new Set(p.scope.builds.map((b) => b.kind))].join(", ")}</Status>}
                  {p.agent && (p.agent.status === "running" || p.agent.status === "waiting" ? <Status bare>agent {p.agent.status}</Status> : <Status tone="warn">agent {p.agent.status}</Status>)}
                  <span className="w-14 text-right" data-testid="leftover-memory" title="Memory of its scope">{p.scope ? mb(p.scope.memory_bytes) : ""}</span>
                  <span className="text-faint" title={`pid ${p.pids.join(", ")}`}>pid {p.pids[0]}{p.pids.length > 1 ? ` +${p.pids.length - 1}` : ""}</span>
                  {!procBy && <Who by={{ session_id: p.session_id, title: p.title }} />}
                  {age(p.started)}
                </>}
                actions={<>
                  {p.scope && <button type="button" className="k-btn aria-pressed:bg-accent-soft aria-pressed:shadow-[inset_0_0_0_1px_var(--accent)] aria-pressed:text-accent-ink" data-testid="leftover-keep" aria-label={`Keep ${p.command}`} aria-pressed={p.scope.keep} disabled={busy !== null}
                    title={p.scope.keep ? "Kept: Keel does not stop it. Click to let Keel stop it again when it idles." : "Keep it running: Keel will not stop it"}
                    onClick={() => void keep(p, !p.scope!.keep)}>
                    {p.scope.keep ? "Kept" : "Keep"}
                  </button>}
                  <button type="button" className="k-btn" data-testid="leftover-stop" aria-label={`Stop ${p.command}`} disabled={busy !== null}
                    onClick={() => act(`p:${p.job_id}`, { title: "Stop this command?", body: `${p.command}\n\nEvery process it started is stopped (${p.pids.length}), and nothing else.`, action: "Stop", danger: true }, "/api/leftovers/stop", { session_id: p.session_id, job_id: p.job_id }, "Every process of it has ended.")}>
                    Stop
                  </button>
                </>} />
            ))}
          </List>
        )}
      </Group>

      {!!left.length && (
        <Group title="Job scopes of other daemons" count={left.length} testid="leftover-foreign-group" hint="Job scopes that run and are not this daemon's job: a scratch or test daemon's that is gone, another state folder's, or one of this daemon's whose processes carry another daemon's mark. Keel never stops one by itself. Stop one here when nothing needs what it holds: every process in it ends.">
          <List label="Job scopes of other daemons">{left.map(foreignItem)}</List>
        </Group>
      )}
      {!!running.length && (
        <Group title="Work of daemons that are running" count={running.length} testid="leftover-foreign-live-group" hint="Job scopes whose commands were started by a daemon that runs now (another Keel on this machine, or a scratch one). It is that daemon's live work; stopping one ends commands its sessions may be waiting on.">
          <List label="Work of daemons that are running">{running.map(foreignItem)}</List>
        </Group>
      )}

      <Group title="Worktrees" count={s.worktrees.length} hint={<>
        <p>Worktrees of the repositories sessions work in that no live session works in now. One with nothing uncommitted can be removed: its branch and commits stay, and the ignored files in it go with it (you are told how many first).</p>
        {treeBy && <ByLine by={treeBy} />}
      </>}>
        {s.worktrees.length === 0 ? <Empty>No worktree is left without a session.</Empty> : (
          <List label="Worktrees">
            {s.worktrees.map((w) => (
              <Item key={w.path} testid="leftover-worktree" data-path={w.path} name={<PathText path={w.path} className="font-mono text-caption" />}
                sub={<span className="flex min-w-0 flex-wrap gap-x-3 tabular-nums">
                  <span className="font-mono text-muted" title={w.branch ?? `detached at ${w.head.slice(0, 10)}`}>{w.branch ?? "detached"}</span>
                  <span data-testid="leftover-worktree-holds">
                    {w.missing ? <span className="text-faint">folder gone</span>
                      : <>
                        <span className={w.dirty ? "text-warn" : "text-faint"}>{w.dirty === undefined ? "status unknown" : `${w.dirty} uncommitted`}</span>
                        {!!w.ignored?.length && <span className="text-warn" title={w.ignored.join("\n")}>, {w.ignored.length} ignored</span>}
                        {w.ahead !== undefined && <span className={w.ahead ? "text-fg" : "text-faint"}>, {w.ahead} {w.ahead === 1 ? "commit" : "commits"} not on {w.base}</span>}
                        {!!w.reflog && <span className="text-warn" data-testid="leftover-reflog" title="Made on a detached HEAD or by a rebase that did not finish: only this worktree's own Remove lets them go">, {w.reflog} only on its HEAD's reflog</span>}
                      </>}
                  </span>
                </span>}
                meta={<>
                  {w.landed && <Status bare tone={w.landed.how === "whole" ? "ok" : "quiet"} testid="leftover-landed" title={`${w.landed.words}${w.landed.how === "whole" ? ": its branch goes with it" : ": its branch stays"}`}>{w.landed.how === "whole" ? "landed" : w.landed.how === "earlier" ? "landed, changed since" : "landed with changes"}</Status>}
                  {w.bytes !== undefined && w.bytes >= 1 << 20 && <span className="w-14 text-right" title="What it holds on disk">{mb(w.bytes)}</span>}
                  {!treeBy && <Who by={w.by} />}{age(w.made)}
                </>}
                actions={<button type="button" className="k-btn" data-testid="leftover-remove" aria-label={`Remove worktree ${w.path}`} disabled={busy !== null || !w.removable} title={w.removable ? undefined : `Kept: ${w.why}`}
                  onClick={() => act(`w:${w.path}`, { title: "Remove this worktree?", body: `${w.path}\n\nThe folder goes. ${w.branch ? `Branch ${w.branch} and its commits stay.` : "It is detached and holds no commit of its own."}${w.reflog ? `\n\n${reflogSay(w.reflog)}` : ""}${w.ignored?.length ? `\n\n${ignoredSay(w.ignored)}` : ""}`, action: "Remove", danger: true }, "/api/leftovers/worktree/remove", { repo: w.repo, path: w.path, head: w.head, ignored: w.ignored?.length ?? 0, ...(w.reflog ? { reflog: w.reflog } : {}) }, "Removed.")}>
                  Remove
                </button>} />
            ))}
          </List>
        )}
      </Group>

      <Group title="Branches" count={s.branches.length} hint={<>
        <p>Branches no worktree has out and no live session holds, those with work not on the base first. One whose commits are all on the base can be deleted.</p>
        {branchBy && <ByLine by={branchBy} />}
      </>}>
        {s.branches.length === 0 ? <Empty>No branch is left without a session.</Empty> : (
          <List label="Branches" dense>
            {branches.map((b) => (
              <Item key={`${b.repo}:${b.name}`} testid="leftover-branch" data-name={b.name} mono name={b.name} title={`${b.name}\n${b.top}`}
                sub={<span className="flex min-w-0 flex-wrap gap-x-3 tabular-nums">
                  <span title={b.top}>{b.top.split("/").pop()}</span>
                  {b.ahead === undefined ? <span>no base to compare</span>
                    : b.merged ? <span className="text-ok">all on {b.base}</span>
                    : <span className="text-fg">{b.ahead} {b.ahead === 1 ? "commit" : "commits"} not on {b.base}</span>}
                </span>}
                meta={<>{!branchBy && <Who by={b.by} />}{age(b.at)}</>}
                actions={<button type="button" className="k-btn" data-testid="leftover-delete" aria-label={`Delete branch ${b.name}`} disabled={busy !== null || !b.merged} title={b.merged ? undefined : "Kept: it holds commits that are not on the base"}
                  onClick={() => act(`b:${b.name}`, { title: "Delete this branch?", body: `${b.name} in ${b.top}\n\nEvery commit of it is on ${b.base}: nothing is lost.`, action: "Delete", danger: true }, "/api/leftovers/branch/delete", { repo: b.repo, branch: b.name, sha: b.sha }, "Deleted.")}>
                  Delete
                </button>} />
            ))}
            {s.branches.length > SHOWN && <More><button type="button" className="k-btn" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${s.branches.length}`}</button></More>}
          </List>
        )}
      </Group>
    </Page>
  );
}
