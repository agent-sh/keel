// The health check: one list of what is wrong with this installation, from the
// pieces Keel already has (the hook parser, the sandbox probe, the MCP manager's
// states, the provider listings, the settings, the config files). It changes none
// of the owner's files or settings and asks for nothing that costs tokens (the
// words are CHECK_NOTE in health-rows.ts). Each check runs on its own, bounded in
// time: a check that does not finish says so as a row and the rest still
// answer. File walks run on the read thread; the rest wait on a process or the
// network, never on the loop.
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../core/store.ts";
import { readText } from "../core/proc.ts";
import type { Providers } from "../providers/registry.ts";
import { EndpointProvider } from "../providers/endpoint.ts";
import { CodexProvider } from "../providers/codex.ts";
import { XaiProvider } from "../providers/xai.ts";
import { configDir } from "../providers/config.ts";
import { mayReadHome } from "../core/paths.ts";
import { readsOf } from "../server/reads.ts";
import { Hooks, namesOf } from "../integrations/hooks.ts";
import { toolFacts } from "../tools/registry.ts";
import { carriedPlugins, commandRoots, skillFilter, skillRoots, skillsConfig } from "../tools/skills.ts";
import { agentFolders, builtinAgentNames } from "../automation/agents.ts";
import { installedUnits } from "../plugins/registry.ts";
import { configPath } from "../mcp/config.ts";
import { storePath } from "../core/store-files.ts";
import { refusedConfigs } from "../core/named-config.ts";
import { secretsLost, startedWithSecrets } from "../safety/closed-env.ts";
import { settings, settingsUnreadable } from "./settings.ts";
import { ERROR_TYPES } from "../server/routes/hooks.ts";
import { gate } from "../server/routes/permissions.ts";
import type { FilesAsk, FilesResult, HeldFile } from "./health-files.ts";
import { countsOf, ordered, type HealthReport, type Row } from "./health-rows.ts";
import { agnix } from "../integrations/agnix.ts";
import { agnixRows, diskRow, hookRows, layerRows, layersOk, mcpRows, processRows, providerRows, sandboxRows, telemetryRows, type MatcherFacts, type ProviderFacts } from "./health-rules.ts";

export type HealthDeps = { store: Store; providers: Providers };

// The time one check gets. A listing that takes longer than the provider limit says so by name.
export const CHECK_MS = 15_000;
export const PROVIDER_MS = 8_000;
const PROBE_MS = 5_000;

// A check's rows, or one row that says it did not finish (or why it failed).
export async function bounded(name: string, group: Row["group"], ms: number, run: () => Promise<Row[]> | Row[]): Promise<Row[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<"late">((ok) => { timer = setTimeout(() => ok("late"), ms); });
    const r = await Promise.race([Promise.resolve().then(run), late]);
    if (r === "late") return [{ id: `${group}:late`, group, level: "warning", title: `the ${name} check did not finish in ${Math.round(ms / 1000)} s`, fix: "run the check again; if it keeps timing out, something it reads is stuck" }];
    return r;
  } catch (e) {
    return [{ id: `${group}:failed`, group, level: "warning", title: `the ${name} check failed`, detail: (e as Error).message.slice(0, 300), fix: "run the check again; a failure that repeats is a bug in Keel" }];
  } finally { clearTimeout(timer); }
}

// ---- the files ---------------------------------------------------------------

// The repository's skills and commands the trust pin holds back (src/tools/skills.ts asks the same filter),
// by the folder of a skill and the file of a command. The pin lives on the loop, so it is asked here; a
// repository holds a handful of them.
const HELD_MAX = 200;
function heldBack(cwd: string): HeldFile[] {
  const out: HeldFile[] = [];
  if (!skillFilter.allow) return out;
  const names = (dir: string) => { try { return readdirSync(dir).sort(); } catch { return []; } };
  const ask = (held: string) => {
    if (out.length >= HELD_MAX || skillFilter.allow!(held)) return;
    out.push({ path: held, why: skillFilter.held?.(held) ?? "the owner has not trusted it" });
  };
  for (const r of skillRoots(cwd).filter((x) => x.scope !== "personal")) {
    for (const n of names(r.dir)) if (!n.startsWith(".") && n !== "synced" && existsSync(join(r.dir, n, "SKILL.md"))) ask(join(r.dir, n));
  }
  for (const r of commandRoots(cwd).filter((x) => x.scope !== "personal")) {
    for (const n of names(r.dir)) if (n.endsWith(".md") && !n.startsWith(".")) ask(join(r.dir, n));
  }
  return out;
}

