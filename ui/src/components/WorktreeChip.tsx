import { Popover } from "@base-ui/react/popover";
import { Archive, ArchiveRestore, ExternalLink, GitBranch, GitPullRequest, MoveLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { isGitFolder, loadWorktree, setStartInWorktree, useStartInWorktree, useWorktree } from "../lib/worktree.ts";
import { popupClass } from "./ui.tsx";

type Pr = { number: number; url: string; title: string; state: string; isDraft: boolean; head_matches?: boolean; checks?: { summary: string; passed: number; failed: number; pending: number; rows: { name: string; status: string; url?: string }[] } };
const CHECKS: Record<string, { text: string; cls: string }> = {
  passing: { text: "checks pass", cls: "text-ok" }, failing: { text: "checks fail", cls: "text-danger" },
  pending: { text: "checks running", cls: "text-warn" }, action_required: { text: "checks wait on a person", cls: "text-warn" },
};

const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-ui hover:bg-hover disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:text-faint";

// The session's managed worktree in the header: its branch, park and
// restore, the pull request, removal.
export function WorktreeChip({ session }: { session: Session }) {
  const wt = useWorktree(session.id);
  const [pr, setPr] = useState<{ pr: Pr | null; available: boolean; error?: string } | null>(null);
  const [form, setForm] = useState<{ title: string; body: string; draft: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean; url?: string } | null>(null);
  const [open, setOpen] = useState(false);

  // Fresh counts when the popup opens and after each turn.
  useEffect(() => { if (open || session.phase === "idle") loadWorktree(session.id).catch(reportError); }, [open, session.phase]);
  useEffect(() => {
    if (!open || !wt || wt.state !== "active") return;
    api(`/api/sessions/${session.id}/pr`).then(setPr).catch(reportError);
  }, [open, wt?.state, wt?.commits_ahead]);

  if (!wt || (wt.state === "removed" && !wt.snapshot_ref)) return null;
  const act = async (f: () => Promise<any>, ok?: (r: any) => { text: string; url?: string }) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await f();
      if (ok) setMsg(ok(r));
      await loadWorktree(session.id);
    } catch (e) {
      setMsg({ text: failed(e, { at: "WorktreeChip" }), error: true });
    } finally {
      setBusy(false);
    }
  };
  const post = (path: string, body?: object) => api(`/api/sessions/${session.id}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-testid="worktree-chip"
        className={cn(
          "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg data-popup-open:bg-hover",
          wt.state !== "active" && "text-warn",
        )}
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-mono">{wt.branch.replace(/^keel\//, "")}</span>
        {wt.state !== "active" && <span className="text-micro">{wt.state}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className={cn(popupClass, "w-[24rem] p-3")} data-testid="worktree-popup">
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
                  className="h-8 rounded-lg border border-line bg-bg px-2.5 text-ui outline-none focus:border-line-strong" />
                <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Description" rows={3}
                  className="resize-none rounded-lg border border-line bg-bg px-2.5 py-1.5 text-ui outline-none focus:border-line-strong" />
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
                    onClick={() => act(() => post("/worktree/handoff", { to: "main" }), (r) => ({ text: `Moved to the main checkout on ${r.branch}.` }))}>
                    <MoveLeft /> Move to main checkout
                  </button>
                  <button className={btn} disabled={busy} data-testid="worktree-park" onClick={() => act(() => post("/worktree/park"), () => ({ text: "Parked. The working state is saved on a ref." }))}>
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
                    let r = await api(`/api/sessions/${session.id}/worktree`, { method: "DELETE" });
                    if (!r.removed && confirm(`The worktree ${r.reason}. Remove it and keep its working state on a ref?`)) r = await api(`/api/sessions/${session.id}/worktree?snapshot=1`, { method: "DELETE" });
                    return r;
                  }, (r) => ({ text: r.removed ? `Removed${r.branch_deleted ? ", with its branch" : ""}.` : `Kept: ${r.reason}.` }))}
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

// The start box's choice: start the session in a new worktree (git folders only).
export function WorktreeToggle({ workspace }: { workspace: string }) {
  const on = useStartInWorktree();
  const [git, setGit] = useState(false);
  useEffect(() => { if (workspace) isGitFolder(workspace).then(setGit); }, [workspace]);
  if (!git) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid="start-in-worktree"
      onClick={() => setStartInWorktree(!on)}
      title="Work on a new branch in its own folder, so this checkout stays as it is"
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-ui transition-colors",
        on ? "border-accent/50 bg-accent-soft text-accent-ink" : "border-line text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <GitBranch className="size-3.5" /> {on ? "In a new worktree" : "New worktree"}
    </button>
  );
}
