// keel safety trial: a safety rule change tried on the stored calls of the last days before it is on
// (src/safety/trial.ts). The change is a settings diff (namespaces, grants, a mode) or a patch of the rule
// modules' source; the daemon replays both sides on its read thread and nothing is changed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Rule } from "../safety/policy.ts";
import type { RuleChange, Row, TrialReport } from "../safety/trial.ts";
import { command, EXIT, printJson, usageError } from "./client.ts";

const USAGE = `keel safety trial [--days N] [CHANGE...] [--calls] [--json]
  Replays the stored tool calls of the last N days (7) under the current safety rules and under the
  rules with a change, with no model call, and says per tool and per class how many calls the change
  would allow, ask about or refuse that the current rules treated otherwise, and how many of those had
  run and succeeded. Also says how far the current rules' replay agrees with what was stored.
  Nothing is changed: Settings > Safety saves a change after its trial.

  A change (any of these, repeated as needed):
      --add-namespace NS      a namespace of yours (github.com/you, npm:@scope, pypi:name, crates:name)
      --remove-namespace NS   one of your namespaces taken away
      --grant KIND:PATTERN    a standing grant (KIND: shell, edit or tool), for every folder,
                              or KIND:PATTERN@FOLDER for one folder
      --revoke ID             a standing grant revoked (any unique prefix of its id)
      --mode MODE             every session judged in this mode
      --patch FILE            a unified diff of the rule modules (src/safety/...), applied to a copy
                              of --repo DIR (default: the Keel source checkout this folder is in)
  --calls                     list the calls that would change, with a link to each`;

function repoOf(from: string): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, "src", "safety", "trial-rules.ts"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

const pct = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
const table = (title: string, rows: Row[]) => {
  if (!rows.length) return;
  console.log(`\n${title.padEnd(36)} ${"calls".padStart(6)} ${"allow".padStart(6)} ${"ask".padStart(6)} ${"refuse".padStart(6)}  succeeded`);
  for (const r of rows) console.log(`${r.key.slice(0, 36).padEnd(36)} ${String(r.n).padStart(6)} ${String(r.allow).padStart(6)} ${String(r.ask).padStart(6)} ${String(r.refuse).padStart(6)}  ${r.succeeded} (${pct(r.share)})`);
};

export const safetyCmd = command("safety", USAGE, {
  days: { type: "string" }, "add-namespace": { type: "string", multiple: true }, "remove-namespace": { type: "string", multiple: true },
  grant: { type: "string", multiple: true }, revoke: { type: "string", multiple: true }, mode: { type: "string" },
  patch: { type: "string" }, repo: { type: "string" }, calls: { type: "boolean" },
}, async (v, pos, c) => {
  if (pos[0] !== "trial") return usageError("safety", pos[0] ? `no subcommand ${pos[0]}` : "name a subcommand: trial", USAGE);
  const days = v.days === undefined ? 7 : Number(v.days);
  if (!Number.isInteger(days) || days < 1) return usageError("safety", "--days is a whole number of days", USAGE);
  const change: RuleChange = {};
  if (v["add-namespace"]?.length || v["remove-namespace"]?.length) change.namespaces = { ...(v["add-namespace"]?.length ? { add: v["add-namespace"] } : {}), ...(v["remove-namespace"]?.length ? { remove: v["remove-namespace"] } : {}) };
  const add: NonNullable<NonNullable<RuleChange["grants"]>["add"]> = [];
  for (const g of v.grant ?? []) {
    const m = /^(shell|edit|tool):(.+?)(?:@(\/.*))?$/.exec(g);
    if (!m) return usageError("safety", `--grant ${g}: write KIND:PATTERN or KIND:PATTERN@/folder (KIND: shell, edit or tool)`, USAGE);
    add.push({ kind: m[1] as "shell" | "edit" | "tool", pattern: m[2]!, scope: m[3] ? resolve(m[3]) : "/" });
  }
  let remove: string[] = [];
  if (v.revoke?.length) {
    const { grants } = await c.get<{ grants: Rule[] }>("/api/permissions/grants");
    for (const id of v.revoke as string[]) {
      const hits = grants.filter((g) => g.id.startsWith(id));
      if (hits.length !== 1) return usageError("safety", hits.length ? `${id} names ${hits.length} grants; give more of the id` : `no grant ${id}`, USAGE);
      remove.push(hits[0]!.id);
    }
  }
  if (add.length || remove.length) change.grants = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
  if (v.mode) change.mode = v.mode;
  let patch: { patch: string; repo: string } | undefined;
  if (v.patch) {
    const repo = v.repo ? resolve(v.repo) : repoOf(process.cwd());
    if (!repo) return usageError("safety", "--patch needs --repo DIR: this folder is in no Keel source checkout", USAGE);
    patch = { patch: readFileSync(resolve(v.patch), "utf8"), repo };
  }
  const r = await c.post<TrialReport>("/api/safety/trial", { days, ...(Object.keys(change).length ? { change } : {}), ...(patch ?? {}) });
  if (v.json) return (printJson(r), EXIT.ok);
  const a = r.agreement;
  console.log(`Replayed ${r.calls} calls of the last ${r.days} days in ${(r.ms / 1000).toFixed(1)} s on the daemon's read thread.`);
  console.log(`The current rules agree with what was stored for ${a.agreed} of ${a.compared} calls (${pct(a.share)}); with the rules' own record, ${a.recorded.agreed} of ${a.recorded.compared}.`);
  for (const k of a.causes.slice(0, 8)) console.log(`  ${String(k.n).padStart(6)}  ${k.from} then, ${k.to} now: ${k.cause}`);
  const apart = Object.entries(a.before).map(([k, n]) => `${n} ${k}`);
  if (apart.length) console.log(`  Refused beside the rules, not replayed: ${apart.join(", ")}.`);
  if (!Object.keys(change).length && !patch) {
    console.log("\nNo change given: name one to see what it would change (keel safety trial --help).");
    return EXIT.ok;
  }
  const ch = r.changed;
  console.log(`\nThe change treats ${ch.n} calls otherwise: ${ch.allow} allowed, ${ch.ask} asked about, ${ch.refuse} refused. ${ch.succeeded} of them had run and succeeded (${pct(ch.share)}).`);
  table("Tool", ch.tools);
  table("Class", ch.classes);
  if (v.calls && ch.calls.length) {
    console.log("");
    for (const x of ch.calls) console.log(`${x.from.padEnd(6)} -> ${x.to.padEnd(6)}  ${x.tool.padEnd(24)} ${x.ok ? "succeeded" : "        -"}  ${c.base}${x.link}  (${x.id})`);
    if (ch.more) console.log(`and ${ch.more} more`);
  }
  return EXIT.ok;
});