function filesAsk(cwd: string): FilesAsk {
  const cfg = skillsConfig();
  const units = installedUnits().filter((u) => u.enabled);
  const carried = carriedPlugins();
  const skills = skillRoots(cwd);
  const folders: FilesAsk["folders"] = [
    // The order the readers take them (src/tools/skills.ts discoverSkills): the owner's folders, the ones he added, plugins, then the repository's.
    ...skills.filter((r) => r.scope === "personal").map((r) => ({ dir: r.dir, kind: "skill" as const, layer: "personal" })),
    ...(cfg.roots ?? []).filter((r) => typeof r?.dir === "string").map((r) => ({ dir: r.dir, kind: "skill" as const, layer: "personal", nested: !!r.nested, exclude: r.exclude, chosen: true })),
    ...carried.map((p) => ({ dir: join(p.dir, "skills"), kind: "skill" as const, layer: "plugin", prefix: `${p.name}:` })),
    ...skills.filter((r) => r.scope !== "personal").map((r) => ({ dir: r.dir, kind: "skill" as const, layer: "project" })),
    ...commandRoots(cwd).map((r) => ({ dir: r.dir, kind: "command" as const, layer: r.scope === "personal" ? "personal" : "project" })),
    ...carried.map((p) => ({ dir: join(p.dir, "commands"), kind: "command" as const, layer: "plugin", prefix: `${p.name}:` })),
    ...agentFolders(cwd).map((f) => ({ dir: f.dir, kind: f.codex ? ("codex agent" as const) : ("agent" as const), layer: f.layer })),
    ...carried.map((p) => ({ dir: join(p.dir, "agents"), kind: "agent" as const, layer: "plugin", prefix: `${p.name}:` })),
  ];
  const plugins = units.map((u) => ({
    id: u.id, dir: u.dir,
    files: [
      ...u.skills.map((k) => ({ kind: "skill" as const, file: join(k.dir, "SKILL.md"), name: k.name })),
      ...u.commands.map((c) => ({ kind: "command" as const, file: c.file, name: c.name })),
      ...u.agents.map((a) => ({ kind: "agent" as const, file: a.file, name: a.name })),
    ],
  }));
  return { folders, plugins, held: heldBack(cwd), builtins: builtinAgentNames(), json: [join(configDir(), "skills.json"), join(configDir(), "plugins.json"), configPath()] };
}

const SECTION: Record<string, string> = { skill: "skills", command: "commands", agent: "agents", "codex agent": "agents", plugin: "plugins", config: "mcp" };
const sectionOf = (kind: string, path: string) => (kind === "config" ? (path.endsWith("skills.json") ? "skills" : path.endsWith("plugins.json") ? "plugins" : "mcp") : SECTION[kind] ?? "skills");
const KIND_WORD: Record<string, string> = { skill: "skill", command: "command", agent: "agent", "codex agent": "agent", plugin: "plugin", config: "config file" };

async function files(store: Store, cwd: string): Promise<{ files: Row[]; layers: Row[] }> {
  const r = (await readsOf(store).run("health.files", filesAsk(cwd))) as FilesResult;
  const rows: Row[] = [], layers: Row[] = [];
  for (const f of r.findings) {
    const row: Row = {
      id: `${f.group}:${f.kind}:${f.path}:${f.why}`, group: f.group, level: f.level, title: `${KIND_WORD[f.kind]} ${f.name}`, detail: f.why, fix: f.fix,
      link: { section: sectionOf(f.kind, f.path) }, path: f.path,
    };
    (f.group === "settings" ? layers : rows).push(row);
  }
  const c = r.counts;
  const read = [c.skill && `${c.skill} ${c.skill === 1 ? "skill" : "skills"}`, c.command && `${c.command} ${c.command === 1 ? "command" : "commands"}`, c.agent && `${c.agent} ${c.agent === 1 ? "agent" : "agents"}`, c.plugin && `${c.plugin} ${c.plugin === 1 ? "plugin" : "plugins"}`, c.config && `${c.config} config ${c.config === 1 ? "file" : "files"}`].filter(Boolean).join(", ");
  if (!rows.length) rows.push({ id: "files:ok", group: "files", level: "ok", title: read ? `${read} read, none broken` : "no skills, commands, agents or plugins found", link: { section: "skills" } });
  if (r.truncated) rows.push({ id: "files:truncated", group: "files", level: "warning", title: "more files than one check reads", detail: "the check stopped partway: the rest were not read", fix: "keep the skill folders to what you use", link: { section: "skills" } });
  return { files: rows, layers };
}

