import { Popover } from "@base-ui/react/popover";
import { Archive, ArchiveRestore, ExternalLink, GitBranch, GitMerge, GitPullRequest, MoveLeft, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { isGitFolder, loadBranches, loadWorktree, setStartBase, setStartInWorktree, setStartPr, startBase, useHead, useStartBase, useStartInWorktree, useStartPr, useWorktree, type BranchList } from "../lib/worktree.ts";
import { loadOverlap, mineOf, useOverlap } from "../lib/overlap.ts";
import { OverlapList } from "./BranchesPanel.tsx";
import { stoppingShells } from "../lib/shells.ts";
import { confirmAction } from "./Confirm.tsx";
import { popupClass } from "./ui.tsx";
import { Select } from "./Select.tsx";

type Pr = { number: number; url: string; title: string; state: string; isDraft: boolean; head_matches?: boolean; checks?: { summary: string; passed: number; failed: number; pending: number; rows: { name: string; status: string; url?: string }[] } };
const CHECKS: Record<string, { text: string; cls: string }> = {
  passing: { text: "checks pass", cls: "text-ok" }, failing: { text: "checks fail", cls: "text-danger" },
  pending: { text: "checks running", cls: "text-warn" }, action_required: { text: "checks wait on a person", cls: "text-warn" },
};

// A session at a pull request's head from a fork (or one nobody could vouch for): its own instructions are not
// loaded, and the owner trusts the head here.
export function HeadChip({ session }: { session: Session }) {
  const head = useHead(session.id);
  const [busy, setBusy] = useState(false);
  if (!head?.held) return null;
  const trust = async () => {
    setBusy(true);
    try {
      await api(`/api/sessions/${session.id}/head/trust`, { method: "POST", body: "{}" });
      await loadWorktree(session.id);
    } catch (e) {
      reportError(e, { at: "HeadChip" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span data-testid="head-held" title={head.why} className="inline-flex h-7 max-w-[26rem] items-center gap-1.5 rounded-lg bg-warn/10 pl-2 pr-0.5 text-caption text-warn">
      <ShieldAlert className="size-3.5 shrink-0" />
      <span className="truncate">PR from a fork: its instructions are not loaded</span>
      <button
        type="button" disabled={busy} data-testid="head-trust" onClick={trust}
        title={`Trust the head of pull request ${head.number}: its instruction files, skills, hooks and checks load as the repository's own`}
        className="h-6 shrink-0 rounded-md bg-warn/15 px-2 text-caption font-medium hover:bg-warn/25 disabled:opacity-50"
      >
        Trust
      </button>
    </span>
  );
}

const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-ui hover:bg-hover disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:text-faint";

// The session's managed worktree in the header: its branch, park and
// restore, the pull request, removal.
export function WorktreeChip({ session }: { session: Session }) {
  const wt = useWorktree(session.id);
  const overlap = useOverlap(session.id);
  const clashes = mineOf(overlap);
  const [pr, setPr] = useState<{ pr: Pr | null; available: boolean; error?: string } | null>(null);
  const [form, setForm] = useState<{ title: string; body: string; draft: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean; url?: string } | null>(null);
  const [open, setOpen] = useState(false);

  // Fresh counts when the popup opens and after each turn.
  useEffect(() => {
    if (!(open || session.phase === "idle")) return;
    loadWorktree(session.id, true).catch(reportError);
    loadOverlap(session.id).catch(reportError);
  }, [open, session.phase]);
  useEffect(() => {
    if (!open || !wt || wt.state !== "active") return;
    api(`/api/sessions/${session.id}/pr`).then(setPr).catch(reportError);
  }, [open, wt?.state, wt?.commits_ahead]);

  if (!wt || (wt.state === "removed" && !wt.snapshot_ref)) return null;
  const act = async (f: () => Promise<any>, ok?: (r: any) => { text: string; url?: string } | undefined) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await f();
      if (ok) setMsg(ok(r) ?? null);
      await loadWorktree(session.id);
    } catch (e) {
      setMsg({ text: failed(e, { at: "WorktreeChip" }), error: true });
    } finally {
      setBusy(false);
    }
  };
  const post = (path: string, body?: object) => api(`/api/sessions/${session.id}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  // The folder goes or moves: background commands still running in it are
  // named first, and stopped only when the owner says so.
  const shells = <T,>(run: (stop: boolean) => Promise<T>, verb: string) => stoppingShells(run, { verb, where: "the worktree" });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="worktree-chip"
        className={cn(
          "k-worktree-chip inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg data-popup-open:bg-hover",
          wt.state !== "active" && "text-warn",
        )}
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-mono">{wt.branch.replace(/^keel\//, "")}</span>
        {wt.state !== "active" && <span className="text-micro">{wt.state}</span>}
        {clashes.length > 0 && (
          <span data-testid="overlap-mark" data-count={clashes.length} title={`Would conflict with ${clashes.length === 1 ? "1 branch" : `${clashes.length} branches`} when landing`}
            className="inline-flex h-[1.125rem] shrink-0 items-center gap-0.5 rounded-md bg-warn/12 px-1 font-mono text-micro font-medium text-warn">
            <GitMerge className="size-3" />{clashes.length}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className={cn(popupClass, "w-[min(24rem,calc(100vw-1rem))] p-3")} data-testid="worktree-popup">
            <Popover.Title className="flex items-center gap-2 text-ui font-medium">
              <GitBranch className="size-4 text-accent" />
              <span className="truncate font-mono">{wt.branch}</span>
            </Popover.Title>
            <p className="mt-0.5 text-caption text-muted">
              Worktree from <span className="font-mono">{wt.base.length === 40 ? wt.base.slice(0, 8) : wt.base}</span>
              {wt.state === "active"
                ? <> · {wt.dirty} changed file{wt.dirty === 1 ? "" : "s"} · {wt.commits_ahead} commit{wt.commits_ahead === 1 ? "" : "s"} ahead</>
                : wt.state === "parked" ? " · parked: the folder is gone, its work saved" : " · removed"}
            </p>
            <p className="mt-1 truncate font-mono text-micro text-faint" title={wt.path}>{wt.path}</p>

            {clashes.length > 0 && overlap?.mine && (
              <div className="mt-3 rounded-lg border border-warn/35 bg-warn/6 px-2.5 py-2" data-testid="overlap-popup">
                <p className="flex items-center gap-1.5 text-caption font-medium text-warn"><GitMerge className="size-3.5" /> Would conflict when landing</p>
                <OverlapList pairs={clashes} mine={overlap.mine} compact />
              </div>
            )}

            {wt.state === "active" && pr?.pr && (
              <a href={pr.pr.url} target="_blank" rel="noreferrer" data-testid="pr-link" className="mt-3 flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-ui hover:bg-hover">
                <GitPullRequest className="size-4 text-ok" />
                <span className="min-w-0 flex-1 truncate">#{pr.pr.number} {pr.pr.title}</span>
                <span className="text-micro text-faint">{pr.pr.isDraft ? "draft" : pr.pr.state.toLowerCase()}</span>
                <ExternalLink className="size-3.5 text-faint" />
              </a>
            )}
            {wt.state === "active" && pr?.pr?.checks && pr.pr.checks.summary !== "none" && (
              <details className="mt-1.5 text-caption" data-testid="pr-checks">
                <summary className={cn("cursor-pointer", CHECKS[pr.pr.checks.summary]?.cls)}>
                  {CHECKS[pr.pr.checks.summary]?.text}: {pr.pr.checks.passed} passed{pr.pr.checks.failed ? `, ${pr.pr.checks.failed} failed` : ""}{pr.pr.checks.pending ? `, ${pr.pr.checks.pending} running` : ""}
                  {pr.pr.head_matches === false && <span className="text-warn"> · the pull request is not at your local head</span>}
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {pr.pr.checks.rows.map((c, i) => (
                    <li key={i} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{c.url ? <a className="hover:underline" href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}</span><span className="text-faint">{c.status}</span></li>
                  ))}
                </ul>
              </details>
            )}
            {wt.state === "active" && pr && !pr.available && <p className="mt-3 text-caption text-faint" data-testid="pr-unavailable">Pull requests: {pr.error}</p>}

            {form && (
              <form
                className="mt-3 flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(() => post("/pr", form), (r) => ({ text: "Pull request opened.", url: r.url })).then(() => setForm(null));
                }}
              >
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" data-testid="pr-title"
                  className="k-field" />
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Description" rows={3}
                  className="k-field h-auto resize-none py-1.5" />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-caption text-muted">
                    <input type="checkbox" checked={form.draft} onChange={(e) => setForm({ ...form, draft: e.target.checked })} className="accent-[var(--accent)]" /> Draft
                  </label>
                  <span className="ml-auto text-micro text-faint">Pushes the branch to origin</span>
                  <button type="submit" disabled={busy} data-testid="pr-create" className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50">Create</button>
                </div>
              </form>
            )}

            {msg && (
              <p className={cn("mt-3 text-caption", msg.error ? "text-danger" : "text-ok")} data-testid="worktree-msg">
                {msg.text} {msg.url && <a className="underline" href={msg.url} target="_blank" rel="noreferrer">{msg.url}</a>}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-1 border-t border-line pt-2">
              {wt.state === "active" && (
                <>
                  {!pr?.pr && !form && (
                    <button className={btn} disabled={busy} data-testid="pr-open" onClick={() => setForm({ title: session.title, body: "", draft: false })}>
                      <GitPullRequest /> Open pull request
                    </button>
                  )}
                  <button className={btn} disabled={busy} data-testid="handoff-main" title="The main checkout switches to this branch and gets the uncommitted work; this folder goes"
                    onClick={() => act(() => shells((stop) => post("/worktree/handoff", { to: "main", stop_shells: stop }), "Moving"), (r) => r && ({ text: `Moved to the main checkout on ${r.branch}.` }))}>
                    <MoveLeft /> Move to main checkout
                  </button>
                  <button className={btn} disabled={busy} data-testid="worktree-park" onClick={() => act(() => shells((stop) => post("/worktree/park", { stop_shells: stop }), "Parking"), (r) => r && ({ text: "Parked. The working state is saved on a ref." }))}>
                    <Archive /> Park
                  </button>
                </>
              )}
              {wt.state !== "active" && (wt.state === "parked" || wt.snapshot_ref) && (
                <button className={btn} disabled={busy} data-testid="worktree-restore" onClick={() => act(() => post("/worktree/restore"), () => ({ text: "Restored." }))}>
                  <ArchiveRestore /> Restore
                </button>
              )}
              {wt.state !== "removed" && (
                <button
                  className={cn(btn, "ml-auto text-danger [&>svg]:text-danger hover:bg-danger-soft")}
                  disabled={busy}
                  data-testid="worktree-remove"
                  onClick={() => act(async () => {
                    const del = (q: string) => shells((stop) => api(`/api/sessions/${session.id}/worktree?${q}${stop ? "&stop_shells=1" : ""}`, { method: "DELETE" }), "Removing");
                    let r = await del("");
                    if (r && !r.removed && (await confirmAction({ title: "Remove the worktree?", body: `The worktree ${r.reason}. Its working state is kept on a ref.`, action: "Remove", danger: true }))) r = await del("snapshot=1");
                    return r;
                  }, (r) => r && ({ text: r.removed ? `Removed${r.branch_deleted ? ", with its branch" : ""}.` : `Kept: ${r.reason}.` }))}
                >
                  <Trash2 /> Remove
                </button>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The start box's choice: start the session in a new worktree (git folders only), and from
// which branch.
export function WorktreeToggle({ workspace }: { workspace: string }) {
  const on = useStartInWorktree();
  const pr = useStartPr(workspace).trim();
  const [git, setGit] = useState(false);
  useEffect(() => { if (workspace) isGitFolder(workspace).then(setGit); }, [workspace]);
  if (!git) return null;
  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        data-testid="start-in-worktree"
        onClick={() => setStartInWorktree(!on)}
        title="Work on a new branch in its own folder, so this checkout stays as it is"
        className="k-chip-pick"
      >
        <GitBranch /> {on ? "In a new worktree" : "New worktree"}
      </button>
      {on && !pr && <WorktreeBase workspace={workspace} />}
      {on && <WorktreePr workspace={workspace} />}
    </>
  );
}

const ago = (at: number) => {
  const d = Math.max(0, Date.now() / 1000 - at);
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : `${Math.round(d / 86400)}d`;
};

// "or at pull request": a number or an address. With one, the worktree starts at that request's
// head, fetched from origin, and not at the branch picked.
function WorktreePr({ workspace }: { workspace: string }) {
  const value = useStartPr(workspace);
  return (
    <label className="k-chip-pick" data-testid="worktree-pr" title="Start at the head of a pull request (a merge request on GitLab) of origin: its number or its address">
      <GitPullRequest />
      <input
        value={value}
        onChange={(e) => setStartPr(workspace, e.target.value)}
        placeholder="Pull request"
        aria-label="Pull request to start at: its number or address"
        data-testid="worktree-pr-input"
        spellCheck={false}
        className="w-[7.5rem] min-w-0 bg-transparent font-medium text-fg outline-none placeholder:font-normal placeholder:text-faint"
      />
    </label>
  );
}

// "from <branch>": the branch the new worktree starts from. Local branches by recency, then the
// remote ones; a branch another session has out carries that session's name.
function WorktreeBase({ workspace }: { workspace: string }) {
  const base = useStartBase(workspace);
  const [list, setList] = useState<BranchList | null>(null);
  useEffect(() => {
    let live = true;
    loadBranches(workspace).then((l) => {
      if (!live) return;
      setList(l);
      if (!l.branches.some((b) => b.name === startBase(workspace)) && l.default) setStartBase(workspace, l.default);
    }).catch(reportError);
    return () => { live = false; };
  }, [workspace]);
  if (!list?.branches.length) return null;
  const row = (b: BranchList["branches"][number]) => <option key={b.name} value={b.name} label={b.name}>{`${b.name}${b.session ? ` · ${b.session.title}` : ""} · ${ago(b.at)}`}</option>;
  const kind = (k: string) => list.branches.filter((b) => b.kind === k);
  return (
    <span className="k-chip-pick" data-testid="worktree-base">
      <span className="text-faint">from</span>
      <Select value={base} aria-label="Branch the new worktree starts from" data-testid="worktree-base-select" onChange={(e) => setStartBase(workspace, e.target.value)}>
        <optgroup label="Local">{kind("local").map(row)}</optgroup>
        {kind("remote").length > 0 && <optgroup label="Remote">{kind("remote").map(row)}</optgroup>}
      </Select>
    </span>
  );
}
