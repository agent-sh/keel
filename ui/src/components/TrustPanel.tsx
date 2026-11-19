import { FileCheck2, FileWarning, Package, RotateCcw, ShieldCheck, Trash2, Webhook } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import type { Source as HookSource } from "../../../src/integrations/hooks.ts";
import type { Batch } from "../../../src/safety/quarantine.ts";
import type { ProjectFile } from "../../../src/safety/trust.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
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
  const load = useCallback(() => {
    api<View>(`/api/trust?cwd=${cwd}`).then(setView).catch((e) => setErr(failed(e, { at: "TrustPanel" })));
    api<{ sources: Omit<HookSource, "groups">[] }>(`/api/hooks?cwd=${cwd}`).then((r) => setHooks(r.sources)).catch(reportError);
    api<{ batches: Batch[] }>(`/api/permissions/quarantine?session=${session.id}`).then((r) => setBatches(r.batches)).catch(reportError);
  }, [cwd, session.id]);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => { if ((f.name === "quarantine" || f.name === "trust") && (!f.session_id || f.session_id === session.id)) load(); } });
  }, [load]);
  useEffect(() => { if (session.phase === "idle") load(); }, [session.phase]);

  if (!view) return <p className="px-3 py-10 text-center text-ui text-faint">{err || "Loading…"}</p>;
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
              {held.map((f) => <HeldFile key={f.path} f={f} cwd={session.workspace} onDone={load} />)}
            </>
          ) : (
            <p className="px-1 text-caption text-muted" data-testid="trust-clear">Nothing is held: every file loads as you trusted it.</p>
          )}
          {trusted.length > 0 && (
            <ul className="flex flex-col rounded-xl border border-line bg-raised py-1" data-testid="trusted-files">
              {trusted.map((f) => {
                const Icon = ICON[f.kind];
                return (
                  <li key={f.path} className="flex items-center gap-2 px-3 py-1 text-caption">
                    <Icon className="size-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono">{f.rel}</span>
                    <span className="text-faint">{f.auto ? "pinned on first sight" : "trusted"}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 px-1 text-ui font-medium"><Webhook className="size-4 text-accent" /> Hooks</h3>
        {hooks.length === 0 ? <p className="px-1 text-caption text-faint">No hook files: yours would be in the Keel config folder as hooks.json, a repository's in .keel/hooks.json.</p> : (
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
                      onClick={() => api("/api/hooks/trust", { method: "POST", body: JSON.stringify({ cwd: session.workspace, sha256: h.sha256 }) }).then(load).catch((e) => setHookErr(failed(e, { at: "TrustPanel" })))}
                      className="mt-2 h-7 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90">Trust this version</button>
                    {hookErr && <p className="mt-1 text-danger">{hookErr}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 px-1 text-ui font-medium"><FileWarning className="size-4 text-accent" /> Quarantine</h3>
        {live.length === 0 ? (
          <p className="px-1 text-caption text-faint">Nothing in quarantine. A call you did not answer on a card that creates or changes a git hook, .envrc, the project's hook or MCP file or an editor task moves it here.</p>
        ) : live.map((b) => <BatchCard key={b.id} b={b} onDone={load} />)}
      </section>
    </div>
  );
}

function HeldFile({ f, cwd, onDone }: { f: File; cwd: string; onDone: () => void }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [err, setErr] = useState("");
  const Icon = ICON[f.kind];
  useEffect(() => {
    if (f.state === "gone") return;
    api<Diff>(`/api/trust/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(f.path)}`).then(setDiff).catch((e) => setErr(failed(e, { at: "TrustPanel" })));
  }, [f.path, f.sha256]);
  const trust = async () => {
    setErr("");
    try {
      await api("/api/trust", { method: "POST", body: JSON.stringify({ cwd, files: [{ path: f.path, sha256: diff?.sha256 ?? f.sha256 }] }) });
      onDone();
    } catch (e) { setErr(failed(e, { at: "TrustPanel" })); }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-warn/40 bg-raised" data-testid="held-file" data-kind={f.kind}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon className="size-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 truncate font-mono text-caption">{f.rel}</span>
        <span className="text-micro text-faint">{KIND[f.kind]} · {f.state === "changed" ? "changed" : f.state === "new" ? "new" : "gone"}</span>
        <button data-testid="trust-file" onClick={trust} className="h-7 rounded-lg bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90">
          {f.state === "gone" ? "Forget it" : "Trust this version"}
        </button>
      </div>
      {diff && f.kind !== "skill" && <div className="border-t border-line p-2"><DiffView files={[{ path: diff.rel, status: f.state === "new" ? "A" : "M", added: diff.patch.added, removed: diff.patch.removed }]} patch={diff.patch.text} /></div>}
      {diff && f.kind === "skill" && <p className="border-t border-line px-3 py-2 text-caption text-muted">The skill's files changed. Read its folder before trusting it.</p>}
      {err && <p className="px-3 pb-2 text-caption text-danger">{err}</p>}
    </div>
  );
}

function BatchCard({ b, onDone }: { b: Batch; onDone: () => void }) {
  const [err, setErr] = useState("");
  const act = async (f: () => Promise<unknown>) => { setErr(""); try { await f(); onDone(); } catch (e) { setErr(failed(e, { at: "TrustPanel" })); } };
  return (
    <div className="rounded-xl border border-line bg-raised px-3 py-2" data-testid="quarantine-batch">
      <p className="text-caption text-muted">{new Date(b.created).toLocaleString()} · {b.paths.length} file{b.paths.length === 1 ? "" : "s"}</p>
      <ul className="mt-1 flex flex-col">
        {b.paths.map((p) => <li key={p} className="truncate font-mono text-caption">{p}</li>)}
      </ul>
      <div className="mt-2 flex items-center gap-1.5">
        <button data-testid="quarantine-restore" onClick={() => act(() => api(`/api/permissions/quarantine/${b.id}/restore`, { method: "POST" }))} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line px-2.5 text-caption hover:bg-hover">
          <RotateCcw className="size-3" /> Put back
        </button>
        <button data-testid="quarantine-discard"
          onClick={async () => { if (await confirmAction({ title: "Discard these files?", body: b.paths.join("\n"), action: "Discard", danger: true })) act(() => api(`/api/permissions/quarantine/${b.id}`, { method: "DELETE" })); }}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-caption text-muted hover:bg-danger-soft hover:text-danger">
          <Trash2 className="size-3" /> Discard
        </button>
        {err && <span className="text-micro text-danger">{err}</span>}
      </div>
    </div>
  );
}
