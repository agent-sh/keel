// Customize > Plugins: the plugins installed as one unit (skills, commands,
// agents, hooks and MCP servers together; PluginUnits.tsx), the ones this
// folder's repository offers, the provider plugins Keel runs (protocol v1)
// with their state, providers and conformance check, the servers Keel
// bundles, and plugins.toml itself.
import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { McpServerState } from "../../../../src/mcp/manager.ts";
import { api, failed, reportError } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { navigate } from "../../lib/ui.ts";
import { Blank, FileEditor, FolderLine, Ledger, ReaderHead, tilde, useFolder, type Group, type Mark } from "./kit.tsx";
import { InstallReader, OfferReader, unitBrings, unitMark, UnitReader, type Units } from "./PluginUnits.tsx";
import { mcpMark } from "./Mcp.tsx";

type Plugin = {
  id: string; state: string; name?: string; version?: string; protocol_version?: number; pid?: number; reason?: string; stderr_tail?: string;
  violations: { count: number; last: string }; providers: { id: string; label?: string; models: number; wire?: string; listing_problem?: string; unusable?: string }[];
};
type Toml = { file: string | null; own: string; text: string; borrowed: boolean; error: string | null };
const MARK: Record<string, Mark> = { ready: "on", starting: "work", restarting: "work", stopped: "off" };