// ---- hooks -------------------------------------------------------------------

let hooksOf: { store: Store; hooks: Hooks } | undefined;

const hooksFacts = (): MatcherFacts => ({
  // Every family's tools, and the names a hook file written for another harness gives them (namesOf).
  tools: new Set([...toolFacts().flatMap((t) => namesOf(t.name, {})), "Bash", "Edit", "Write"]),
  values: {
    SessionStart: ["startup", "clear", "compact"],
    SessionEnd: ["other"],
    PreCompact: ["manual", "auto"],
    PostCompact: ["manual", "auto"],
    StopFailure: [...new Set([...Object.values(ERROR_TYPES), "max_output_tokens", "unknown"])],
  },
});

function hooks(store: Store, cwd: string): Row[] {
  if (hooksOf?.store !== store) hooksOf = { store, hooks: new Hooks(store) };
  const srcs = hooksOf.hooks.sources(cwd);
  return hookRows(srcs.map((s) => ({
    path: s.path, scope: s.scope, active: s.active, problems: s.problems,
    groups: Object.entries(s.groups).flatMap(([event, gs]) => (gs ?? []).map((g) => ({ path: s.path, event, matcher: g.matcher }))),
  })), hooksFacts());
}

// ---- the sandbox ---------------------------------------------------------------

// Runs a program and says whether it succeeded, in at most `ms`; the process is killed past that.
async function probe(argv: string[], ms: number): Promise<{ ok: boolean; said: string; timedOut: boolean }> {
  const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; p.kill(); }, ms);
  try {
    const [code, err] = await Promise.all([p.exited, readText(p.stderr, "health probe")]);
    return { ok: code === 0 && !timedOut, said: err.trim().slice(0, 300), timedOut };
  } finally { clearTimeout(t); }
}

async function sandbox(): Promise<Row[]> {
  const profile = gate?.defaultSandbox() ?? "off";
  if (process.platform !== "linux") return sandboxRows({ platform: process.platform, profile });
  const bwrap = Bun.which("bwrap") ?? undefined;
  const sr = Bun.which("systemd-run");
  const [b, s] = await Promise.all([
    bwrap ? probe([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "true"], PROBE_MS) : undefined,
    sr ? probe([sr, "--user", "--scope", "--quiet", "--collect", "true"], PROBE_MS) : undefined,
  ]);
  return [...sandboxRows({
    platform: "linux", profile, bwrap, started: b?.ok, said: b?.said, timedOut: b?.timedOut,
    // A machine with no systemd-run wraps nothing and needs no scope: not a fault.
    ...(s ? { scope: s.ok, scopeSaid: s.timedOut ? "it did not answer in time" : s.said } : {}),
  }), ...processRows({ platform: "linux", held: startedWithSecrets(), yama: yamaScope(), lost: secretsLost() })];
}

function yamaScope(): number | undefined {
  try { return Number(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim()); } catch { return undefined; }
}

// ---- providers -------------------------------------------------------------------

