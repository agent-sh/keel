// keel status | drain | restart | upgrade | ui | storage | cleanup | backup |
// backups | restore | report | usage | service: the daemon's administration
// from a terminal. Each asks the running daemon over HTTP, except restore
// (the daemon must be stopped) and service (writes the systemd unit).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { unitTemplate } from "../admin/unit.ts";
import { claimState, lockHolder } from "../admin/daemon.ts";
import { parseBind } from "../core/bind.ts";
import { backupConfig, restore as restoreBackup } from "../admin/storage.ts";
import { configDir } from "../providers/config.ts";
import { authHeaders, findDaemon, refusal } from "./client.ts";
import { defaultStateDir } from "../core/paths.ts";

const stateDirOf = (v?: string) => (v ? resolve(v) : defaultStateDir());
// --url, KEEL_URL, the address the state folder's daemon recorded, the default bind.
const urlOf = (v?: string) => findDaemon({ url: v }).url;
const common = { url: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } } as const;

const mb = (b: number) => (b < 1 << 20 ? `${(b / 1024).toFixed(1)} KB` : b < 1 << 30 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / (1 << 30)).toFixed(2)} GB`);
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`);
const time = (ms: number) => new Date(ms).toLocaleString(undefined, { hourCycle: "h23" });

async function call(url: string, path: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url + path, { ...init, headers: { "content-type": "application/json", ...authHeaders() } });
  } catch {
    throw new Error(`no daemon answers at ${url} (pass --url or set KEEL_URL)`);
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(await refusal(url, r, body));
  return body;
}

// A command: its usage is its --help, and a bad option prints it (exit 3)
// before anything is asked of the daemon, as the client commands do.
function wrap(usage: string, opts: Record<string, any>, run: (v: any, pos: string[]) => Promise<number>) {
  return async (argv: string[]) => {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, options: { ...common, ...opts } });
    } catch (e) {
      console.error(`keel ${usage.split(" ")[1]}: ${(e as Error).message.replace(/\. To specify a positional.*$/s, "")}\n\n${usage}`);
      return 3;
    }
    const { values, positionals } = parsed as { values: any; positionals: string[] };
    if (values.help) return (console.log(usage), 0);
    try {
      return await run(values, positionals);
    } catch (e) {
      console.error(`keel: ${(e as Error).message}`);
      return 1;
    }
  };
}

const out = (v: any, j: boolean, text: () => string) => console.log(j ? JSON.stringify(v, null, 2) : text());

const status = wrap("keel status [--url URL] [--json]", {}, async (v) => {
  const d = await call(urlOf(v.url), "/api/daemon");
  const a = await call(urlOf(v.url), "/api/awake").catch(() => null);
  out({ ...d, awake: a }, !!v.json, () => [
    `daemon   pid ${d.pid}, up ${dur(d.uptime_ms)}, bun ${d.bun}${d.systemd ? ", under systemd" : ""}`,
    `state    ${d.state_dir}`,
    `turns    ${d.running.length} running${d.draining ? `; draining${d.draining.restart ? " for a restart" : ""} since ${time(d.draining.since_ms)}` : ""}`,
    d.restart_failed ? `restart  called off at ${time(d.restart_failed.ts_ms)}. ${d.restart_failed.error}` : "",
    a ? `awake    ${a.held ? `held (${a.reason})` : a.available ? "not held" : `not available${a.refused ? `: ${a.refused}` : ""}`}, mode ${a.mode}${a.on_battery ? ", on battery" : ""}` : "",
  ].filter(Boolean).join("\n"));
  return 0;
});

// Waits for the daemon to go away (and, for a restart, to answer again). A
// restart the daemon called off (its backup failed) ends the wait with its reason.
async function follow(url: string, oldPid: number, back: boolean, limitMs: number) {
  const until = Date.now() + limitMs;
  let gone = false;
  while (Date.now() < until) {
    await Bun.sleep(500);
    const d = await call(url, "/api/daemon").catch(() => null);
    if (d && d.pid === oldPid && !d.draining && d.restart_failed) throw new Error(`the restart was called off, and the daemon (pid ${oldPid}) takes work again. ${d.restart_failed.error}`);
    if (!d || d.pid !== oldPid) gone = true;
    if (gone && !back) return true;
    if (gone && d && d.pid !== oldPid) return d;
  }
  return null;
}

