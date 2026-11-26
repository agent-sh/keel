// keel status | drain | restart | upgrade | ui | storage | doctor | cleanup | backup |
// backups | restore | report | usage | service: the daemon's administration
// from a terminal. Each asks the running daemon over HTTP, except restore
// (the daemon must be stopped) and service (writes the systemd unit).
import { zoned, zonedStamp } from "../core/clock.ts";
import { rankLines } from "../admin/turn-compare.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { unitFor, updateUnit } from "../admin/unit.ts";
import { claimState, lockHolder } from "../core/daemon-lock.ts";
import { restartSummary, restartTurnLine, type RestartTurn } from "../admin/life-rows.ts";
import { waitingWords } from "../admin/restart-wait.ts";
import { parseBind } from "../core/bind.ts";
import { configDir } from "../providers/config.ts";
import { authHeaders, clean, findDaemon, refusal } from "./client.ts";
import { defaultStateDir, homeDir } from "../core/paths.ts";
import { doctorExit, healthText, type HealthReport } from "../admin/health-rows.ts";

const stateDirOf = (v?: string) => (v ? resolve(v) : defaultStateDir());
// --url, KEEL_URL, the address the state folder's daemon recorded, the default bind.
const urlOf = (v?: string) => findDaemon({ url: v }).url;
const common = { url: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" } } as const;

const mb = (b: number) => (b < 1 << 20 ? `${(b / 1024).toFixed(1)} KB` : b < 1 << 30 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / (1 << 30)).toFixed(2)} GB`);
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`);
// The machine's own zone with its offset on the line, the same on every machine (clock.ts): a line is read alone.
const time = zonedStamp;

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

const STATUS_USAGE = `keel status [--url URL] [--json]                 the running daemon
keel status --sessions [--since 1h] [--max N] [--no-ids] [--json]
  Every open session in one short text: what needs you, what failed and why, what runs and
  for how long, and the turns and spend since a time (a span back such as 90s, 30m, 1h, 2d,
  or an ISO time; a day by default, at most 7 days). States, classes, counts and ids only, no prompt or output.
  --max N lists that many sessions (20 by default), the ones that need you first; --no-ids
  leaves the ids off the lines.
keel status --away [--since 1h] [--no-ids] [--json]
  What happened while you were not at a page of the daemon (no key or pointer input for five
  minutes): per session the turns that ended, failures by class, approvals waiting, agents parked
  and spend. --since gives the same for a window you name, at most 7 days back.`;
const status = wrap(STATUS_USAGE, { sessions: { type: "boolean" }, away: { type: "boolean" }, since: { type: "string" }, max: { type: "string" }, "no-ids": { type: "boolean" } }, async (v) => {
  if (v.sessions || v.away) {
    const q = new URLSearchParams(Object.entries({ since: v.since, max: v.sessions ? v.max : undefined, format: v.json ? undefined : "text", ids: v["no-ids"] && !v.json ? "0" : undefined }).filter(([, x]) => x) as [string, string][]);
    const url = urlOf(v.url);
    let r: Response;
    try {
      r = await fetch(`${url}/api/${v.away ? "away" : "overview"}?${q}`, { headers: authHeaders() });
    } catch {
      throw new Error(`no daemon answers at ${url} (pass --url or set KEEL_URL)`);
    }
    if (!r.ok) throw new Error(await refusal(url, r, await r.json().catch(() => ({}))));
    // Titles are a model's or the owner's words: no escape sequence of theirs reaches the terminal.
    process.stdout.write(v.json ? JSON.stringify(await r.json(), null, 2) + "\n" : clean(await r.text()));
    return 0;
  }
  if (v.since || v.max || v["no-ids"]) throw new Error("--since, --max and --no-ids go with --sessions or --away");
  const d = await call(urlOf(v.url), "/api/daemon");
  const a = await call(urlOf(v.url), "/api/awake").catch(() => null);
  out({ ...d, awake: a }, !!v.json, () => [
    `daemon   pid ${d.pid}, up ${dur(d.uptime_ms)}, bun ${d.bun}${d.systemd ? ", under systemd" : ""}`,
    `state    ${d.state_dir}`,
    `turns    ${d.running.length} running${d.draining ? `; draining${d.draining.restart ? " for a restart" : ""} since ${time(d.draining.since_ms)}${d.draining.backup_since_ms ? `, making the backup since ${time(d.draining.backup_since_ms)}` : ""}` : ""}`,
    d.restart_failed ? `restart  called off at ${time(d.restart_failed.ts_ms)}. ${d.restart_failed.error}` : "",
    // The last start: when the daemon before it went down, how, and each turn that cut.
    ...(d.last_start && (d.last_start.before || d.last_start.turns.length) ? [`start    ${restartSummary(d.last_start)}`, ...d.last_start.turns.map((t: RestartTurn) => `           ${restartTurnLine(t)}${t.state === "held" && t.why ? `\n             ${t.why}` : ""}`)] : []),
    d.restart_waiting ? `restart  ${waitingWords(d.restart_waiting, (ms) => time(ms))}` : "",
    a ? `awake    ${a.held ? `held (${a.reason})` : a.available ? "not held" : `not available${a.refused ? `: ${a.refused}` : ""}`}, mode ${a.mode}${a.on_battery ? ", on battery" : ""}` : "",
  ].filter(Boolean).join("\n"));
  return 0;
});

