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

export const pluginCommands = {
  plugin: async (argv: string[]) => {
    if (argv[0] === "check") return check(argv.slice(1));
    console.error(USAGE);
    return 2;
  },
};
