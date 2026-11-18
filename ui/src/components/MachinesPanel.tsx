// Settings > Machines: this machine, the machines whose daemons this one is
// linked to (what they have, the directory granted there, the queue), adding
// one by its daemon URL or ssh host, the ssh hosts offered, and the daemons
// that linked to this one.
import { ArrowUp, Cpu, Link2, Plus, RefreshCw, Server, Terminal, Trash2, Unlink, Wand2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { fleet, useFleet, type Machine, type Rule } from "../lib/fleet.ts";
import { reportError } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { Card } from "./Settings.tsx";

const field = "h-8 w-full rounded-lg border border-line bg-bg px-2.5 text-ui outline-none placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20";
const btn = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:text-faint";
const ghost = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50 [&>svg]:size-3.5";
const heading = (t: string, extra?: ReactNode) => (
  <h3 className="mt-7 mb-2 flex items-center gap-2 text-micro font-medium uppercase tracking-wide text-faint">{t}{extra}</h3>
);

const TONE: Record<string, string> = { ready: "bg-ok", busy: "bg-brass", starting: "bg-brass animate-pulse-dot", offline: "bg-danger", unknown: "bg-line-strong" };
const gb = (mb?: number) => (mb === undefined ? "?" : `${(mb / 1024).toFixed(mb < 10240 ? 1 : 0)} GB`);

function StatePill({ state }: { state: string }) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-full bg-sunken px-2 text-micro text-muted" data-testid="machine-state">
      <span className={cn("size-1.5 rounded-full", TONE[state] ?? TONE.unknown)} /> {state}
    </span>
  );
}

function FactsLine({ m }: { m: Machine }) {
  const f = m.facts;
  if (!f) return <div className="text-caption text-faint">{m.checked_ms ? "No report from it." : "Not checked since this daemon started."}</div>;
  const load = Math.min(1, f.load1 / Math.max(1, f.cpus));
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-caption">
      <span className="text-faint">System</span>
      <span className="text-muted">{f.os} {f.arch}{f.gpu ? <span className="text-fg"> · {f.gpu}</span> : null}</span>
      <span className="text-faint">Load</span>
      <span className="flex items-center gap-2 text-muted tabular-nums">
        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-sunken"><span className={cn("block h-full rounded-full", load > 0.85 ? "bg-danger" : load > 0.6 ? "bg-brass" : "bg-ok")} style={{ width: `${Math.max(4, load * 100)}%` }} /></span>
        {f.load1} on {f.cpus} cores · {gb(f.mem_available_mb)} free of {gb(f.mem_total_mb)}
      </span>
      <span className="text-faint">Tools</span>
      <span className="flex flex-wrap gap-1">{f.tools.map((t) => <span key={t} className="rounded-sm bg-sunken px-1.5 font-mono text-micro text-muted">{t}</span>)}</span>
    </div>
  );
}

function LocalRow({ m }: { m: Machine }) {
  return (
    <div className="flex gap-3.5 py-4" data-testid="machine-row" data-machine="local">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-ink"><Cpu className="size-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">{m.name}</span>
          <span className="text-caption text-faint">this machine</span>
          <span className="ml-auto"><StatePill state="ready" /></span>
        </div>
        <FactsLine m={m} />
      </div>
    </div>
  );
}