const drainCmd = (restart: boolean, upgrade = false) =>
  wrap(`keel ${upgrade ? "upgrade" : restart ? "restart" : "drain"} [--timeout SECONDS] [--no-wait] [--url URL]\n  ${upgrade ? "Restarts the daemon from the binary already at its path, the same as keel restart.\n  It installs nothing: put a new binary there first.\n  " : ""}Stops new work, lets running turns finish (default 120 s), parks the rest so they continue after the start, then ${restart ? "starts the daemon again from its binary" : "stops the daemon"}.`,
    { timeout: { type: "string" }, "no-wait": { type: "boolean" } },
    async (v) => {
      const url = urlOf(v.url);
      const d = await call(url, "/api/daemon");
      const t = v.timeout === undefined ? 120 : Number(v.timeout);
      if (!(t >= 0)) throw new Error("--timeout is a number of seconds");
      const r = await call(url, "/api/drain", { method: "POST", body: JSON.stringify({ timeout_seconds: t, restart }) });
      console.log(`draining: ${r.running.length} turns running, up to ${t} s`);
      if (v["no-wait"]) return 0;
      const done = await follow(url, d.pid, restart, (t + 90) * 1000);
      if (!done) throw new Error(restart ? "the daemon did not come back in time" : "the daemon did not stop in time");
      console.log(restart ? `restarted: pid ${(done as any).pid}` : "stopped");
      return 0;
    });

const storage = wrap("keel storage [--refresh] [--url URL] [--json]", { refresh: { type: "boolean" } }, async (v) => {
  const s = await call(urlOf(v.url), `/api/storage${v.refresh ? "?refresh=1" : ""}`);
  out(s, !!v.json, () => [
    `${s.state_dir}: ${mb(s.total_bytes)} (measured ${time(s.measured_ms)})`,
    `  database      ${mb(s.database_bytes)}  (${s.sessions.count} sessions, ${s.archived_sessions.count} archived, ${s.subagent_sessions.count} subagents; attachments ${mb(s.attachments_bytes)})`,
    `  checkpoints   ${mb(s.checkpoints_bytes)}`,
    `  worktrees     ${mb(s.worktrees_bytes)}`,
    `  spilled       ${mb(s.spilled_output_bytes)}${s.leftovers.count ? `  (${mb(s.leftovers.bytes)} left by ${s.leftovers.count} deleted sessions)` : ""}`,
    `  backups       ${mb(s.backups_bytes)}`,
    `  reports       ${mb(s.reports_bytes)}`,
  ].join("\n"));
  return 0;
});

const cleanup = wrap("keel cleanup --older-than DAYS [--yes] [--leftovers] [--url URL]\n  Lists archived sessions archived at least DAYS ago; --yes deletes them. --leftovers removes what deleted sessions left behind.",
  { "older-than": { type: "string" }, yes: { type: "boolean" }, leftovers: { type: "boolean" } },
  async (v) => {
    const url = urlOf(v.url);
    if (v.leftovers) {
      const r = await call(url, "/api/storage/cleanup", { method: "POST", body: JSON.stringify({ leftovers: true }) });
      console.log(`removed ${r.removed} leftover folders`);
      if (v["older-than"] === undefined) return 0;
    }
    const days = Number(v["older-than"]);
    if (!Number.isInteger(days) || days < 1) throw new Error("--older-than is a whole number of days");
    const list = await call(url, "/api/storage/cleanup", { method: "POST", body: JSON.stringify({ older_than_days: days }) });
    for (const s of list.sessions) console.log(`${time(s.updated_ms)}  ${mb(s.bytes).padStart(9)}  ${s.title || s.id}${s.subagents?.length ? `  (with ${s.subagents.length} subagent sessions)` : ""}`);
    console.log(`${list.sessions.length} archived sessions, ${mb(list.bytes)}`);
    if (!v.yes || !list.sessions.length) return (v.yes || !list.sessions.length ? 0 : console.log("run again with --yes to delete them"), 0);
    const r = await call(url, "/api/storage/cleanup", { method: "POST", body: JSON.stringify({ older_than_days: days, sessions: list.sessions.map((s: any) => ({ id: s.id, updated_ms: s.updated_ms, family_updated_ms: s.family_updated_ms })) }) });
    console.log(`deleted ${r.deleted.length}${r.skipped.length ? `, skipped ${r.skipped.length}: ${r.skipped.map((s: any) => s.why).join(", ")}` : ""}`);
    return 0;
  });

const backup = wrap("keel backup [--url URL]  A checked copy of the database, the settings and the config folder's files, kept under <state>/backups.", {}, async (v) => {
  const r = await call(urlOf(v.url), "/api/backups", { method: "POST" });
  console.log(`${r.backup.path}  ${mb(r.backup.bytes)}, ${r.backup.sessions} sessions, ${r.backup.events} events, checked`);
  return 0;
});

const backups = wrap("keel backups [--url URL] [--json]", {}, async (v) => {
  const r = await call(urlOf(v.url), "/api/backups");
  out(r, !!v.json, () => r.backups.map((b: any) => b.unreadable ? `${b.name}  ${b.created_ms ? time(b.created_ms) : "time unknown"}  ${b.unreadable}` : `${b.name}  ${time(b.created_ms)}  ${mb(b.bytes).padStart(9)}  ${b.sessions} sessions  (${b.reason})`).join("\n") || "no backups");
  return 0;
});

