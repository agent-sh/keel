// keel plugin check: the conformance runner of provider plugin protocol v1.
//   keel plugin check <plugin-id> [--json] [--only <fixture>]...
//   keel plugin check --id <plugin-id> --command <path> [--json] [--only <fixture>]... [-- <arg>...]
// Exit 0 when no fixture failed, 1 when one did, 2 when the check could not start.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Check, type Row, type Target } from "../providers/plugins/check.ts";
import { readPlugins } from "../providers/plugins/config.ts";
import { defaultStateDir } from "../core/paths.ts";
import { clean, command, EXIT, printJson, shown, usageError, type Client } from "./client.ts";

const USAGE = "usage: keel plugin check <plugin-id> [--json] [--only <fixture>]...\n       keel plugin check --id <plugin-id> --command <path> [--json] [--only <fixture>]... [-- <arg>...]";

async function check(argv: string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const extra = dash >= 0 ? argv.slice(dash + 1) : [];
  let parsed;
  try {
    parsed = parseArgs({ args: own, allowPositionals: true, options: { json: { type: "boolean" }, only: { type: "string", multiple: true }, id: { type: "string" }, command: { type: "string" }, "state-dir": { type: "string" }, help: { type: "boolean" } } });
  } catch (e) {
    console.error(`keel plugin check: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) return (console.log(USAGE), 0);
  let target: Target;
  if (values.command) {
    if (!values.id) return (console.error("keel plugin check: --command needs --id <plugin-id>, the id the check sends in initialize"), 2);
    target = { id: values.id, command: resolve(values.command), args: extra, env: [], settings: {}, providerSettings: {} };
  } else {
    const id = positionals[0];
    if (!id) return (console.error(USAGE), 2);
    const { file, entries, error } = readPlugins();
    if (error) return (console.error(`keel plugin check: ${error}`), 2);
    const e = entries.find((x) => x.id === id);
    if (!e) return (console.error(`keel plugin check: no [plugins.${id}] in ${file ?? "plugins.toml (none found)"}`), 2);
    if (e.problem) return (console.error(`keel plugin check: [plugins.${id}]: ${e.problem}`), 2);
    target = {
      id, command: e.command, args: e.args, env: e.env, settings: e.settings,
      providerSettings: Object.fromEntries(Object.entries(e.providers).map(([k, v]) => [k, v.settings ?? {}])),
    };
  }
  if (!existsSync(target.command)) return (console.error(`keel plugin check: ${target.command} does not exist`), 2);
  const stateDir = values["state-dir"] ? resolve(values["state-dir"]) : defaultStateDir();
  const json = !!values.json;
  const c = new Check(target, stateDir, values.only ?? [], json ? (r: Row) => console.log(JSON.stringify(r)) : undefined);
  try {
    await c.run();
  } catch (e) {
    console.error(`keel plugin check: ${(e as Error).message}`);
    return 2;
  }
  const passed = c.rows.filter((r) => r.result === "pass").length;
  const failed = c.rows.filter((r) => r.result === "fail").length;
  const na = c.rows.filter((r) => r.result === "n/a").length;
  const exit = failed ? 1 : 0;
  if (json) console.log(JSON.stringify({ summary: { passed, failed, not_applicable: na, exit } }));
  else {
    const w = Math.max(7, ...c.rows.map((r) => r.fixture.length));
    console.log(`${"fixture".padEnd(w)}  result  ${"ms".padStart(6)}  detail`);
    for (const r of c.rows) console.log(`${r.fixture.padEnd(w)}  ${r.result.padEnd(6)}  ${String(r.ms).padStart(6)}  ${r.detail.replace(/[\u0000-\u001f]/g, " ")}`);
    console.log(`${passed} passed, ${failed} failed, ${na} n/a (plugin \`${target.id}\`)`);
  }
  return exit;
}

// keel plugin install|list|enable|disable|update|remove: plugins installed as
// one unit, through the daemon (src/plugins/installer.ts). What a plugin runs
// is printed line by line, and nothing of it runs before a yes to those lines.
const UNITS = `usage: keel plugin install <folder | git URL[#ref] | owner/repo> [--plugin NAME] [--yes] [--cwd DIR]
       keel plugin list [--json]
       keel plugin enable|disable|remove <id>
       keel plugin update <id> [--yes]
       keel plugin check <plugin-id> ...    (a provider plugin against protocol v1)

A marketplace is a list of plugins: name one of them with --plugin. A plugin's
hooks and MCP servers run on this machine: install prints each command and
asks before any of them runs (--yes answers for you, after you read them).`;

type PlanView = { kind: "plugin"; token: string; id: string; name: string; version: string; description?: string; input: string; root: string; fetched: string[]; bytes: number; skills: string[]; commands: string[]; agents: string[]; mcp: { name: string; label: string }[]; runs: string[]; consent: string | null; not_taken: { part: string; why: string }[]; notes: string[]; problems: string[]; update?: { from: string; changes: string[]; runs_changed: boolean; same: boolean } };
type MarketView = { kind: "marketplace"; token: string; name: string; plugins: { name: string; description?: string; version?: string; unsupported?: string }[] };

function printPlan(p: PlanView) {
  console.log(`${shown(p.id)} ${shown(p.version)}  from ${shown(p.input)}`);
  if (p.description) console.log(`  ${clean(p.description)}`);
  console.log(`  ${p.fetched.map(shown).join("; ")} (${p.bytes} bytes)`);
  const gives = [["skills", p.skills], ["commands", p.commands], ["agents", p.agents], ["MCP servers", p.mcp.map((m) => (m.label === m.name ? m.name : `${m.name} as ${m.label}`))]] as const;
  for (const [what, names] of gives) if (names.length) console.log(`  ${what}: ${names.map(shown).join(", ")}`);
  if (p.runs.length) {
    console.log("  runs on this machine (" + shown(p.root) + " is its folder):");
    for (const r of p.runs) console.log(`    ${shown(r)}`);
  } else console.log("  runs nothing on this machine");
  for (const n of p.not_taken) console.log(`  not taken: ${shown(n.part)} (${clean(n.why)})`);
  for (const n of p.notes) console.log(`  note: ${clean(n)}`);
  for (const n of p.problems) console.log(`  problem: ${clean(n)}`);
}

// A yes to the lines printed: --yes, or the answer typed at a terminal.
function agree(v: { yes?: boolean }, what: string): boolean {
  if (v.yes) return true;
  if (!process.stdin.isTTY) return false;
  const a = prompt(`${what} [y/N]`);
  return /^y(es)?$/i.test(String(a ?? "").trim());
}

async function apply(c: Client, p: PlanView, v: { yes?: boolean; json?: boolean }, word: string): Promise<number> {
  if (p.problems.length) { await c.post("/api/plugins/discard", { token: p.token }); console.error(`keel plugin: ${p.id} cannot be ${word}: ${p.problems.join("; ")}`); return EXIT.error; }
  const asks = p.runs.length > 0 && (!p.update || p.update.runs_changed);
  if (asks && !agree(v, `${word === "installed" ? "Install it" : "Update it"} and let it run the ${p.runs.length === 1 ? "line" : `${p.runs.length} lines`} above?`)) {
    await c.post("/api/plugins/discard", { token: p.token });
    console.error(process.stdin.isTTY || v.yes ? "keel plugin: not done" : `keel plugin: it runs ${p.runs.length} thing${p.runs.length === 1 ? "" : "s"} on this machine: read them above, then pass --yes`);
    return EXIT.error;
  }
  const r = await c.post<{ plugin: any }>("/api/plugins/install", { token: p.token, consent: p.consent });
  if (v.json) printJson(r.plugin);
  else console.log(`${word} ${shown(r.plugin.id)} ${shown(r.plugin.version)}`);
  return EXIT.ok;
}

const units = command("plugin", UNITS, { plugin: { type: "string" }, yes: { type: "boolean", short: "y" }, cwd: { type: "string" } }, async (v, pos, c) => {
  const [sub, arg] = pos;
  const cwd = resolve(v.cwd ?? process.cwd());
  if (sub === "list" || sub === "ls") {
    const r = await c.get<{ plugins: any[]; offers: any[] }>(`/api/plugins/installed?cwd=${encodeURIComponent(cwd)}`);
    if (v.json) return (printJson(r), EXIT.ok);
    if (!r.plugins.length) console.log("no plugins installed");
    for (const u of r.plugins) {
      const parts = [["skill", u.skills.length], ["command", u.commands.length], ["agent", u.agents.length], ["hook", u.hooks.length], ["MCP server", u.mcp.length]].filter(([, n]) => n).map(([w, n]) => `${n} ${w}${n === 1 ? "" : "s"}`);
      console.log(`${shown(u.id).padEnd(24)} ${shown(u.version).padEnd(14)} ${u.enabled ? "on " : "off"}  ${parts.join(", ") || "nothing Keel runs"}  (${shown(u.source)})`);
    }
    for (const o of r.offers.filter((x: any) => !x.installed)) console.log(`offered by ${shown(o.from)}: ${shown(o.key)}${o.problem ? ` (${clean(o.problem)})` : `: keel plugin install ${shown(o.input)} --plugin ${shown(o.plugin)}`}`);
    return EXIT.ok;
  }
  if (sub === "install") {
    if (!arg) return usageError("plugin", "name a folder, a git URL or owner/repo", UNITS);
    const p = await c.post<PlanView | MarketView>("/api/plugins/prepare", { input: arg, cwd, ...(v.plugin ? { entry: v.plugin } : {}) });
    if (p.kind === "marketplace") {
      await c.post("/api/plugins/discard", { token: p.token });
      console.log(`${shown(p.name)} is a marketplace of ${p.plugins.length} plugin${p.plugins.length === 1 ? "" : "s"}:`);
      for (const e of p.plugins) console.log(`  ${shown(e.name).padEnd(24)} ${shown(e.version ?? "").padEnd(10)} ${clean(e.unsupported ? `(not here: ${e.unsupported})` : e.description ?? "")}`);
      console.error("keel plugin: pick one with --plugin NAME");
      return EXIT.error;
    }
    printPlan(p);
    if (p.update) console.log(p.update.same ? `  already installed at ${shown(p.update.from)}` : `  installed already at ${shown(p.update.from)}: this updates it`);
    if (p.update?.same) return (await c.post("/api/plugins/discard", { token: p.token }), EXIT.ok);
    return apply(c, p, v, p.update ? "updated" : "installed");
  }
  if (sub === "update") {
    if (!arg) return usageError("plugin", "name the plugin to update", UNITS);
    const p = await c.post<PlanView>(`/api/plugins/installed/${encodeURIComponent(arg)}/update`, { cwd });
    if (p.update?.same) return (console.log(`${shown(p.id)} is at ${shown(p.update.from)}, which is what its source holds now`), EXIT.ok);
    console.log(`${shown(p.id)}: ${p.update ? `${shown(p.update.from)} to ${shown(p.version)}` : shown(p.version)}`);
    for (const l of p.update?.changes ?? []) console.log(`  ${shown(l)}`);
    printPlan(p);
    return apply(c, p, v, "updated");
  }
  if (sub === "enable" || sub === "disable") {
    if (!arg) return usageError("plugin", `name the plugin to ${sub}`, UNITS);
    const r = await c.post<{ plugin: any }>(`/api/plugins/installed/${encodeURIComponent(arg)}/enable`, { enabled: sub === "enable", cwd });
    console.log(`${shown(r.plugin.id)} ${sub === "enable" ? "is on: its skills, commands, agents, hooks and servers are back" : "is off: its hooks and servers stopped, its skills, commands and agents are hidden"}`);
    return EXIT.ok;
  }
  if (sub === "remove" || sub === "uninstall") {
    if (!arg) return usageError("plugin", "name the plugin to remove", UNITS);
    await c.del(`/api/plugins/installed/${encodeURIComponent(arg)}`);
    console.log(`removed ${shown(arg)} and everything it brought`);
    return EXIT.ok;
  }
  return usageError("plugin", sub ? `no subcommand ${sub}` : "say what to do", UNITS);
});

export const pluginCommands = {
  plugin: async (argv: string[]) => {
    if (argv[0] === "check") return check(argv.slice(1));
    return units(argv);
  },
};
