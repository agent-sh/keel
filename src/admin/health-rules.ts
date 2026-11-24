// The rules of the health check: each takes plain facts and returns rows. They
// read nothing from the machine, so a test gives them fixtures; what reads the
// machine, and bounds each read in time, is src/admin/health.ts.
import { matches } from "../integrations/hooks.ts";
import type { Group, Level, Row } from "./health-rows.ts";

type Verdict = { level: Level; why: string; fix: string };

// ---- hooks -------------------------------------------------------------------

// Events a hook matcher is tested on the tool of (src/integrations/hooks.ts TOOL_EVENTS).
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
// Events Keel fires with no value to match on (src/server/routes/hooks.ts passes none):
// a matcher on them is never tested, and the hook runs every time.
const NO_MATCHER = new Set(["UserPromptSubmit", "Stop", "PostToolBatch", "Interrupt", "PreModelRequest", "PostModelRequest"]);

export type MatcherFacts = {
  // The tool names a call can go by (every family's, and the names a hook file written for another harness uses).
  tools: ReadonlySet<string>;
  // The values an event with a fixed set is matched on.
  values: Readonly<Record<string, readonly string[]>>;
};

// Whether a hook group's matcher can ever match: null when it can, or when that
// cannot be told (a server's tool, an agent type or a command name that comes and goes).
export function matcherVerdict(event: string, matcher: string | undefined, facts: MatcherFacts): Verdict | null {
  if (matcher === undefined || matcher === "" || matcher === "*") return null;
  if (NO_MATCHER.has(event)) return { level: "warning", why: `${event} has nothing to match a matcher on, so ${JSON.stringify(matcher)} is ignored and the hook runs every time`, fix: "remove the matcher, or move the hook to an event that takes one" };
  let names: readonly string[] | undefined;
  if (TOOL_EVENTS.has(event)) {
    if (/mcp/i.test(matcher)) return null;
    names = [...facts.tools];
  } else names = facts.values[event];
  if (!names) return null;
  if (names.some((n) => matches(matcher, [n]))) return null;
  return {
    level: "broken",
    why: `matcher ${JSON.stringify(matcher)} on ${event} matches none of ${TOOL_EVENTS.has(event) ? "Keel's tools" : `its values (${names.join(", ")})`}, so the hook never runs`,
    fix: TOOL_EVENTS.has(event) ? "name a tool as the model sees it (Bash, Edit, Write), or use a pattern such as Edit|Write" : `use one of ${names.join(", ")}`,
  };
}

export type HookGroupFacts = { path: string; event: string; matcher?: string };

export function hookRows(files: { path: string; scope: string; active: boolean; problems: string[]; groups: HookGroupFacts[] }[], facts: MatcherFacts): Row[] {
  const rows: Row[] = [];
  let groups = 0;
  const link = { section: "hooks" };
  for (const f of files) {
    groups += f.groups.length;
    const first = f.problems[0];
    if (!f.active) {
      // A repository's file is read and pinned by the owner before it runs: a state, not a fault.
      rows.push({ id: `hooks:inactive:${f.path}`, group: "hooks", level: "warning", title: `${f.scope} hooks file does not run`, detail: first, fix: first?.startsWith("not pinned") || first?.startsWith("changed since") ? "read the file in Settings > Hooks and pin it" : "fix the file", link, path: f.path });
      continue;
    }
    for (const p of f.problems) rows.push({ id: `hooks:problem:${f.path}:${p}`, group: "hooks", level: "broken", title: `${f.scope} hooks file: ${p}`, fix: "fix the entry in the file; the rest of the file still runs", link, path: f.path });
    for (const g of f.groups) {
      const v = matcherVerdict(g.event, g.matcher, facts);
      if (v) rows.push({ id: `hooks:matcher:${f.path}:${g.event}:${g.matcher}`, group: "hooks", level: v.level, title: `${g.event} matcher ${JSON.stringify(g.matcher)}`, detail: v.why, fix: v.fix, link, path: f.path });
    }
  }
  if (!rows.length) rows.push({ id: "hooks:ok", group: "hooks", level: "ok", title: groups ? `${groups} hook ${groups === 1 ? "group" : "groups"} read, every matcher can match` : "no hooks set", link });
  return rows;
}