// Each thing a daemon says of its stop or restart, printed once.
const noted = new Set<string>();
const note = (notes: unknown) => {
  for (const n of Array.isArray(notes) ? notes : []) if (typeof n === "string" && !noted.has(n)) { noted.add(n); console.log(`note: ${n}`); }
};

// Waits for the daemon to go away (and, for a restart, to answer again). A
// restart the daemon called off (its backup failed) ends the wait with its reason.
async function follow(url: string, oldPid: number, back: boolean, limitMs: number) {
  let until = Date.now() + limitMs;
  // A daemon that says it is still draining is alive and at work (the backup
  // a restart waits on can take minutes on a large store): it is followed
  // for as long as it says so, up to the backup's own limit.
  const hard = Date.now() + limitMs + 30 * 60_000;
  let gone = false, said = false;
  while (Date.now() < until) {
    await Bun.sleep(500);
    const d = await call(url, "/api/daemon").catch(() => null);
    // What the stopping daemon says of this stop (no backup, what it could not save), and what the new one was left to say.
    if (d && d.pid === oldPid) note(d.draining?.notes);
    else if (d) note(d.start_notes);
    if (d && d.pid === oldPid && !d.draining && d.restart_failed) throw new Error(`the restart was called off, and the daemon (pid ${oldPid}) takes work again. ${d.restart_failed.error}`);
    if (d && d.pid === oldPid && d.draining) {
      until = Math.min(hard, Math.max(until, Date.now() + 90_000));
      if (d.draining.backup_since_ms && !said) { said = true; console.log("making the backup the restart waits on"); }
    }
    if (!d || d.pid !== oldPid) gone = true;
    if (gone && !back) return true;
    if (gone && d && d.pid !== oldPid) return d;
  }
  return null;
}

const drainCmd = (restart: boolean, upgrade = false) =>
  wrap(`keel ${upgrade ? "upgrade" : restart ? "restart" : "drain"} [--timeout SECONDS]${restart ? " [--now]" : ""} [--no-wait] [--url URL]\n  ${upgrade ? "Restarts the daemon from the binary already at its path, the same as keel restart.\n  It installs nothing: put a new binary there first.\n  " : ""}Stops new work, stops each running turn at its next step (a model request on its way gets up to 120 s by default), waits up to 60 s more for the commands a turn is still waiting on, parks the turns so they continue after the start, then ${restart ? "starts the daemon again from its binary" : "stops the daemon"}.${restart ? "\n  While you are at a page the restart waits until you step away (30 minutes at most), joined with any other restart\n  asked meanwhile, and the command ends at once saying so. --now restarts at once (an urgent build)." : ""}`,
    { timeout: { type: "string" }, "no-wait": { type: "boolean" }, ...(restart ? { now: { type: "boolean" as const } } : {}) },
    async (v) => {
      const url = urlOf(v.url);
      const d = await call(url, "/api/daemon");
      const t = v.timeout === undefined ? 120 : Number(v.timeout);
      if (!(t >= 0)) throw new Error("--timeout is a number of seconds");
      const r = await call(url, "/api/drain", { method: "POST", body: JSON.stringify({ timeout_seconds: t, restart, ...(restart && (v as { now?: boolean }).now ? { now: true } : {}), reason: `keel ${upgrade ? "upgrade" : restart ? "restart" : "drain"} from a terminal` }) });
      // The daemon holds it for the owner to step away: nothing to follow now.
      if (r.waiting) return (console.log(`waiting: ${waitingWords(r.waiting, (ms) => time(ms))}`), 0);
      console.log(`draining: ${r.running.length} turns running, up to ${t} s`);
      note(r.notes);
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
    `  transcripts   ${mb(s.memory_transcripts_bytes)}  (what the memory tool reads of each session)`,
    `  backups       ${mb(s.backups_bytes)}`,
    `  uploads       ${mb(s.uploads_bytes)}`,
    `  artifacts     ${mb(s.artifacts_bytes)}`,
    `  other         ${mb(s.other_bytes + s.reports_bytes + s.plugins_bytes + s.logs_bytes)}  (reports, plugin data, logs, settings and listing files)`,
  ].join("\n"));
  return 0;
});

