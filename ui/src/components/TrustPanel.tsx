import { FileCheck2, FileWarning, GitBranch, GitMerge, Package, RotateCcw, ShieldCheck, Trash2, Webhook } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Source as HookSource } from "../../../src/integrations/hooks.ts";
import type { Batch } from "../../../src/safety/quarantine.ts";
import type { ProjectFile } from "../../../src/safety/trust.ts";
import { machineApi, ownId } from "../lib/fleet-ids.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { DiffView } from "./DiffView.tsx";

type File = ProjectFile & { rel: string };
type View = { root: string | null; new_files: "auto" | "ask"; files: File[] };
type Diff = { rel: string; sha256: string | null; patch: { text: string; added: number; removed: number } };
const KIND = { instructions: "Instructions", skill: "Skill" } as const;
const ICON = { instructions: FileCheck2, skill: Package };

// The Trust panel: the repository's own files (instructions, hooks, skills)
// with what waits for the owner, the hooks that run, and the protected files
// moved to quarantine.
export function TrustPanel({ session }: { session: Session }) {
  const [view, setView] = useState<View | null>(null);
  const [hooks, setHooks] = useState<Omit<HookSource, "groups">[]>([]);
  const [hookErr, setHookErr] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [err, setErr] = useState("");
  const cwd = encodeURIComponent(session.workspace);
  // A session of another machine: its folder is there, so what is read and trusted is that machine's.
  const on = (path: string) => machineApi(session.id, path);
  const load = useCallback(() => {
    api<View>(on(`/api/trust?cwd=${cwd}`)).then(setView).catch((e) => setErr(failed(e, { at: "TrustPanel" })));
    api<{ sources: Omit<HookSource, "groups">[] }>(on(`/api/hooks?cwd=${cwd}`)).then((r) => setHooks(r.sources)).catch(reportError);
    api<{ batches: Batch[] }>(on(`/api/permissions/quarantine?session=${ownId(session.id)}`)).then((r) => setBatches(r.batches)).catch(reportError);
  }, [cwd, session.id]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if ((f.name === "quarantine" || f.name === "trust") && (!f.session_id || f.session_id === session.id)) load(); } });
  }, [load]);
  useEffect(() => { if (session.phase === "idle") load(); }, [session.phase]);

  if (!view) return <p className="k-empty px-3 py-4">{err || "Loading…"}</p>;
  const held = view.files.filter((f) => f.state !== "trusted");
  const trusted = view.files.filter((f) => f.state === "trusted");
  const live = batches.filter((b) => b.state === "held");

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3" data-testid="trust-panel">
      {!view.root && <p className="px-1 text-caption text-muted">The session's folder is not in a repository: only your own instruction files and hooks apply.</p>}
      {view.root && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 px-1 text-ui font-medium">
            <ShieldCheck className="size-4 text-accent" /> Repository files
            <span className="truncate font-mono text-micro font-normal text-faint">{view.root}</span>
          </h3>
          {held.length > 0 ? (
            <>
              <p className="px-1 text-caption text-muted">
                {held.length === 1 ? "This file is" : "These files are"} held: {view.new_files === "ask" ? "new or changed" : "changed"} since you trusted {held.length === 1 ? "it" : "them"}. A changed instruction file loads as you last trusted it; a skill does not load.
              </p>
              {held.map((f) => <HeldFile key={f.path} f={f} cwd={session.workspace} on={on} onDone={load} />)}
            </>
          ) : (
            <p className="k-empty px-1" data-testid="trust-clear">Nothing is held: every file loads as you trusted it.</p>
          )}
          {trusted.length > 0 && (
            <ul className="k-trusted-files flex flex-col rounded-xl border border-line bg-raised py-1" data-testid="trusted-files">
              {trusted.map((f) => {
                const Icon = ICON[f.kind];
                return (
                  <li key={f.path} className="flex items-center gap-2 px-3 py-1 text-caption" data-testid="trusted-file" data-landing={f.landing}>
                    <Icon className="size-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono">{f.rel}</span>
                    {/* Its pin moved with a landing of the queue that a review or your own queueing vouched for: no card asked. */}
                    <span className="text-faint" title={f.landing ? `The landing queue landed this version (commit ${f.landing}); a review that said LAND yes, or your own queueing, vouched for the change.` : undefined}>
                      {f.landing ? <>trusted with its landing <span className="font-mono">{f.landing.slice(0, 7)}</span></> : f.auto ? "pinned on first sight" : "trusted"}
                    </span>
                    {/* A skill pinned on first sight loads; its allowed-tools run without asking only once you trust it yourself. */}
                    {f.auto && f.kind === "skill" && (
                      <button type="button" data-testid="trust-own" className="k-btn" data-quiet title="Its allowed-tools then run without asking in the turn that loads it" onClick={async () => {
                        try { await api(on("/api/trust"), { method: "POST", body: JSON.stringify({ cwd: session.workspace, files: [{ path: f.path, sha256: f.sha256 }] }) }); load(); } catch (e) { setErr(failed(e, { at: "TrustPanel" })); }
                      }}>Trust it yourself</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 px-1 text-ui font-medium"><Webhook className="size-4 text-accent" /> Hooks</h3>
        {hooks.length === 0 ? <p className="k-empty px-1">No hook files: yours would be in the Keel config folder as hooks.json, a repository's in .keel/hooks.json.</p> : (
          <ul className="flex flex-col gap-1.5" data-testid="hook-sources">
            {hooks.map((h) => (
              <li key={h.path} className="rounded-xl border border-line bg-raised px-3 py-2 text-caption" data-testid="hook-source" data-active={h.active}>
                <div className="flex items-center gap-2">
                  <span className={cn("rounded px-1.5 text-micro font-medium", h.active ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn")}>{h.active ? "runs" : "held"}</span>
                  <span className="font-medium">{h.scope === "owner" ? "Yours" : "The repository's"}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-faint">{h.path}</span>
                </div>
                {Object.keys(h.events).length > 0 && <p className="mt-1 text-muted">{Object.entries(h.events).map(([e, n]) => `${e} (${n})`).join(", ")}</p>}
                {h.problems.map((p: string, i: number) => <p key={i} className="mt-0.5 text-warn">{p}</p>)}
                {h.scope === "project" && !h.active && h.sha256 && (
                  <>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-code px-2.5 py-1.5 font-mono text-micro whitespace-pre-wrap">{h.text}</pre>
                    <button data-testid="trust-hooks"
                      onClick={() => api(on("/api/hooks/trust"), { method: "POST", body: JSON.stringify({ cwd: session.workspace, sha256: h.sha256 }) }).then(load).catch((e) => setHookErr(failed(e, { at: "TrustPanel" })))}
                      className="mt-2 h-7 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90">Trust this version</button>
                    {hookErr && <p className="mt-1 text-danger">{hookErr}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <WorktreeSetupFile session={session} />
      <LandAfterStep session={session} />

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 px-1 text-ui font-medium"><FileWarning className="size-4 text-accent" /> Quarantine</h3>
        {live.length === 0 ? (
          <p className="k-empty px-1">Nothing in quarantine. A call you did not answer on a card that creates or changes a git hook, .envrc, the project's hook or MCP file or an editor task moves it here.</p>
        ) : live.map((b) => <BatchCard key={b.id} b={b} on={on} onDone={load} />)}
      </section>
    </div>
  );
}

type SetupView = { path: string; exists: boolean; state: "none" | "new" | "changed" | "pinned" | "refused"; text?: string; sha256?: string; covers?: string[]; problems: string[] };
const SETUP_STATE = { new: "held: not pinned", changed: "held: changed since you pinned it", pinned: "runs in each new worktree", refused: "cannot run", none: "" } as const;

// The repository's .keel/worktree.json: commands that run in each new worktree, so it is read and pinned like a hooks file.
function WorktreeSetupFile({ session }: { session: Session }) {
  const [v, setV] = useState<SetupView | null>(null);
  const [err, setErr] = useState("");
  const on = (path: string) => machineApi(session.id, path);
  const load = useCallback(() => { api<SetupView>(on(`/api/worktree-setup?cwd=${encodeURIComponent(session.workspace)}`)).then(setV).catch(reportError); }, [session.workspace]);
  useEffect(load, [load]);
  if (!v?.exists) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="worktree-setup-file" data-state={v.state}>
      <h3 className="flex items-center gap-2 px-1 text-ui font-medium"><GitBranch className="size-4 text-accent" /> Worktree setup</h3>
      <div className="rounded-xl border border-line bg-raised px-3 py-2 text-caption">
        <div className="flex items-center gap-2">
          <span className={cn("rounded px-1.5 text-micro font-medium", v.state === "pinned" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn")}>{v.state === "pinned" ? "runs" : "held"}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-faint">{v.path}</span>
        </div>
        <p className="mt-1 text-muted">{SETUP_STATE[v.state]}. It runs once in each new worktree of this repository, under the session's sandbox and network rules. The pin holds this file and the scripts it runs from .keel/ only: what its commands read from the rest of the tree (package.json, scripts/, install scripts) is not held. Variables it writes to $KEEL_ENV_FILE are taken only when you name them in Settings, Safety.</p>
        {v.covers && v.covers.length > 0 && <p className="mt-0.5 text-muted">The pin also covers: {v.covers.join(", ")}</p>}
        {v.problems.map((p, i) => <p key={i} className="mt-0.5 text-warn">{p}</p>)}
        {v.state !== "pinned" && v.sha256 && v.state !== "refused" && (
          <>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-code px-2.5 py-1.5 font-mono text-micro whitespace-pre-wrap">{v.text}</pre>
            <button data-testid="trust-worktree-setup" className="mt-2 h-7 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90"
              onClick={() => api(on("/api/worktree-setup/trust"), { method: "POST", body: JSON.stringify({ cwd: session.workspace, sha256: v.sha256 }) }).then(() => { setErr(""); load(); }).catch((e) => setErr(failed(e, { at: "TrustPanel" })))}>Trust this version</button>
            {err && <p className="mt-1 text-danger">{err}</p>}
          </>
        )}
      </div>
    </section>
  );
}

type AfterView = { path: string; state: "none" | "new" | "changed" | "pinned" | "refused"; command?: string; sha256?: string; covers?: string[]; texts?: { path: string; text: string }[]; land?: { push?: string; setup?: string; checks: string[] }; problems: string[] };
const AFTER_STATE = { new: "held: not trusted", changed: "held: changed since you trusted it", pinned: "runs after each landing", refused: "cannot run", none: "" } as const;

// The repository's after-land step (land.after in .keel/checks.json): it runs in this checkout after the landing
// queue moved the base, where a repository deploys or restarts what it ships, so it is read and trusted like a hooks file.
function LandAfterStep({ session }: { session: Session }) {
  const [v, setV] = useState<AfterView | null>(null);
  const [err, setErr] = useState("");
  const on = (path: string) => machineApi(session.id, path);
  const load = useCallback(() => { api<AfterView>(on(`/api/landing/after?cwd=${encodeURIComponent(session.workspace)}`)).then(setV).catch(reportError); }, [session.workspace]);
  useEffect(load, [load]);
  if (!v || v.state === "none") return null;
  return (
    <section className="flex flex-col gap-2" data-testid="land-after-step" data-state={v.state}>
      <h3 className="flex items-center gap-2 px-1 text-ui font-medium"><GitMerge className="size-4 text-accent" /> After a landing</h3>
      <div className="rounded-xl border border-line bg-raised px-3 py-2 text-caption">
        <div className="flex items-start gap-2">
          <span className={cn("mt-0.5 rounded px-1.5 text-micro font-medium", v.state === "pinned" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn")}>{v.state === "pinned" ? "runs" : "held"}</span>
          <pre data-testid="land-after-command" className="min-w-0 flex-1 font-mono text-faint whitespace-pre-wrap break-all">{v.command}</pre>
        </div>
        <p className="mt-1 text-muted">{AFTER_STATE[v.state]}. It runs once after each batch the landing queue lands, in the checkout that has the base out, as the queueing session's commands run. The trust holds the command, the files of .keel/ it runs and the landing it comes after only: what they read from the rest of the tree is not held. While it is held, branches still land and are pushed; the step waits.</p>
        {v.covers && v.covers.length > 0 && <p className="mt-0.5 text-muted">The trust also covers: {v.covers.join(", ")}</p>}
        {v.land && (
          <div className="mt-1 text-muted" data-testid="land-after-block">
            <p>And the landing it comes after{v.land.push ? `, pushed to ${v.land.push}` : ", with no push"}:</p>
            <pre className="mt-0.5 font-mono text-micro text-faint whitespace-pre-wrap break-all">{[...(v.land.setup ? [`setup: ${v.land.setup}`] : []), ...v.land.checks.map((c) => `check ${c}`)].join("\n") || "no checks"}</pre>
          </div>
        )}
        {v.problems.map((p, i) => <p key={i} className="mt-0.5 text-warn">{p}</p>)}
        {v.state !== "pinned" && v.sha256 && v.state !== "refused" && (
          <>
            {(v.texts ?? []).map((t) => (
              <div key={t.path} className="mt-2">
                <div className="font-mono text-micro text-faint">{t.path}</div>
                <pre className="mt-0.5 max-h-64 overflow-auto rounded-lg bg-code px-2.5 py-1.5 font-mono text-micro whitespace-pre-wrap">{t.text}</pre>
              </div>
            ))}
            <button data-testid="trust-land-after" className="mt-2 h-7 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90"
              onClick={() => api(on("/api/landing/after/trust"), { method: "POST", body: JSON.stringify({ cwd: session.workspace, sha256: v.sha256 }) }).then(() => { setErr(""); load(); }).catch((e) => setErr(failed(e, { at: "TrustPanel" })))}>Trust this version</button>
            {err && <p className="mt-1 text-danger">{err}</p>}
          </>
        )}
      </div>
    </section>
  );
}

function HeldFile({ f, cwd, on, onDone }: { f: File; cwd: string; on: (path: string) => string; onDone: () => void }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const Icon = ICON[f.kind];
  useEffect(() => {
    if (f.state === "gone") return;
    api<Diff>(on(`/api/trust/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(f.path)}`)).then(setDiff).catch((e) => setErr(failed(e, { at: "TrustPanel" })));
  }, [f.path, f.sha256]);
  // The press shows where it was made: the button waits while the request is on its way, and a refusal is
  // said beside it, above the diff (under a long diff nobody saw it, and pressed again).
  const trust = async () => {
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      await api(on("/api/trust"), { method: "POST", body: JSON.stringify({ cwd, files: [{ path: f.path, sha256: diff?.sha256 ?? f.sha256 }] }) });
      onDone();
    } catch (e) { setErr(`Not trusted: ${failed(e, { at: "TrustPanel" })}`); } finally { setBusy(false); }
  };
  return (
    <div className="k-held-file overflow-hidden rounded-xl border border-warn/40 bg-raised" data-testid="held-file" data-kind={f.kind}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="size-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 truncate font-mono text-caption">{f.rel}</span>
        <span className="text-micro text-faint">{KIND[f.kind]} · {f.state === "changed" ? "changed" : f.state === "new" ? "new" : "gone"}</span>
        {!f.refused && (
          <button data-testid="trust-file" onClick={trust} disabled={busy} aria-busy={busy} className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90 disabled:opacity-60">
            {f.state === "gone" ? "Forget it" : "Trust this version"}
          </button>
        )}
      </div>
      {err && <p className="px-3 pb-2 text-caption text-danger" data-testid="trust-error">{err}</p>}
      {diff && f.kind !== "skill" && <div className="border-t border-line p-2"><DiffView files={[{ path: diff.rel, status: f.state === "new" ? "A" : "M", added: diff.patch.added, removed: diff.patch.removed }]} patch={diff.patch.text} /></div>}
      {f.refused && <p className="border-t border-line px-3 py-2 text-caption text-warn" data-testid="trust-refused">{f.refused}</p>}
      {diff && f.kind === "skill" && !f.refused && <p className="border-t border-line px-3 py-2 text-caption text-muted">The skill's files changed. Read its folder before trusting it.</p>}
    </div>
  );
}

function BatchCard({ b, on, onDone }: { b: Batch; on: (path: string) => string; onDone: () => void }) {
  const [err, setErr] = useState("");
  const act = async (f: () => Promise<unknown>) => { setErr(""); try { await f(); onDone(); } catch (e) { setErr(failed(e, { at: "TrustPanel" })); } };
  return (
    <div className="k-quarantine-batch rounded-xl border border-line bg-raised px-3 py-2" data-testid="quarantine-batch">
      <p className="text-caption text-muted">{when(b.created)} · {b.paths.length} file{b.paths.length === 1 ? "" : "s"}</p>
      <ul className="mt-1 flex flex-col">
        {b.paths.map((p) => <li key={p} className="truncate font-mono text-caption">{p}</li>)}
      </ul>
      <div className="mt-2 flex items-center gap-1.5">
        <button data-testid="quarantine-restore" onClick={() => act(() => api(on(`/api/permissions/quarantine/${b.id}/restore`), { method: "POST" }))} className="k-btn">
          <RotateCcw className="size-3" /> Put back
        </button>
        <button data-testid="quarantine-discard"
          onClick={async () => { if (await confirmAction({ title: "Discard these files?", body: b.paths.join("\n"), action: "Discard", danger: true })) act(() => api(on(`/api/permissions/quarantine/${b.id}`), { method: "DELETE" })); }}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-caption text-muted hover:bg-danger-soft hover:text-danger">
          <Trash2 className="size-3" /> Discard
        </button>
        {err && <span className="text-micro text-danger">{err}</span>}
      </div>
    </div>
  );
}