export async function providerFacts(reg: Pick<Providers, "all" | "problem">): Promise<ProviderFacts[]> {
  return Promise.all(reg.all().filter((p) => p.available()).map(async (p): Promise<ProviderFacts> => {
    const known = reg.problem(p.id);
    const base = { id: p.id, label: p.label ?? p.id, problem: known && { kind: known.kind, message: known.message, source: known.source } };
    // An agent of another program and the scripted stand-in have nothing to reach; an endpoint with no listing
    // would need a request that costs tokens, which this check never sends.
    if (p.id === "acp" || p.id === "scripted") return { ...base, how: "no call made", result: { skipped: "answers locally: there is nothing to reach" } };
    if (p instanceof EndpointProvider && p.cfg.listing === false) return { ...base, how: "no call made", result: { skipped: "this endpoint has no model listing, and the only other check would be a request that spends tokens" } };
    // A listing from these two can renew the sign-in and rewrite its file (and Grok's can move its surface), which a
    // check that changes nothing must not do: they are read from the stored sign-in, and the first turn that needs
    // a token renews it as it always did.
    if (p instanceof CodexProvider || p instanceof XaiProvider) {
      const how = "read from the stored sign-in; no call made, because asking for the model listing can renew the token and rewrite the sign-in file";
      const st = p.stored();
      return st ? { ...base, how, result: { signedIn: { until: st.expires_at_ms, refreshable: st.refreshable, now: Date.now() } } } : { ...base, how, result: { error: "not signed in" } };
    }
    const how = p instanceof EndpointProvider
      ? "asked the server for its model listing, a read that spends no tokens"
      : "asked for its model listing, a read that spends no tokens";
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // An endpoint's own `list` falls back to the models the configuration names when the read fails: asked strictly here.
      const r = await Promise.race([p instanceof EndpointProvider ? p.listStrict() : p.list(), new Promise<"late">((ok) => { timer = setTimeout(() => ok("late"), PROVIDER_MS); })]);
      if (r === "late") return { ...base, how, result: { timedOut: PROVIDER_MS } };
      return { ...base, how, result: { ms: Date.now() - t0, models: r.length } };
    } catch (e) {
      const byHand = p instanceof EndpointProvider ? p.cfg.models?.length : undefined;
      return { ...base, how, result: { error: (e as Error).message.slice(0, 300), status: (e as { status?: number }).status, ...(byHand ? { byHand } : {}) } };
    } finally { clearTimeout(timer); }
  }));
}

const providers = async (reg: Providers): Promise<Row[]> => providerRows(await providerFacts(reg));

// ---- MCP servers --------------------------------------------------------------------

function mcp(): Row[] {
  const m = (globalThis as { __keelMcp?: { list(): any[] } }).__keelMcp;
  return mcpRows((m?.list() ?? []).map((s) => ({ name: s.name, enabled: s.enabled, state: s.state, error: s.error, target: s.target, held: !!s.held, sign_in: s.sign_in, transport: s.transport, bundled: !!s.bundled, dropped: s.dropped_lines })));
}

// ---- disk ---------------------------------------------------------------------------

function disk(store: Store): Row[] {
  const f = statfsSync(store.stateDir);
  const database = (() => { try { return statSync(storePath(store.stateDir)).size; } catch { return 0; } })();
  return [diskRow({ path: store.stateDir, free: Number(f.bavail) * Number(f.bsize), total: Number(f.blocks) * Number(f.bsize), database })];
}

// ---- the whole check -----------------------------------------------------------------

export async function runHealth(deps: HealthDeps, cwd: string): Promise<HealthReport> {
  const t0 = Date.now();
  // The file walk answers two groups, the files and the layers; the layers wait on it.
  let held: Row[] = [];
  const walked = bounded("files", "files", CHECK_MS, async () => { const r = await files(deps.store, cwd); held = r.layers; return r.files; });
  const [fileRows, agnixOut, hookRowsOut, sandboxOut, providerOut, mcpOut, telemetryOut, diskOut] = await Promise.all([
    walked,
    bounded("agnix", "agnix", CHECK_MS, () => { const a = agnix(); return a ? agnixRows({ installed: a.installed(), folders: a.all() }) : []; }),
    bounded("hooks", "hooks", CHECK_MS, () => hooks(deps.store, cwd)),
    bounded("sandbox", "sandbox", CHECK_MS, sandbox),
    bounded("providers", "providers", CHECK_MS, () => providers(deps.providers)),
    bounded("MCP", "mcp", CHECK_MS, mcp),
    bounded("telemetry", "telemetry", CHECK_MS, () => telemetryRows(settings().observe ?? {}, process.env)),
    bounded("disk", "disk", CHECK_MS, () => disk(deps.store)),
  ]);
  const layers = layerRows({ unreadable: settingsUnreadable(), refused: refusedConfigs(), observe: settings().observe ?? {}, env: process.env, homeWithheld: !mayReadHome() });
  const layerOut = [...layers, ...held];
  const rows = ordered([...fileRows, ...agnixOut, ...hookRowsOut, ...(layerOut.length ? layerOut : [layersOk]), ...sandboxOut, ...providerOut, ...mcpOut, ...telemetryOut, ...diskOut]);
  return { at: t0, took_ms: Date.now() - t0, rows, counts: countsOf(rows) };
}