// ---- sandbox -----------------------------------------------------------------

export type SandboxFacts = {
  platform: string;
  // The default profile for a new session: off, workspace-write or read-only.
  profile: string;
  bwrap?: string;
  // The probe's result: bwrap started a sandbox that ran a command.
  started?: boolean;
  said?: string;
  timedOut?: boolean;
  // systemd-run --user --scope worked (a command's own cgroup).
  scope?: boolean;
  scopeSaid?: string;
};

export function sandboxRows(f: SandboxFacts): Row[] {
  const link = { section: "safety" };
  const rows: Row[] = [];
  const wanted = f.profile !== "off";
  if (f.platform !== "linux") {
    return [{ id: "sandbox:platform", group: "sandbox", level: wanted ? "warning" : "ok", title: `no sandbox on ${f.platform}`, detail: `Keel confines commands with bubblewrap, which is Linux only${wanted ? `; the default profile is ${f.profile}, so commands run unconfined` : ""}`, fix: wanted ? "set the default profile to off, or run on Linux" : undefined, link }];
  }
  if (!f.bwrap) rows.push({ id: "sandbox:bwrap", group: "sandbox", level: wanted ? "broken" : "warning", title: "bubblewrap (bwrap) is not installed", detail: wanted ? `the default profile is ${f.profile}, and without bwrap commands run unconfined` : "commands cannot be confined until it is installed", fix: "install the distribution's bubblewrap package", link, how: "looked for bwrap on the path" });
  else if (f.timedOut) rows.push({ id: "sandbox:probe", group: "sandbox", level: "warning", title: "bwrap did not answer in time", fix: "run bwrap --ro-bind / / true in a terminal and see where it waits", link, path: f.bwrap, how: "started bwrap with a read-only root and ran true" });
  else if (!f.started) rows.push({ id: "sandbox:probe", group: "sandbox", level: wanted ? "broken" : "warning", title: "bwrap cannot start a sandbox here", detail: `${f.said || "it exited with an error"}${wanted ? `; the default profile is ${f.profile}, and commands run unconfined` : ""}`, fix: "on Ubuntu 24.04 and later, load the bwrap-userns-restrict AppArmor profile; elsewhere enable unprivileged user namespaces", link, path: f.bwrap, how: "started bwrap with a read-only root and ran true" });
  else rows.push({ id: "sandbox:ok", group: "sandbox", level: "ok", title: "the sandbox starts", detail: `bwrap at ${f.bwrap}; default profile ${f.profile}`, link, how: "started bwrap with a read-only root and ran true" });
  if (f.scope === false) rows.push({ id: "sandbox:scope", group: "sandbox", level: "warning", title: "commands cannot get a scope of their own", detail: f.scopeSaid, fix: "start a systemd user manager (loginctl enable-linger), or accept that commands share the daemon's limits", link, how: "ran systemd-run --user --scope true" });
  return rows;
}

// ---- telemetry export ----------------------------------------------------------

export type ObserveFacts = { otlp_endpoint?: string | null; otlp_headers?: unknown; otlp_metrics?: boolean | null; otlp_events?: boolean | null };