function MachineRow({ m }: { m: Machine }) {
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(false);
  const [root, setRoot] = useState(m.workspace_root ?? "");
  const [jobs, setJobs] = useState(m.max_jobs ? String(m.max_jobs) : "");
  const [err, setErr] = useState("");
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const link = m.daemon;
  return (
    <div className="flex gap-3.5 border-t border-line py-4" data-testid="machine-row" data-machine={m.id}>
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-sunken text-muted" style={m.colour ? { color: m.colour } : undefined}>
        {m.source === "ssh" ? <Terminal className="size-4" /> : <Server className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium" data-testid="machine-name">{m.name}</span>
          <span className="truncate font-mono text-micro text-faint">{m.ssh_host ? `${m.ssh_host} :${m.daemon_port}` : m.daemon_url}</span>
          <span className="ml-auto flex items-center gap-1">
            <StatePill state={m.state} />
            <button type="button" className={ghost} disabled={busy} onClick={() => run(() => fleet.check(m.id))} data-testid="machine-check" title="Check it now">
              <RefreshCw className={cn(busy && "animate-spin")} /> Check
            </button>
            <button type="button" className={ghost} onClick={() => setEdit((e) => !e)}>Edit</button>
            <button
              type="button"
              className={cn(ghost, "hover:text-danger")}
              aria-label={`Remove ${m.name}`}
              onClick={async () => { if (await confirmAction({ title: `Remove ${m.name}?`, body: "Its link and its key go. Sessions there stay on that machine.", action: "Remove", danger: true })) run(() => fleet.remove(m.id)); }}
            ><Trash2 /></button>
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
          <span className={cn("inline-flex items-center gap-1.5", link?.state === "linked" ? "text-ok" : link?.state === "offline" ? "text-danger" : "text-faint")} data-testid="machine-link">
            <Link2 className="size-3.5" />
            {link?.state === "linked" ? `linked to ${link.server_name ?? "its daemon"}${link.version ? ` ${link.version}` : ""}` : link?.state === "offline" ? "link down" : link?.state === "connecting" ? "linking" : "not linked"}
          </span>
          <span className="text-muted">{m.workspace_root ? <>granted <span className="font-mono text-micro text-fg">{m.workspace_root}</span></> : <span className="text-warn">no directory granted: nothing runs there</span>}</span>
          {m.queue && <span className="text-faint tabular-nums">jobs {m.queue.running} running, {m.queue.waiting} waiting{m.queue.limit ? `, limit ${m.queue.limit}` : ""}</span>}
          {m.checked_ms && <span className="text-faint" title={when(m.checked_ms)}>checked {ago(m.checked_ms)}</span>}
        </div>
        {(m.reason || link?.reason) && m.state === "offline" && (
          <div className="mt-1.5 rounded-md bg-danger-soft px-2.5 py-1.5 text-caption text-danger" data-testid="machine-reason">
            {m.reason ?? link?.reason}{link?.retry_at_ms && link.retry_at_ms > Date.now() ? ` · retrying in ${Math.ceil((link.retry_at_ms - Date.now()) / 1000)} s` : ""}
          </div>
        )}
        <FactsLine m={m} />
        {edit && (
          <form
            className="mt-3 grid gap-2 rounded-lg border border-line bg-sunken/60 p-3 sm:grid-cols-[1fr_8rem_auto]"
            onSubmit={(e) => { e.preventDefault(); run(async () => { await fleet.patch(m.id, { workspace_root: root.trim() || null, max_jobs: jobs ? Number(jobs) : null }); setEdit(false); }); }}
          >
            <input className={cn(field, "font-mono text-caption")} placeholder="Directory granted there, absolute" value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Granted directory" />
            <input className={field} placeholder="Max jobs" inputMode="numeric" value={jobs} onChange={(e) => setJobs(e.target.value.replace(/\D/g, ""))} aria-label="Max jobs" />
            <button type="submit" className={btn} disabled={busy}>Save</button>
            <label className="flex items-center gap-2 text-caption text-muted sm:col-span-3">
              <input type="checkbox" checked={m.messages !== "hold"} onChange={(e) => run(() => fleet.patch(m.id, { messages: e.target.checked ? "allow" : "hold" }))} />
              Deliver messages from its sessions (off: they wait for you)
            </label>
          </form>
        )}
        {err && <div className="mt-1.5 text-caption text-danger">{err}</div>}
      </div>
    </div>
  );
}

function AddMachine({ offered, preset, onDone }: { offered: Machine[]; preset?: string; onDone: () => void }) {
  const [mode, setMode] = useState<"daemon" | "ssh">(preset ? "ssh" : "daemon");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("http://127.0.0.1:");
  const [host, setHost] = useState(preset ?? offered[0]?.name ?? "");
  const [port, setPort] = useState("");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { if (preset) { setMode("ssh"); setHost(preset); } }, [preset]);
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fleet.add(mode === "daemon"
        ? { name: name.trim(), daemon_url: url.trim(), workspace_root: root.trim() || undefined }
        : { ssh_host: host, daemon_port: Number(port), name: name.trim() || undefined, workspace_root: root.trim() || undefined });
      const m = r.machines.find((x) => x.id === r.id);
      if (m?.state === "offline") setErr(`Added, but it does not answer: ${m.reason ?? m.daemon?.reason ?? ""}`);
      else onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="py-4" data-testid="machine-add" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div role="radiogroup" aria-label="How it is reached" className="mb-3 inline-flex rounded-md border border-line bg-sunken p-0.5">
        {(["daemon", "ssh"] as const).map((v) => (
          <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => setMode(v)} className={cn("h-7 rounded-sm px-3 text-caption", mode === v ? "bg-raised text-fg shadow-1" : "text-muted hover:text-fg")}>
            {v === "daemon" ? "Daemon on this machine's loopback" : "Daemon behind an ssh host"}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={field} placeholder={mode === "ssh" ? "Name (the host's alias)" : "Name"} value={name} onChange={(e) => setName(e.target.value)} aria-label="Machine name" data-testid="machine-add-name" />
        {mode === "daemon" ? (
          <input className={cn(field, "font-mono text-caption")} placeholder="http://127.0.0.1:PORT" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Daemon URL" data-testid="machine-add-url" />
        ) : (
          <div className="flex gap-2">
            <select className={field} value={host} onChange={(e) => setHost(e.target.value)} aria-label="ssh host">
              {offered.map((h) => <option key={h.name} value={h.name}>{h.name}</option>)}
            </select>
            <input className={cn(field, "w-28")} placeholder="Daemon port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} aria-label="Daemon port there" />
          </div>
        )}
        <input className={cn(field, "font-mono text-caption sm:col-span-2")} placeholder="Directory granted there (absolute; empty: sessions view only)" value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Granted directory" data-testid="machine-add-root" />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" className={btn} disabled={busy} data-testid="machine-add-submit"><Plus /> {busy ? "Pairing" : "Pair and add"}</button>
        <span className="text-caption text-faint">Keel pairs with that daemon once; every answer over the link proves the pairing.</span>
      </div>
      {err && <div className="mt-2 text-caption text-danger" data-testid="machine-add-error">{err}</div>}
    </form>
  );
}

function SshHost({ m, onEnable }: { m: Machine; onEnable: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-3 border-t border-line py-2.5 first:border-0" data-testid="ssh-host" data-host={m.name}>
      <Terminal className="size-3.5 text-faint" />
      <span className="font-mono text-caption">{m.name}</span>
      {m.state !== "unknown" && <StatePill state={m.state} />}
      {(m.detail || m.reason) && <span className={cn("min-w-0 truncate text-caption", m.reason ? "text-danger" : "text-faint")}>{m.reason ?? m.detail}</span>}
      <span className="ml-auto flex gap-1">
        <button type="button" className={ghost} disabled={busy} onClick={async () => { setBusy(true); await fleet.check(m.id).catch(reportError); setBusy(false); }}>
          <RefreshCw className={cn(busy && "animate-spin")} /> Reach
        </button>
        <button type="button" className={ghost} onClick={onEnable}><Plus /> Enable</button>
      </span>
    </div>
  );
}

const COND: { key: "local_busy" | "needs_gpu" | "heavy"; label: string }[] = [
  { key: "local_busy", label: "this machine is busy" },
  { key: "needs_gpu", label: "it needs a GPU" },
  { key: "heavy", label: "it is heavy" },
];

function ruleText(r: Rule) {
  const parts = [r.when.kind ? `a ${r.when.kind}` : "any work", ...COND.filter((c) => r.when[c.key] !== undefined).map((c) => (r.when[c.key] ? c.label : `not: ${c.label}`))];
  return parts.join(", ");
}

// The owner's placement rules: read in order, the first that holds names the machine.
function Placement({ machines }: { machines: Machine[] }) {
  const rules = useFleet((s) => s.rules);
  const [kind, setKind] = useState("");
  const [cond, setCond] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const targets = [{ id: "local", name: machines.find((m) => m.source === "local")?.name ?? "this machine" }, ...machines.filter((m) => m.source !== "local" && m.enabled)];
  const name = (id: string) => targets.find((t) => t.id === id)?.name ?? id;
  const save = (next: Rule[]) => fleet.saveRules(next).then(() => setErr("")).catch((e) => setErr((e as Error).message));
  return (
    <Card>
      <div className="py-1" data-testid="placement">
        {rules.length === 0 && <p className="py-3.5 text-caption text-faint">No rules: new work stays on this machine unless you pick one.</p>}
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line py-2.5" data-testid="placement-rule">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-sunken text-micro tabular-nums text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-ui">
              <span className="text-muted">When {ruleText(r)}, run it on </span><span className="font-medium">{name(r.machine)}</span>
              {r.note && <span className="text-faint"> · {r.note}</span>}
            </span>
            <button type="button" className={ghost} disabled={i === 0} aria-label="Move up" onClick={() => { const n = [...rules]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; save(n); }}><ArrowUp /></button>
            <button type="button" className={cn(ghost, "hover:text-danger")} aria-label="Remove rule" onClick={() => save(rules.filter((_, k) => k !== i))}><X /></button>
          </div>
        ))}
        <form
          className="flex flex-wrap items-center gap-2 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!target) return setErr("pick the machine the rule sends work to");
            const when: Rule["when"] = { ...(kind ? { kind: kind as Rule["when"]["kind"] } : {}), ...Object.fromEntries(Object.entries(cond).filter(([, v]) => v).map(([k]) => [k, true])) };
            save([...rules, { when, machine: target, note: note.trim() || undefined }]).then(() => { setCond({}); setNote(""); setKind(""); });
          }}
        >
          <Wand2 className="size-3.5 text-faint" />
          <span className="text-caption text-muted">When</span>
          <select className={cn(field, "w-auto")} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of work">
            <option value="">any work</option><option value="session">a session</option><option value="subagent">a subagent</option><option value="run">a command</option>
          </select>
          {COND.map((c) => (
            <label key={c.key} className={cn("inline-flex h-8 cursor-default items-center gap-1.5 rounded-md border px-2 text-caption", cond[c.key] ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-muted hover:text-fg")}>
              <input type="checkbox" className="sr-only" checked={!!cond[c.key]} onChange={(e) => setCond({ ...cond, [c.key]: e.target.checked })} />{c.label}
            </label>
          ))}
          <span className="text-caption text-muted">run it on</span>
          <select className={cn(field, "w-auto")} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Machine" data-testid="placement-machine">
            <option value="">machine</option>
            {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input className={cn(field, "w-44")} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <button type="submit" className={btn} data-testid="placement-add"><Plus /> Add rule</button>
        </form>
        {err && <div className="pb-3 text-caption text-danger">{err}</div>}
      </div>
    </Card>
  );
}

const HOSTS_SHOWN = 4;

export function MachinesSettings() {
  const machines = useFleet((s) => s.machines);
  const pairs = useFleet((s) => s.pairs);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState<string>();
  const [allHosts, setAllHosts] = useState(false);
  useEffect(() => { fleet.loadMachines().catch(reportError); }, []);
  const local = machines.find((m) => m.source === "local");
  const linked = machines.filter((m) => m.source !== "local" && m.enabled);
  const offered = machines.filter((m) => !m.enabled);
  return (
    <div data-testid="machines-panel">
      <Card>
        {local ? <LocalRow m={local} /> : <p className="py-6 text-ui text-faint">Reading the machines.</p>}
        {linked.map((m) => <MachineRow key={m.id} m={m} />)}
        <div className="border-t border-line">
          {adding ? (
            <AddMachine offered={offered} preset={preset} onDone={() => { setAdding(false); setPreset(undefined); }} />
          ) : (
            <div className="flex items-center gap-3 py-3.5">
              <button type="button" className={btn} onClick={() => setAdding(true)} data-testid="machine-add-open"><Plus /> Add a machine</button>
              <span className="text-caption text-faint">A machine is another Keel daemon. Seeing it is not leave to use it: only the directory you grant runs commands.</span>
            </div>
          )}
        </div>
      </Card>
      {heading("Placement", <span className="normal-case tracking-normal">· where new work goes when you pick Auto; the first rule that holds wins</span>)}
      <Placement machines={machines} />
      {offered.length > 0 && heading("ssh hosts, not enabled", <span className="normal-case tracking-normal">· from your ssh configuration</span>)}
      {offered.length > 0 && (
        <Card>
          <div className="py-1">
            {(allHosts ? offered : offered.slice(0, HOSTS_SHOWN)).map((m) => <SshHost key={m.id} m={m} onEnable={() => { setPreset(m.name); setAdding(true); }} />)}
            {offered.length > HOSTS_SHOWN && (
              <button type="button" className="h-9 w-full border-t border-line text-left text-caption text-faint hover:text-muted" onClick={() => setAllHosts((a) => !a)}>
                {allHosts ? "Show fewer" : `${offered.length - HOSTS_SHOWN} more hosts`}
              </button>
            )}
          </div>
        </Card>
      )}
      {pairs.length > 0 && heading("Daemons linked to this one")}
      {pairs.length > 0 && (
        <Card>
          {pairs.map((p) => (
            <div key={p.daemon_id} className="flex items-center gap-3 border-t border-line py-3 first:border-0" data-testid="pair-row">
              <Link2 className="size-3.5 text-faint" />
              <span className="text-ui font-medium">{p.name ?? "a daemon"}</span>
              <span className="font-mono text-micro text-faint">{p.daemon_id}</span>
              <span className="text-caption text-faint" title={when(p.created)}>paired {ago(p.created)}</span>
              <button type="button" className={cn(ghost, "ml-auto hover:text-danger")} onClick={async () => { if (await confirmAction({ title: `Revoke ${p.name ?? p.daemon_id}?`, body: "Its key stops working: it sees nothing here and runs nothing until it pairs again.", action: "Revoke", danger: true })) fleet.unpair(p.daemon_id).catch(reportError); }}>
                <Unlink /> Revoke
              </button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