const RESTORE_USAGE = [
  "keel restore BACKUP [--state-dir DIR] [--config[=DIR]]",
  "  Puts a backup (a name from `keel backups` or a folder) in place of the state. The daemon must be stopped; the current files are kept beside it.",
  "  A backup also carries the config folder's files (MCP servers, hooks, skills, plugins, agents). They are left alone unless asked for:",
  "  --config      puts them back into this shell's config folder, when that is the folder the backup was made from",
  "  --config=DIR  puts them back into DIR",
  "  Each file put back keeps what it held beside it as <name>.prev. A sign-in is never part of a backup.",
].join("\n");

// The state folder says nothing about which config folder goes with it (a
// scratch daemon's backup restored into its scratch state, from a shell whose
// config folder is the owner's own), so config is put back only when asked,
// and into this shell's folder only when the backup came from it.
const restore = (argv: string[]) => {
  // A bare --config never takes the next word (the backup's name) as its folder: the folder is --config=DIR.
  let config: string | true | undefined;
  const rest = argv.filter((a) => {
    if (a !== "--config" && !a.startsWith("--config=")) return true;
    config = a.slice("--config=".length) || true;
    return false;
  });
  return wrap(RESTORE_USAGE, { "state-dir": { type: "string" } }, async (v, pos) => {
    const dir = stateDirOf(v["state-dir"]);
    if (!pos[0]) throw new Error("name the backup (keel backups lists them)");
    // `--config DIR` with a space would read DIR as a second backup name and put the files into this shell's folder.
    if (pos.length > 1) throw new Error(`one backup at a time: ${pos.slice(1).join(" ")} was not expected${config === true ? " (a config folder is named as --config=DIR)" : ""}`);
    const pid = lockHolder(dir);
    if (pid) throw new Error(`a daemon (pid ${pid}) uses ${dir}: stop it first (keel drain)`);
    const src = existsSync(pos[0]) ? resolve(pos[0]) : join(dir, "backups", pos[0]);
    if (!existsSync(src)) throw new Error(`no backup ${pos[0]}`);
    // Decided before anything moves: a refusal leaves the state as it is too.
    const held = backupConfig(src);
    const from = held.dir ?? "a folder it does not name";
    let into: string | undefined;
    if (config !== undefined) {
      if (!held.files) throw new Error("this backup carries no config files: --config has nothing to put back");
      const here = resolve(configDir());
      if (config === true && (!held.dir || resolve(held.dir) !== here)) throw new Error(`this backup's config files came from ${from}, and this shell's config folder is ${here}. Nothing was changed. Name the folder to put them into: --config=DIR`);
      into = config === true ? here : resolve(config);
    }
    // Held for the restore: no daemon starts on the folder in the middle of it.
    const claim = claimState(dir);
    if (!claim) throw new Error(`a daemon uses ${dir}: stop it first (keel drain)`);
    let r;
    try { r = restoreBackup(dir, src, into); } finally { claim.release(); }
    console.log(`restored ${r.sessions} sessions, ${r.events} events into ${dir}\nthe files it replaced are in ${r.aside}`);
    const n = (k: number) => `${k} config file${k === 1 ? "" : "s"}`;
    if (into) console.log(`put back ${r.config_files} of ${n(held.files)} into ${into}${held.dir && resolve(held.dir) !== into ? `, which is not the folder they came from (${from})` : ""}. A file not put back was already as the backup has it; what each replaced one held is beside it as .prev. A daemon that uses this folder takes them up at its next reload.`);
    else if (held.files) console.log(`left alone: the ${n(held.files)} this backup carries, from ${from}. The config folder is not part of the state folder, so it is put back only when asked: keel restore ${pos[0]}${v["state-dir"] ? ` --state-dir ${v["state-dir"]}` : ""} --config${held.dir ? `=${held.dir}` : "=DIR"}`);
    return 0;
  })(rest);
};

const report = wrap("keel report [--session ID] [--note TEXT] [--dry-run] [--url URL]\n  Writes a redacted bundle about a problem (no credentials) to <state>/reports.",
  { session: { type: "string" }, note: { type: "string" }, "dry-run": { type: "boolean" } },
  async (v) => {
    const r = await call(urlOf(v.url), "/api/report", { method: "POST", body: JSON.stringify({ session_id: v.session, note: v.note, dry_run: !!v["dry-run"] }) });
    out(r, !!v.json, () => `${r.path ?? "(dry run, nothing written)"}\n${r.summary}\nincludes: ${r.includes.join(", ")}`);
    return 0;
  });