// What the OpenTelemetry exporter settings and variables ask for that has nowhere to go
// (mirrors src/admin/otlp.ts endpointOf and src/admin/otlp-signals.ts signalOn, signalEndpoint).
export function telemetryRows(o: ObserveFacts, env: Record<string, string | undefined>): Row[] {
  const link = { section: "observability" };
  const rows: Row[] = [];
  const traces = !!o.otlp_endpoint || !!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || !!env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const selects = (name: string) => (env[name] ?? "").split(",").map((s) => s.trim()).includes("otlp");
  const signal = (key: "metrics" | "logs", setting: boolean | null | undefined) => (typeof setting === "boolean" ? setting : selects(`OTEL_${key.toUpperCase()}_EXPORTER`));
  const endpointOf = (key: "metrics" | "logs") =>
    o.otlp_endpoint ? /\/v1\/traces\/?$/.test(o.otlp_endpoint) : !!env[`OTEL_EXPORTER_OTLP_${key.toUpperCase()}_ENDPOINT`] || !!env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (selects("OTEL_TRACES_EXPORTER") && !traces) rows.push({ id: "telemetry:traces", group: "telemetry", level: "broken", title: "OTEL_TRACES_EXPORTER is otlp and no endpoint is set", detail: "traces are not sent anywhere", fix: "set the endpoint in Settings > Observability, or set OTEL_EXPORTER_OTLP_ENDPOINT for the daemon", link });
  for (const [key, setting, name] of [["metrics", o.otlp_metrics, "metrics"], ["logs", o.otlp_events, "events"]] as const) {
    if (!signal(key, setting) || endpointOf(key)) continue;
    const custom = !!o.otlp_endpoint;
    rows.push({
      id: `telemetry:${key}`, group: "telemetry", level: "broken", title: `${name} export is on and has no endpoint`,
      detail: custom ? `the traces endpoint ${o.otlp_endpoint} does not end in /v1/traces, so Keel cannot derive the ${name} address from it` : `no OTEL_EXPORTER_OTLP_${key.toUpperCase()}_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT is set, and no endpoint in the settings`,
      fix: custom ? "end the traces endpoint in /v1/traces, or turn the signal off" : "set the endpoint in Settings > Observability, or turn the signal off", link,
    });
  }
  if (o.otlp_headers && !traces) rows.push({ id: "telemetry:headers", group: "telemetry", level: "warning", title: "export headers are set and no endpoint is", detail: "the headers are never sent", fix: "set the endpoint, or clear the headers", link });
  if (!rows.length) rows.push({ id: "telemetry:ok", group: "telemetry", level: "ok", title: traces ? "the exporter has an endpoint" : "telemetry export is off", link });
  return rows;
}

// ---- disk -----------------------------------------------------------------------

const GIB = 1024 ** 3, MIB = 1024 ** 2;
// Under this the daemon cannot count on a write landing: the database's log alone holds 66 MB before it is
// copied back, and a session's spilled output and checkpoints grow beside it.
export const DISK_BROKEN = GIB;
// Room for a backup copy of the database and for what a long run adds: the larger of this and twice the database.
export const DISK_WARN = 5 * GIB;

const size = (b: number) => (b >= GIB ? `${(b / GIB).toFixed(1)} GB` : `${Math.round(b / MIB)} MB`);

export function diskRow(f: { path: string; free: number; total: number; database: number }): Row {
  const link = { section: "storage" };
  const warn = Math.max(DISK_WARN, 2 * f.database);
  const pct = f.total ? Math.round((f.free / f.total) * 100) : 0;
  const detail = `${pct}% of ${size(f.total)} is free under ${f.path}; the database is ${size(f.database)}`;
  if (f.free < DISK_BROKEN) return { id: "disk:free", group: "disk", level: "broken", title: "the disk under the state folder is almost full", detail, fix: "free space: delete old archived sessions or clear spilled output in Settings > Storage", link, path: f.path };
  if (f.free < warn) return { id: "disk:free", group: "disk", level: "warning", title: "the disk under the state folder is getting full", detail: `${detail}; a backup copy of the database needs about ${size(f.database)} more`, fix: "free space in Settings > Storage before a long run", link, path: f.path };
  return { id: "disk:free", group: "disk", level: "ok", title: `${size(f.free)} free under the state folder`, detail, link, path: f.path };
}

// ---- MCP servers -----------------------------------------------------------------

// `bundled`: a server Keel brings itself (the browser bridge, the phone): not set up is not a failure to start.
export type McpFacts = { name: string; enabled: boolean; bundled?: boolean; state: string; error?: string; target?: string; held?: boolean; sign_in?: boolean; transport?: string };

