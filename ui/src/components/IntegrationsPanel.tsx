// Settings: the owner's own tools Keel works with. tacit's memory hooks, and
// momentum's report with the control socket it uses.
import { useEffect, useState } from "react";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { Card, SettingRow } from "./Settings.tsx";

type Item = { id: string; title: string; detail?: string; at?: string };
type Report = { available: boolean; report?: { generated_at: string; counts: Record<string, number>; needs_you: Item[]; problems: Item[]; running: Item[] } };
type Info = { tacit: { available: boolean; bin: string | null }; momentum: { available: boolean; socket: string | null } };

const get = <T,>(p: string) => fetch(p).then((r) => r.json() as Promise<T>);

function Status({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ui", on ? "text-fg" : "text-muted")}>
      <span className={cn("size-2 rounded-full", on ? "bg-ok" : "bg-line-strong")} />
      {children}
    </span>
  );
}

function Items({ label, items, tone }: { label: string; items: Item[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="mb-1.5 flex items-center gap-2 text-caption font-medium uppercase tracking-wide text-faint">
        <span className={cn("size-1.5 rounded-full", tone)} />
        {label}
        <span className="tabular-nums">{items.length}</span>
      </div>
      <ul className="space-y-1">
        {items.slice(0, 5).map((i) => (
          <li key={i.id} className="truncate text-ui" title={i.detail}>{i.title}</li>
        ))}
        {items.length > 5 && <li className="text-caption text-faint">{items.length - 5} more in momentum's report</li>}
      </ul>
    </div>
  );
}

export function IntegrationsSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    get<Info>("/api/integrations").then(setInfo).catch(reportError);
    get<Report>("/api/momentum").then(setReport).catch(reportError);
  }, []);
  const r = report?.report;
  return (
    <div className="flex flex-col gap-4" data-testid="integrations">
      <Card>
        <SettingRow
          label="Memory (tacit)"
          hint="Before each prompt and each edit, command or tool call, tacit adds the rules and decisions that apply, marked as memory. Off per session with /memory off before its first message."
        >
          <Status on={!!info?.tacit.available}>{info ? (info.tacit.available ? "On" : "Not installed") : "..."}</Status>
        </SettingRow>
        {info?.tacit.bin && (
          <SettingRow label="Binary"><span className="block max-w-[26rem] truncate font-mono text-caption text-muted" title={info.tacit.bin}>{info.tacit.bin}</span></SettingRow>
        )}
      </Card>
      <Card>
        <SettingRow label="Supervisor (momentum)" hint="momentum reads every session's phase from Keel's control socket and may queue, steer or stop one; its messages are marked as momentum's.">
          <Status on={!!report?.available}>{report ? (report.available ? "Reporting" : "Not installed") : "..."}</Status>
        </SettingRow>
        {info?.momentum.socket && (
          <SettingRow label="Control socket"><span className="block max-w-[26rem] truncate font-mono text-caption text-muted" title={info.momentum.socket} data-testid="momentum-socket">{info.momentum.socket}</span></SettingRow>
        )}
      </Card>
      {r && (
        <Card>
          <div className="flex items-center gap-3 border-b border-line py-3">
            <span className="text-ui font-medium">momentum report</span>
            <span className="text-caption text-faint">{new Date(r.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            <span className="ml-auto flex gap-3 text-caption tabular-nums text-muted" data-testid="momentum-counts">
              {Object.entries(r.counts).map(([k, v]) => <span key={k}>{v} {k.replace("_", " ")}</span>)}
            </span>
          </div>
          <Items label="Needs you" items={r.needs_you} tone="bg-warn" />
          <Items label="Problems" items={r.problems} tone="bg-danger" />
          <Items label="Running" items={r.running} tone="bg-accent" />
        </Card>
      )}
    </div>
  );
}

type HookSource = { path: string; scope: "owner" | "project"; root: string; text: string; sha256: string; active: boolean; events: Record<string, number>; problems: string[] };

// Settings: hook files. The owner's runs; a repository's runs once pinned after reading it.
export function HooksSettings() {
  const [sources, setSources] = useState<HookSource[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = () => get<{ sources: HookSource[] }>("/api/hooks").then((r) => setSources(r.sources)).catch(reportError);
  useEffect(() => { load(); }, []);
  const pin = async (s: HookSource) => {
    setErr("");
    const r = await fetch("/api/hooks/trust", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: s.root, sha256: s.sha256 }) });
    if (!r.ok) setErr((await r.json()).error);
    load();
  };
  return (
    <div className="flex flex-col gap-4" data-testid="hooks-settings">
      <p className="text-ui text-muted">
        Commands that run at fixed points of a session, in the hooks.json shape Claude Code and Codex use. A hook can block a call or a prompt, ask the owner, add context or keep a turn going; it never allows anything. Yours live in <code className="font-mono text-caption">~/.config/keel-bun/hooks.json</code>; a repository's <code className="font-mono text-caption">.keel/hooks.json</code> runs only after you pin the exact file.
      </p>
      {err && <p className="rounded-md bg-danger-soft px-3 py-2 text-caption text-danger">{err}</p>}
      {sources?.length === 0 && <Card><p className="py-5 text-center text-ui text-faint">No hook files in your config or in the folders Keel has worked in.</p></Card>}
      {sources?.map((s) => (
        <Card key={s.path}>
          <div className="flex items-center gap-2.5 py-3" data-testid="hook-source" data-scope={s.scope} data-active={s.active}>
            <span className={cn("size-2 shrink-0 rounded-full", s.active ? "bg-ok" : "bg-warn")} />
            <span className="min-w-0 flex-1 truncate font-mono text-caption" title={s.path}>{s.path.replace(/^\/home\/[^/]+/, "~")}</span>
            <span className="shrink-0 rounded-xs bg-panel px-1.5 text-micro text-muted">{s.scope === "owner" ? "yours" : "repository"}</span>
            {s.scope === "project" && !s.active && s.sha256 && (
              <button type="button" data-testid="hook-pin" onClick={() => pin(s)} className="h-7 shrink-0 rounded-md bg-accent px-2.5 text-caption font-medium text-accent-fg hover:opacity-90">Pin this file</button>
            )}
            <button type="button" onClick={() => setOpen(open === s.path ? null : s.path)} className="h-7 shrink-0 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg">{open === s.path ? "Hide" : "Read"}</button>
          </div>
          <div className="flex flex-wrap gap-1.5 border-t border-line py-2.5">
            {Object.entries(s.events).map(([e, n]) => <span key={e} className="rounded-md border border-line px-1.5 py-px font-mono text-micro text-muted">{e} · {n}</span>)}
            {!Object.keys(s.events).length && <span className="text-caption text-faint">No handlers</span>}
          </div>
          {s.problems.length > 0 && (
            <ul className="space-y-0.5 border-t border-line py-2.5" data-testid="hook-problems">
              {s.problems.map((p) => <li key={p} className="text-caption text-muted">{p}</li>)}
            </ul>
          )}
          {open === s.path && <pre className="-mx-5 max-h-80 overflow-auto border-t border-line bg-sunken px-5 py-3 font-mono text-micro leading-relaxed" data-testid="hook-text">{s.text}</pre>}
        </Card>
      ))}
    </div>
  );
}