const USAGE_USAGE = "keel usage [--days N] [--url URL] [--json]  Tokens, spend, cache and timings of the last N days (default 7).";
const usage = wrap(USAGE_USAGE, { days: { type: "string" } }, async (v) => {
  const days = v.days === undefined ? 7 : Number(v.days);
  if (!(Number.isFinite(days) && days > 0)) return (console.error(`keel usage: --days is a number of days above 0\n\n${USAGE_USAGE}`), 3);
  const since = Date.now() - days * 86_400_000;
  const t = await call(urlOf(v.url), `/api/telemetry?since_ms=${since}`);
  const ms = (x: number | null) => (x == null ? "none" : x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(2)} s`);
  out(t, !!v.json, () => [
    `${t.total.calls} model calls, ${t.total.errors} failed; ${t.total.tool_calls} tool calls, ${t.total.tool_errors} failed`,
    `spend ${t.total.cost_usd == null ? (t.total.unpriced_calls ? `unknown (${t.total.unpriced_calls} calls without a price)` : "none") : `$${t.total.cost_usd.toFixed(4)}`}`,
    `cache hit ${t.total.cache_hit_ratio == null ? "none" : `${Math.round(t.total.cache_hit_ratio * 100)}%`}; first token ${ms(t.total.ttft_p50)} median, ${ms(t.total.ttft_p95)} p95; request ${ms(t.total.latency_p50)} median`,
    "",
    ...t.by_model.map((m: any) => `  ${m.model.padEnd(48)} ${String(m.calls).padStart(5)} calls  cache ${m.cache_hit_ratio == null ? "  -" : `${Math.round(m.cache_hit_ratio * 100)}%`.padStart(4)}  first token ${ms(m.ttft_p50)}`),
  ].join("\n"));
  return 0;
});

// The systemd user unit. Written, never enabled or started by this command.
const service = wrap("keel service install [--bind HOST:PORT] [--print] [--exec PATH]\n  Writes ~/.config/systemd/user/keel-bun.service for this binary. It does not enable or start it.",
  { bind: { type: "string", default: "127.0.0.1:47960" }, print: { type: "boolean" }, exec: { type: "string" } },
  async (v, pos) => {
    if (pos[0] !== "install") throw new Error("keel service install");
    const bind = parseBind(v.bind);
    if ("error" in bind) throw new Error(bind.error);
    // A compiled binary is its own ExecStart; under bun it is bun and the script.
    const compiled = process.argv[1]?.startsWith("/$bunfs/");
    const exec = v.exec ?? (compiled ? process.execPath : `${process.execPath} ${resolve(process.argv[1]!)}`);
    const unit = unitTemplate.replace("@EXEC@", exec).replace("@BIND@", v.bind);
    if (v.print) return (process.stdout.write(unit), 0);
    const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user/keel-bun.service");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit);
    console.log(`wrote ${path}\nto use it: systemctl --user daemon-reload && systemctl --user enable --now keel-bun.service`);
    return 0;
  });

// The page without a restart (src/server/ui-bundle.ts): what is served, a bundle
// from `bun scripts/build.ts --ui OUT` to serve now, or back to the one before.
const uiCmd = wrap("keel ui [status | install BUNDLE.tar.gz | rollback] [--url URL] [--json]\n  Serves a new UI bundle at once: running turns go on and open pages reload into it.\n  A bundle built from other daemon sources is refused (it needs a restart onto a new binary).",
  {},
  async (v, pos) => {
    const url = urlOf(v.url);
    const [sub = "status", file] = pos;
    let st: any;
    if (sub === "status") st = await call(url, "/api/ui");
    else if (sub === "rollback") st = await call(url, "/api/ui/rollback", { method: "POST" });
    else if (sub === "install") {
      if (!file) throw new Error("keel ui install BUNDLE.tar.gz");
      const r = await fetch(url + "/api/ui", { method: "POST", body: Bun.file(file), headers: { "content-type": "application/gzip", ...authHeaders() } }).catch(() => {
        throw new Error(`no daemon answers at ${url} (pass --url or set KEEL_URL)`);
      });
      st = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(await refusal(url, r, st));
    } else throw new Error(`unknown: keel ui ${sub}`);
    const name = (x: any) => (x ? `${x.version} (${time(x.version)})` : "none");
    out(st, !!v.json, () => [
      `serving  ${st.active.source === "installed" ? `installed ${name({ version: Number(st.active.version) })}` : `embedded ${st.embedded.version}`}`,
      `kept     ${name(st.current)}, before it ${name(st.previous)}`,
      `api      ${st.api}`,
    ].join("\n"));
    return 0;
  });

export const adminCommands = {
  ui: uiCmd,
  status,
  drain: drainCmd(false),
  restart: drainCmd(true),
  upgrade: drainCmd(true, true),
  storage,
  cleanup,
  backup,
  backups,
  restore,
  report,
  usage,
  service,
};