export function mcpRows(servers: McpFacts[]): Row[] {
  const link = { section: "mcp" };
  const rows: Row[] = [];
  const on = servers.filter((s) => s.enabled && s.state !== "disabled" && !(s.bundled && (s.state === "missing" || s.state === "unreachable")));
  for (const s of on) {
    const where = s.target ? { path: s.target } : {};
    if (s.state === "error" || s.state === "unreachable" || s.state === "missing") rows.push({ id: `mcp:${s.name}`, group: "mcp", level: "broken", title: `${s.name} does not start`, detail: s.error ?? `its state is ${s.state}`, fix: s.transport === "stdio" ? "run its command in a terminal and fix what it prints; then reload the server" : "check the address and its sign-in; Keel tries a remote server again for a day", link, ...where });
    else if (s.state === "needs_auth") rows.push({ id: `mcp:${s.name}`, group: "mcp", level: "warning", title: `${s.name} needs a sign-in`, fix: "sign in from its entry", link, ...where });
    else if (s.held) rows.push({ id: `mcp:${s.name}:held`, group: "mcp", level: "warning", title: `${s.name} changed its tools and they are held`, fix: "read the change and accept it, or leave the old definitions", link, ...where });
  }
  if (!rows.length) rows.push({ id: "mcp:ok", group: "mcp", level: "ok", title: on.length ? `${on.length} MCP ${on.length === 1 ? "server" : "servers"} set up, none failing` : "no MCP servers set up", link });
  return rows;
}

// ---- providers -------------------------------------------------------------------

export type ProviderFacts = {
  id: string;
  label: string;
  // What the check did: a listing call, or nothing (with why).
  how: string;
  // The answer: how long it took and how many models it listed, or what failed, or the time it took to give up.
  // `error`: what failed; `byHand` is the number of models the configuration names (a listing that fails then
  // leaves the endpoint offering those), `status` the HTTP status when there was one.
  // `signedIn`: a sign-in read from its file, never asked: it ends at `until`, `refreshable`: a refresh token is stored.
  result: { ms: number; models: number } | { error: string; status?: number; byHand?: number } | { timedOut: number } | { skipped: string } | { signedIn: { until?: number; refreshable: boolean; now: number } };
  // A known account problem from an earlier listing or turn.
  problem?: { kind: string; message: string; source: string };
};

export function providerRows(list: ProviderFacts[]): Row[] {
  const link = { section: "providers" };
  const rows: Row[] = [];
  for (const p of list) {
    const base = { id: `provider:${p.id}`, group: "providers" as Group, link, how: p.how };
    const r = p.result;
    if ("skipped" in r) { rows.push({ ...base, level: "ok", title: `${p.label}: not checked`, detail: r.skipped }); continue; }
    if ("signedIn" in r) {
      const { until, refreshable, now } = r.signedIn;
      const at = until === undefined ? "" : new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      if (p.problem) rows.push({ ...base, level: "broken", title: `${p.label}: ${p.problem.kind} problem`, detail: p.problem.message, fix: p.problem.kind === "billing" ? "add credit or change the plan with the provider" : "sign in again in Settings > Providers", });
      else if (until !== undefined && until <= now && !refreshable) rows.push({ ...base, level: "broken", title: `${p.label}: the sign-in ended at ${at} and cannot be renewed`, fix: "sign in again in Settings > Providers" });
      else if (until !== undefined && until <= now) rows.push({ ...base, level: "ok", title: `${p.label}: signed in`, detail: `the access token ended at ${at}; it is renewed when a turn next needs it (this check does not renew it)` });
      else rows.push({ ...base, level: "ok", title: `${p.label}: signed in`, detail: at ? `the access token is valid until ${at}${refreshable ? ", and renews itself after that" : ""}` : "the stored sign-in has no end date" });
      continue;
    }
    if ("error" in r) {
      // An endpoint that names models by hand still offers them when its listing has no route: a warning. One that
      // cannot be reached at all offers models that cannot answer: broken.
      if (r.byHand && (r.status === 404 || r.status === 405 || r.status === 501)) { rows.push({ ...base, level: "warning", title: `${p.label}: its listing failed, the ${r.byHand} ${r.byHand === 1 ? "model" : "models"} set by hand are offered`, detail: r.error, fix: "take out the models set by hand if the server has a listing, or leave them if it has none" }); continue; }
      rows.push({ ...base, level: "broken", title: `${p.label} does not answer its listing`, detail: r.error, fix: /\b(401|403)\b|key|auth|sign|credential|token/i.test(r.error) ? "check the key or sign in again in Settings > Providers" : "check the address and your network, then read the listing again in Settings > Models" }); continue;
    }
    if ("timedOut" in r) { rows.push({ ...base, level: "warning", title: `${p.label} did not answer in ${Math.round(r.timedOut / 1000)} s`, fix: "check your network; a provider that is only slow shows up again here", }); continue; }
    if (p.problem) { rows.push({ ...base, level: "broken", title: `${p.label}: ${p.problem.kind} problem`, detail: p.problem.message, fix: p.problem.kind === "billing" ? "add credit or change the plan with the provider" : "sign in again or replace the key in Settings > Providers" }); continue; }
    rows.push({ ...base, level: "ok", title: `${p.label} answers`, detail: `${r.models} ${r.models === 1 ? "model" : "models"} listed in ${r.ms} ms` });
  }
  if (!rows.length) rows.push({ id: "providers:none", group: "providers", level: "warning", title: "no provider is set up", fix: "add a provider or sign in in Settings > Providers", link });
  return rows;
}