// One list of what is wrong with this installation (the daemon's health check, also Settings > Health).
const doctor = wrap(
  "keel doctor [--cwd DIR] [--problems] [--url URL] [--json]\n  Broken skill, command, agent, plugin and config files; hooks that never run; a sandbox that cannot start;\n  settings one layer hides; each provider's reachability (a model listing call, never a paid request);\n  MCP servers that fail to start; a telemetry exporter with no endpoint; the disk under the state folder.\n  --cwd DIR reads that folder's own skills, commands, agents and hooks too (this folder by default);\n  --problems leaves out what is well. Exit status 1 when something is broken.",
  { cwd: { type: "string" }, problems: { type: "boolean" } },
  async (v) => {
    const r: HealthReport = await call(urlOf(v.url), `/api/health/check?cwd=${encodeURIComponent(resolve(v.cwd ?? process.cwd()))}`);
    out(r, !!v.json, () => healthText(r, { all: !v.problems }));
    return doctorExit(r.counts);
  },
);

// What sessions left behind: commands still running, worktrees and branches no live session holds.
const leftoversCmd = wrap("keel leftovers [--url URL] [--json]\n  Commands of sessions that still run, worktrees no live session works in, and branches no worktree has out,\n  with what each holds and who it is known by. Settings, Leftovers stops or removes them, one at a time or all at once.", {}, async (v) => {
  const s = await call(urlOf(v.url), "/api/leftovers");
  const ago = (ms?: number) => (ms ? `${dur(Date.now() - ms)} ago` : "");
  // Keel made it for that session, or it was new when that agent ended (who made it is not known).
  const byWord = (by: { how?: string }) => (by.how === "keel" ? "made for" : "found by");
  out(s, !!v.json, () => {
    const lines: string[] = [];
    lines.push(`left running (${s.processes.length})`);
    for (const p of s.processes) lines.push(`  ${p.job_id}  ${p.command.replace(/\s+/g, " ").slice(0, 70)}  pid ${p.pids.join(",")}${p.ports.length ? `  port ${p.ports.join(",")}` : ""}  ${p.agent ? `agent ${p.agent.status}` : "session"} "${p.title}"  ${ago(p.started)}`);
    lines.push(`worktrees (${s.worktrees.length})`);
    for (const w of s.worktrees) lines.push(`  ${w.path}  ${w.branch ?? "detached"}  ${w.dirty === undefined ? "status unknown" : `${w.dirty} uncommitted`}${w.ahead !== undefined ? `, ${w.ahead} not on ${w.base}` : ""}${w.by ? `  ${byWord(w.by)} "${w.by.title}"` : ""}${w.made ? `  ${ago(w.made)}` : ""}${w.removable ? "" : `  (kept: ${w.why})`}`);
    lines.push(`branches (${s.branches.length})`);
    for (const b of s.branches) lines.push(`  ${b.name}  ${b.ahead === undefined ? "not compared" : b.merged ? `merged into ${b.base}` : `${b.ahead} not on ${b.base}`}  ${ago(b.at)}${b.by ? `  ${byWord(b.by)} "${b.by.title}"` : ""}  ${b.top}`);
    return lines.join("\n");
  });
  return 0;
});