export default function Plugins() {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [toml, setToml] = useState<Toml | null>(null);
  const [bundled, setBundled] = useState<McpServerState[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [units, setUnits] = useState<Units | null>(null);
  const [folder] = useFolder();
  const loadUnits = useCallback(() => {
    if (folder) api<Units>(`/api/plugins/installed?cwd=${encodeURIComponent(folder)}`).then(setUnits).catch(reportError);
  }, [folder]);
  useEffect(() => { loadUnits(); }, [loadUnits]);
  // A plugin's server still connecting: its state is read again until it settles.
  const settling = !!units?.plugins.some((x) => x.mcp.some((m) => m.state === "connecting"));
  useEffect(() => {
    if (!settling) return;
    const t = setInterval(loadUnits, 1500);
    return () => clearInterval(t);
  }, [settling, loadUnits]);
  const load = useCallback(() => {
    api<{ plugins: Plugin[] }>("/api/providers").then((r) => setPlugins(r.plugins)).catch(reportError);
    api<Toml>("/api/plugins").then(setToml).catch(reportError);
    api<{ servers: McpServerState[] }>("/api/mcp/servers").then((r) => setBundled(r.servers.filter((s) => s.bundled))).catch(reportError);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (plugins && units && !sel) setSel(units.plugins[0] ? `u:${units.plugins[0].id}` : plugins[0] ? `p:${plugins[0].id}` : "toml"); }, [plugins, units]);
  const offers = (units?.offers ?? []).filter((o) => !o.installed);

  const groups: Group[] = [
    { id: "installed", title: "Installed", path: units?.home, entries: (units?.plugins ?? []).map((u) => ({ id: `u:${u.id}`, name: u.id, desc: u.description ?? unitBrings(u), mark: unitMark(u), markLabel: u.enabled ? "on" : "off", aside: u.version.length > 14 ? `${u.version.slice(0, 12)}…` : u.version, testid: "unit-entry", data: { "data-id": u.id } })) },
    { id: "offered", title: "Offered by this folder", entries: offers.map((o) => ({ id: `o:${o.key}`, name: o.plugin, desc: o.problem ?? `from ${o.marketplace}, named in ${tilde(o.from).split("/").slice(-2).join("/")}`, mark: o.problem ? "fail" as const : "need" as const, aside: "offered", testid: "offer-entry", data: { "data-key": o.key } })) },
    { id: "providers", title: "Provider plugins", path: toml?.file ?? undefined, entries: (plugins ?? []).map((p) => ({ id: `p:${p.id}`, name: p.name ?? p.id, desc: p.providers.map((x) => x.label ?? x.id).join(", ") || p.reason, mark: MARK[p.state] ?? "fail", aside: p.state.replace("_", " "), testid: "plugin-entry" })) },
    { id: "bundled", title: "Built into Keel", entries: bundled.map((s) => ({ id: `b:${s.name}`, name: s.bundled ?? s.name, desc: `${s.tools} tool${s.tools === 1 ? "" : "s"}, as the ${s.name} server`, mark: mcpMark(s), aside: s.transport, testid: "plugin-entry" })) },
    { id: "config", title: "Configuration", entries: [{ id: "toml", name: "plugins.toml", desc: toml?.borrowed ? "read from the Rust Keel's folder" : toml?.file ? "keel-bun's own" : "not written yet", mark: toml?.error ? "fail" : toml?.file ? "on" : "off", testid: "plugin-entry" }] },
  ];
  const p = sel?.startsWith("p:") ? plugins?.find((x) => `p:${x.id}` === sel) : undefined;
  const u = sel?.startsWith("u:") ? units?.plugins.find((x) => `u:${x.id}` === sel) : undefined;
  const o = sel?.startsWith("o:") ? offers.find((x) => `o:${x.key}` === sel) : undefined;
  const installed = (id: string) => { loadUnits(); load(); setSel(`u:${id}`); };
  const b = sel?.startsWith("b:") ? bundled.find((x) => `b:${x.name}` === sel) : undefined;
  const ready = plugins?.filter((x) => x.state === "ready").length ?? 0;
  const failing = plugins?.filter((x) => MARK[x.state] === "fail").length ?? 0;

  return (
    <div data-testid="plugins-settings">
      <FolderLine tally={[
        { n: units?.plugins.length ?? 0, label: "installed" }, { n: units?.plugins.filter((x) => x.enabled).length ?? 0, label: "on" },
        ...(offers.length ? [{ n: offers.length, label: "offered", tone: "need" as const }] : []),
        { n: plugins?.length ?? 0, label: "provider plugins" }, { n: ready, label: "ready" }, ...(failing ? [{ n: failing, label: "failing", tone: "fail" as const }] : []), { n: bundled.length, label: "built in" },
      ]} />
      <Ledger testid="plugins-ledger" groups={groups} selected={sel} onSelect={setSel} add={[{ label: "Install a plugin", id: "+install" }]}>
        {sel === "+install" ? (
          <InstallReader key={folder} folder={folder} onDone={(x) => installed(x.id)} />
        ) : u ? (
          <UnitReader key={u.id} u={u} folder={folder} onChange={(removed) => { loadUnits(); load(); if (removed) setSel(null); }} />
        ) : o ? (
          <OfferReader key={o.key} o={o} folder={folder} onDone={(x) => installed(x.id)} />
        ) : p ? (
          <>
            <ReaderHead
              title={p.name ?? p.id}
              desc={p.reason}
              facts={[
                ["State", p.state.replace("_", " ")],
                ...(p.version ? [["Version", p.version] as [string, string]] : []),
                ...(p.protocol_version ? [["Protocol", `v${p.protocol_version}`] as [string, string]] : []),
                ...(p.pid ? [["Process", `${p.pid}`] as [string, string]] : []),
                ["Models", `${p.providers.reduce((n, x) => n + x.models, 0)}`],
              ]}
            />
            <div className="k-reader-body" data-testid="plugin-reader" data-plugin={p.id}>
              {p.stderr_tail && <pre className="k-issue">{p.stderr_tail}</pre>}
              {p.violations.count > 0 && <p className="k-issue" data-tone="quiet">{p.violations.count} protocol violations, the last: {p.violations.last}</p>}
              <div>
                <div className="k-sub k-label">Providers it adds</div>
                {p.providers.map((x) => (
                  <div key={x.id} className="flex items-baseline gap-3 border-b border-line py-2 text-ui last:border-0">
                    <span className="font-medium">{x.label ?? x.id}</span>
                    <span className="font-mono text-micro text-faint">{x.id}{x.wire ? ` · ${x.wire}` : ""}</span>
                    <span className="ml-auto text-caption tabular-nums text-muted">{x.unusable ?? x.listing_problem ?? `${x.models} models`}</span>
                  </div>
                ))}
                {!p.providers.length && <p className="text-caption text-faint">None yet: it has not answered its handshake.</p>}
              </div>
              <div>
                <div className="k-sub k-label">Protocol check</div>
                <p className="text-caption text-muted">Runs it once more against a scratch vendor with fake keys, as <code className="font-mono">keel plugin check {p.id}</code> does.</p>
                <PluginCheck id={p.id} />
              </div>
            </div>
          </>
        ) : b ? (
          <>
            <ReaderHead title={b.bundled ?? b.name} desc={b.opt_in
              ? `Keel brings this one itself, as the ${b.name} MCP server. It acts with an account of yours, so it is off until you turn it on, and a session is offered only what you turn on for it in Customize > MCP servers. It can be turned off, not removed.`
              : `Keel brings this one itself: every session has it with no setup, as the ${b.name} MCP server. It can be turned off, not removed.`} facts={[["State", b.state.replace("_", " ")], ["Tools", `${b.tools}`], ["Transport", b.transport]]}>
              {b.error && <div className="k-issue mt-3" data-tone={b.state === "missing" || b.state === "not_armed" ? "quiet" : undefined}>{b.error}</div>}
            </ReaderHead>
            <div className="k-reader-body">
              <button type="button" className="k-btn" onClick={() => navigate({ name: "customize", section: "mcp" }, true)}>Open in MCP servers</button>
            </div>
          </>
        ) : sel === "toml" && toml ? (
          <>
            <ReaderHead
              title="plugins.toml"
              path={toml.file ?? toml.own}
              desc={toml.borrowed
                ? "keel-bun has no plugins file of its own, so it reads the Rust Keel's. Saving writes keel-bun's own copy; the other file stays as it is."
                : "One [plugins.<id>] table per plugin: command, args, enabled, env, settings and [plugins.<id>.providers.<pid>]. Saving checks it as TOML and restarts the plugins whose entry changed."}
            >
              {toml.error && <div className="k-issue mt-3">{toml.error}</div>}
            </ReaderHead>
            <FileEditor
              name={toml.borrowed ? "plugins.toml (saves as keel-bun's own)" : "plugins.toml"}
              text={toml.text || (toml.file ? "" : `[plugins.example]\ncommand = "~/.local/libexec/keel-plugins/example"\nenabled = false\n`)}
              onSave={async (text) => {
                setToml(await api<Toml>("/api/plugins", { method: "PUT", body: JSON.stringify({ text }) }));
                api<{ plugins: Plugin[] }>("/api/providers").then((r) => setPlugins(r.plugins)).catch(reportError);
              }}
            />
          </>
        ) : <Blank title="Reading the plugins" />}
      </Ledger>
    </div>
  );
}

type CheckRow = { fixture: string; result: "pass" | "fail" | "n/a"; ms: number; detail: string };

// The conformance check of protocol v1 (`keel plugin check <id>`): fake
// credentials, a fake vendor, every fixture of the spec.
function PluginCheck({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<{ rows: CheckRow[]; summary: { passed: number; failed: number; not_applicable: number } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setR(await api(`/api/plugins/${id}/check`, { method: "POST" })); } catch (e) { setErr(failed(e, { at: "plugin check" })); } finally { setBusy(false); }
  };
  const bad = r?.rows.filter((x) => x.result !== "pass") ?? [];
  return (
    <div className="mt-2" data-testid="plugin-check">
      <div className="flex items-center gap-2">
        <button type="button" onClick={run} disabled={busy} data-testid="plugin-check-run"
          className="k-btn">
          <ShieldCheck className={cn("size-3.5", busy && "animate-pulse")} /> {busy ? "Checking" : "Run the conformance check"}
        </button>
        {r && (
          <span className={cn("text-caption tabular-nums", r.summary.failed ? "text-danger" : "text-ok")} data-testid="plugin-check-summary">
            {r.summary.passed} passed, {r.summary.failed} failed{r.summary.not_applicable ? `, ${r.summary.not_applicable} n/a` : ""}
          </span>
        )}
        {err && <span className="text-caption text-danger">{err}</span>}
      </div>
      {r && (
        <details className="mt-1.5 text-caption" open={bad.length > 0}>
          <summary className="cursor-default text-faint hover:text-muted">{r.rows.length} fixtures</summary>
          <div className="mt-1 grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-0.5">
            {r.rows.map((x) => (
              <div key={x.fixture} className="contents" data-testid="plugin-check-row" data-result={x.result}>
                <span className="font-mono text-micro text-muted">{x.fixture}</span>
                <span className={cn("text-micro", x.result === "pass" ? "text-ok" : x.result === "fail" ? "text-danger" : "text-faint")}>{x.result}</span>
                <span className="truncate text-micro text-faint" title={x.detail}>{x.detail}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