// ---- settings and layers ------------------------------------------------------------

export type LayerFacts = {
  // Why settings.json cannot be read, when it cannot.
  unreadable?: string;
  // Files a variable points to inside a folder a session works in: not loaded.
  refused: { name: string; path: string; folder: string }[];
  observe: ObserveFacts;
  env: Record<string, string | undefined>;
};

const REFUSED_LINK: Record<string, string> = { KEEL_HOOKS: "hooks", KEEL_MCP_CONFIG: "mcp", KEEL_ACP_AGENTS: "acp-agents", KEEL_ACP_FOLDERS: "acp-agents" };

export function layerRows(f: LayerFacts): Row[] {
  const rows: Row[] = [];
  if (f.unreadable !== undefined) rows.push({ id: "settings:unreadable", group: "settings", level: "broken", title: "settings.json cannot be read", detail: `${f.unreadable}; the defaults are used and saving is refused`, fix: "fix the file and restart the daemon, or reset it (the file moves aside)", link: { section: "storage" } });
  for (const r of f.refused) rows.push({ id: `settings:refused:${r.name}`, group: "settings", level: "broken", title: `${r.name} is not loaded`, detail: `${r.path} lies in ${r.folder}, a folder sessions work in: a command of a session could write it`, fix: "keep the file outside the folders sessions work in, then restart the daemon", link: { section: REFUSED_LINK[r.name] ?? "daemon" }, path: r.path });
  // A setting wins over the variable that names the same thing: the variable is read and ignored.
  const o = f.observe, e = f.env;
  const link = { section: "observability" };
  const varEndpoint = e.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? e.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (o.otlp_endpoint && varEndpoint) rows.push({ id: "settings:otlp-endpoint", group: "settings", level: "warning", title: "the export endpoint is set twice", detail: `the setting (${o.otlp_endpoint}) wins over the environment's (${varEndpoint}), which is ignored`, fix: "keep one: clear the setting, or unset the variable for the daemon", link });
  for (const [key, setting, name] of [["metrics", o.otlp_metrics, "otlp_metrics"], ["logs", o.otlp_events, "otlp_events"]] as const) {
    const sel = e[`OTEL_${key.toUpperCase()}_EXPORTER`];
    if (typeof setting !== "boolean" || !sel) continue;
    const says = sel.split(",").map((s) => s.trim()).includes("otlp");
    if (says !== setting) rows.push({ id: `settings:otlp-${key}`, group: "settings", level: "warning", title: `${name} overrides OTEL_${key.toUpperCase()}_EXPORTER`, detail: `the setting is ${setting ? "on" : "off"} and the variable says ${sel}: the setting wins`, fix: "keep one: set the setting to null, or unset the variable for the daemon", link });
  }
  return rows;
}

// The row for a settings group with nothing in it (the files' own findings of one file hiding another count too).
export const layersOk: Row = { id: "settings:ok", group: "settings", level: "ok", title: "settings.json is read, and no setting or file hides another", link: { section: "general" } };