const cleanup = wrap("keel cleanup --older-than DAYS [--yes] [--leftovers] [--retention] [--url URL]\n  Lists archived sessions archived at least DAYS ago; --yes deletes them. --leftovers removes what deleted sessions left behind.\n  --retention lists the spilled output, usage records and outward ledger rows past the retention set in Settings, Storage; with --yes it removes them now.",
  { "older-than": { type: "string" }, yes: { type: "boolean" }, leftovers: { type: "boolean" }, retention: { type: "boolean" } },
  async (v) => {
    const url = urlOf(v.url);
    if (v.retention) {
      const { settings: s, due, proposed } = await call(url, "/api/storage/retention");
      const never = (d: number) => (d ? `kept ${d} days` : "kept for good");
      const left = [due.spill.busy_sessions ? `${due.spill.busy_sessions} working` : "", due.spill.pinned_sessions ? `${due.spill.pinned_sessions} pinned` : ""].filter(Boolean).join(" and ");
      console.log(`spilled output (${never(s.spill_days)} after its session was last used): ${due.spill.files} files, ${mb(due.spill.bytes)}, of ${due.spill.sessions} sessions are past it${left ? `; ${left} sessions are left alone` : ""}`);
      console.log(`usage records (${never(s.usage_days)}; the running month always): ${due.usage.calls} model calls and ${due.usage.tools} tool calls are past it`);
      console.log(`outward ledger (${never(s.egress_days)}): ${due.egress.rows} rows are past it`);
      if (proposed) console.log(`no spilled output or usage record is removed until a retention is set in Settings, Storage. With ${proposed.spill_days} and ${proposed.usage_days} days, ${proposed.due.spill.files} files (${mb(proposed.due.spill.bytes)}) and ${proposed.due.usage.calls + proposed.due.usage.tools} usage records would be past it now.`);
      const any = due.spill.files + due.usage.calls + due.usage.tools + due.egress.rows > 0;
      if (!v.yes || !any) return (console.log(any ? `the daily cleanup removes them at ${time(due.next_ms)}; run again with --yes to remove them now` : "nothing to remove"), 0);
      const r = await call(url, "/api/storage/retention", { method: "POST", body: JSON.stringify({ spill_before_ms: due.spill.before_ms, usage_before_ms: due.usage.before_ms, egress_before_ms: due.egress.before_ms, sessions: due.spill.session_ids }) });
      console.log(`removed ${r.removed.spill_files} files (${mb(r.removed.spill_bytes)}), ${r.removed.usage_calls} model calls, ${r.removed.usage_tools} tool calls and ${r.removed.egress_rows} outward ledger rows`);
      return 0;
    }
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
  console.log(`${r.backup.path}  ${mb(r.backup.bytes)}, ${r.backup.sessions} sessions, ${r.backup.events} events, ${r.backup.checked === "pages" ? `its pages checked (the changes since ${r.backup.base}); it is read back whole in a moment` : "checked"}`);
  return 0;
});

const backups = wrap("keel backups [--url URL] [--json]", {}, async (v) => {
  const r = await call(urlOf(v.url), "/api/backups");
  out(r, !!v.json, () => r.backups.map((b: any) => b.unreadable ? `${b.name}  ${b.created_ms ? time(b.created_ms) : "time unknown"}  ${b.unreadable}` : `${b.name}  ${time(b.created_ms)}  ${mb(b.bytes).padStart(9)}  ${b.sessions} sessions  (${b.reason})${b.base ? `  the changes since ${b.base}${b.base_missing ? ", which is gone: this one cannot be restored" : ""}` : ""}${b.failed ? `  NOT KNOWN WHOLE: ${b.failed}` : b.checked === "pages" ? "  its pages checked; not yet read back whole" : ""}${b.newest_whole ? "  (newest known whole)" : ""}`).join("\n") || "no backups");
  // The backup the last restart did not wait for (it would have read the whole store): the daemon makes it within a minute of its start.
  if (!v.json && r.owed) console.log(`a backup is owed since the restart at ${time(r.owed.since_ms)} (${r.owed.why}): the daemon makes it now`);
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
    // The store's own code is loaded for a restore, and by no other command here (the rest ask the daemon).
    const { backupConfig, restore: restoreBackup } = await import("../admin/storage.ts");
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

const USAGE_USAGE = `keel usage [--days N | --hours N] [--top N] [--slow [N]] [--tools] [--url URL] [--json]
  Tokens, spend, cache and timings of the last N days (default 7) or hours, then the spend ranked:
  by session, and by agent tree (a session with the agents under it). --top N lists N rows of each (default 10).
  --slow [N] lists instead the N model requests that took longest in the range, across sessions (default 20).
  --tools lists instead each tool's calls and failures, as Settings, Usage shows them, and under each tool
  the sessions its failures happened in, the most first.`;
const usage = wrap(USAGE_USAGE, { days: { type: "string" }, hours: { type: "string" }, top: { type: "string" }, slow: { type: "boolean" }, tools: { type: "boolean" } }, async (v, pos) => {
  if (v.days !== undefined && v.hours !== undefined) return (console.error(`keel usage: --days and --hours do not mix\n\n${USAGE_USAGE}`), 3);
  const n = v.hours !== undefined ? Number(v.hours) : v.days === undefined ? 7 : Number(v.days);
  if (!(Number.isFinite(n) && n > 0)) return (console.error(`keel usage: --${v.hours !== undefined ? "hours is a number of hours" : "days is a number of days"} above 0\n\n${USAGE_USAGE}`), 3);
  const top = v.top === undefined ? 10 : Number(v.top);
  if (!(Number.isInteger(top) && top > 0)) return (console.error(`keel usage: --top is a whole number above 0\n\n${USAGE_USAGE}`), 3);
  const since = Date.now() - n * (v.hours !== undefined ? 3_600_000 : 86_400_000);
  const url = urlOf(v.url);
  const ms = (x: number | null) => (x == null ? "none" : x < 1000 ? `${x} ms` : `${(x / 1000).toFixed(2)} s`);
  const range = `the last ${n} ${v.hours !== undefined ? (n === 1 ? "hour" : "hours") : n === 1 ? "day" : "days"}`;
  if (v.slow) {
    const limit = pos[0] === undefined ? 20 : Number(pos[0]);
    if (!(Number.isInteger(limit) && limit > 0)) return (console.error(`keel usage: --slow takes a whole number of requests\n\n${USAGE_USAGE}`), 3);
    const r = await call(url, `/api/telemetry/slowest?since_ms=${since}&limit=${limit}`);
    const z = zoned();
    out(r, !!v.json, () => [
      `The ${r.requests.length} slowest model requests of ${range}. ${z.note}.`,
      ...r.requests.map((q: any) => `  ${ms(q.latency_ms).padStart(9)}  first word ${ms(q.ttft_ms).padStart(8)}  ${z.stamp(q.ts)}  ${q.outcome === "ok" ? "" : `${q.error_class ?? q.outcome}  `}${q.model.slice(q.model.indexOf(":") + 1)}  ${(q.title ?? "a removed session").replace(/\s+/g, " ").slice(0, 48)}  [session=${q.session_id.slice(-12)}]`),
    ].join("\n"));
    return 0;
  }
  if (v.tools) {
    const t = await call(url, `/api/telemetry?since_ms=${since}`);
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    out({ since_ms: t.since_ms, until_ms: t.until_ms, total: { tool_calls: t.total.tool_calls, tool_errors: t.total.tool_errors }, tools: t.tools }, !!v.json, () => [
      `Tools of ${range}: ${t.total.tool_calls} tool calls, ${t.total.tool_errors} failed. A tool's failures are listed by session.`,
      ...(t.tools.length ? [] : ["  No tool calls in this range."]),
      ...t.tools.slice(0, top).flatMap((x: any) => [
        `  ${x.tool.padEnd(28)} ${String(x.tool_calls).padStart(6)} calls  ${x.tool_errors ? `${String(x.tool_errors).padStart(4)} failed (${pct(x.tool_error_rate)})` : "   0 failed"}  usual ${ms(x.p50_ms)}`,
        ...(x.failed_in ?? []).map((f: any) => `      ${String(f.failed).padStart(4)} of ${f.calls} in ${f.title === undefined ? "a removed session" : JSON.stringify((f.title || "(untitled)").replace(/\s+/g, " ").slice(0, 48))}  [session=${f.session_id.slice(-12)}]`),
        ...(x.failed_in_more ? [`      and ${x.failed_in_more} more sessions`] : []),
      ]),
      ...(t.tools.length > top ? [`  ${t.tools.length - top} more tools (--top N)`] : []),
    ].join("\n"));
    return 0;
  }
  const [t, bySession, byTree] = await Promise.all([
    // (refresh: the ledger is read now. The page takes the report the daemon keeps while it reads again; a command prints once.)
    call(url, `/api/telemetry?since_ms=${since}&refresh=1`),
    call(url, `/api/usage?group=session&sort=cost&since_ms=${since}&limit=${top + 200}`),
    call(url, `/api/usage?group=tree&sort=cost&since_ms=${since}&limit=${top + 200}`),
  ]);
  const title = (r: any) => (id: string) => r.sessions?.[id]?.title || (r.sessions?.[id] ? "(untitled)" : undefined);
  out({ ...t, by_session: bySession.buckets, by_tree: byTree.buckets, sessions: { ...bySession.sessions, ...byTree.sessions } }, !!v.json, () => [
    // The page's own figure (Settings > Usage, "Failed or refused"): failed requests and the ones the model declined.
    `${t.total.calls} model calls, ${t.total.failed ?? t.total.errors} failed or refused; ${t.total.tool_calls} tool calls, ${t.total.tool_errors} failed`,
    `spend ${t.total.cost_usd == null ? (t.total.unpriced_calls ? `unknown (${t.total.unpriced_calls} calls without a price)` : "none") : `$${t.total.cost_usd.toFixed(4)}`}`,
    `cache hit ${t.total.cache_hit_ratio == null ? "none" : `${Math.round(t.total.cache_hit_ratio * 100)}%`}; first token ${ms(t.total.ttft_p50)} median, ${ms(t.total.ttft_p95)} p95; request ${ms(t.total.latency_p50)} median`,
    "",
    ...t.by_model.map((m: any) => `  ${m.model.padEnd(48)} ${String(m.calls).padStart(5)} calls  cache ${m.cache_hit_ratio == null ? "  -" : `${Math.round(m.cache_hit_ratio * 100)}%`.padStart(4)}  first token ${ms(m.ttft_p50)}`),
    ...(bySession.buckets?.length ? ["", `Spend by session, ${range}, dearest first:`, ...rankLines(bySession.buckets, title(bySession), top)] : []),
    ...(byTree.buckets?.some((b: any) => b.agents) ? ["", "Spend by agent tree (a session with the agents under it):", ...rankLines(byTree.buckets, title(byTree), top)] : []),
  ].join("\n"));
  return 0;
});

// What happened, across sessions, as text: one line a turn, an agent, an alert, a restart.
const ACTIVITY_USAGE = `keel activity [--since 1h] [--until 30m] [--failures] [--session ID] [--kind KIND[,KIND]] [--grep TEXT] [--limit N] [--all] [--before CURSOR] [--no-ids] [--url URL] [--json]
  Everything the daemon and its sessions did, newest first, a line a row: a turn's end (one row a turn, with what it
  said at its end), an agent started or settled, a loop run, a wait, an approval answered, a restart with the turns it cut.
  --failures lists only what went wrong. --since and --until take a span back from now (90s, 30m, 1h, 2d) or an ISO time.
  --session takes a session's id, a prefix of it or its last twelve characters. Kinds: alert, turn, agent, loop, wait,
  approval, awake, snooze, daemon, memory. Across sessions a session is held to its 3 newest rows and the rest are
  counted ("N more"); --all lists every row, and so does --session. Times are local, with the offset said once.`;
const activityCmd = wrap(ACTIVITY_USAGE, {
  since: { type: "string" }, until: { type: "string" }, failures: { type: "boolean" }, session: { type: "string" }, kind: { type: "string" }, grep: { type: "string" },
  limit: { type: "string" }, all: { type: "boolean" }, before: { type: "string" }, "no-ids": { type: "boolean" },
}, async (v) => {
  const q = new URLSearchParams(Object.entries({
    since: v.since, until: v.until, only: v.failures ? "failures" : undefined, session_id: v.session, kind: v.kind, q: v.grep, limit: v.limit ?? "60", before: v.before,
    cap: v.all || v.session ? undefined : "3", format: v.json ? undefined : "text", ids: v["no-ids"] && !v.json ? "0" : undefined,
  }).filter(([, x]) => x) as [string, string][]);
  const url = urlOf(v.url);
  let r: Response;
  try {
    r = await fetch(`${url}/api/activity?${q}`, { headers: authHeaders() });
  } catch {
    throw new Error(`no daemon answers at ${url} (pass --url or set KEEL_URL)`);
  }
  if (!r.ok) throw new Error(await refusal(url, r, await r.json().catch(() => ({}))));
  // Titles and replies are a model's or the owner's words: no escape sequence of theirs reaches the terminal.
  process.stdout.write(v.json ? JSON.stringify(await r.json(), null, 2) + "\n" : clean(await r.text()));
  return 0;
});

// The systemd user unit. Written, never enabled or started by this command.
const SERVICE_USAGE = "keel service install [--bind HOST:PORT] [--workspace DIR] [--state-dir DIR] [--exec PATH] [--print]\n  Writes ~/.config/systemd/user/keel-bun.service for this binary. It does not enable or start it.\n  --workspace and --state-dir are kept in the unit as absolute paths; without them the daemon uses its defaults.\n  --exec names another binary to start; --print shows the unit and writes nothing.\nkeel service update [--print]\n  Brings the installed unit up to this build: the lines the build owns (the restart wait, the bound on\n  starts, the daemon's settings) are set, every other line and every drop-in stay as they are. The unit\n  as it was is kept beside it as keel-bun.service.prev. --print shows the result and writes nothing.";
const service = wrap(SERVICE_USAGE,
  { bind: { type: "string", default: "127.0.0.1:47960" }, print: { type: "boolean" }, exec: { type: "string" }, workspace: { type: "string" }, "state-dir": { type: "string" } },
  async (v, pos) => {
    if (pos[0] !== "install" && pos[0] !== "update") throw new Error("keel service install, or keel service update");
    const bind = parseBind(v.bind);
    if ("error" in bind) throw new Error(bind.error);
    // A compiled binary is its own command; under bun it is bun and the script.
    // Each is one word of ExecStart, whatever its path holds.
    const compiled = process.argv[1]?.startsWith("/$bunfs/");
    const command = v.exec ? [resolve(v.exec)] : compiled ? [process.execPath] : [process.execPath, resolve(process.argv[1]!)];
    const unit = unitFor({ command, bind: v.bind, workspace: v.workspace ? resolve(v.workspace) : undefined, stateDir: v["state-dir"] ? resolve(v["state-dir"]) : undefined });
    const path = join(process.env.XDG_CONFIG_HOME ?? join(homeDir(), ".config"), "systemd/user/keel-bun.service");
    if (pos[0] === "update") {
      // The unit as it is installed, with the owner's own lines: only what this build owns is set.
      if (!existsSync(path)) throw new Error(`no unit at ${path}: keel service install writes one`);
      const was = readFileSync(path, "utf8");
      const { text, changed } = updateUnit(was, unit);
      if (v.print) return (process.stdout.write(text), 0);
      if (!changed.length) return (console.log(`${path} is up to date with this build`), 0);
      writeFileSync(`${path}.prev`, was);
      writeFileSync(`${path}.new`, text);
      renameSync(`${path}.new`, path);
      console.log([
        `updated ${path} (the unit as it was: ${path}.prev)`,
        ...changed.map((c) => `  ${c}`),
        "every other line, and every drop-in, is as it was. A drop-in that sets one of these still wins.",
        "to take it up: systemctl --user daemon-reload (the running daemon goes on; the restart wait and the bound on starts hold from then, its settings from its next start)",
      ].join("\n"));
      return 0;
    }
    if (v.print) return (process.stdout.write(unit), 0);
    mkdirSync(dirname(path), { recursive: true });
    // A unit already there is written over (it may hold the owner's own lines: keel service update keeps them); what it held stays beside it.
    const was = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (was !== undefined && was !== unit) writeFileSync(`${path}.prev`, was);
    writeFileSync(path, unit);
    console.log(`wrote ${path}${was !== undefined && was !== unit ? ` (the unit it replaced: ${path}.prev)` : ""}\nto use it: systemctl --user daemon-reload && systemctl --user enable --now keel-bun.service`);
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
      // The bundle is checked here first: a path that is not a file is this machine's problem, not the daemon's.
      const path = resolve(file);
      const info = statSync(path, { throwIfNoEntry: false });
      if (!info) throw new Error(`no UI bundle at ${path}`);
      if (!info.isFile()) throw new Error(`${path} is a ${info.isDirectory() ? "folder" : "special file"}, not a UI bundle (bun scripts/build.ts --ui OUT.tar.gz makes one)`);
      const r = await fetch(url + "/api/ui", { method: "POST", body: Bun.file(path), headers: { "content-type": "application/gzip", ...authHeaders() } }).catch(() => {
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
  leftovers: leftoversCmd,
  doctor,
  cleanup,
  backup,
  backups,
  restore,
  report,
  usage,
  activity: activityCmd,
  service,
};
