// keel safety trial: a safety rule change tried on the stored calls of the last days before it is on
// (src/safety/trial.ts). A settings diff (namespaces, grants, a mode) is replayed by the daemon on its read
// thread. A patch of the rule modules' source is a developer's trial: it runs here, in this command's own process,
// with the rules loaded from two copies of the Keel checkout this command is run in (as it is, and patched), over
// a read-only connection to the daemon's store. The daemon never loads the patch's code. Nothing is changed.
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git } from "../core/git.ts";
import { storePath } from "../core/store-files.ts";
import type { Rule } from "../safety/policy.ts";
import type { RuleChange, Row, TrialReport } from "../safety/trial.ts";
import type { Rules, TrialAsk } from "../safety/trial-read.ts";
import { command, EXIT, printJson, usageError, type Client } from "./client.ts";

const USAGE = `keel safety trial [--days N] [CHANGE...] [--calls] [--json]
  Replays the stored tool calls of the last N days (7) under the current safety rules and under the
  rules with a change, with no model call, and says per tool and per class how many calls the change
  would allow, ask about or refuse that the current rules treated otherwise, and how many of those had
  run and succeeded. Also says how far the current rules' replay agrees with what was stored.
  The daemon tries up to 7 days, within a time budget: a trial it stops says how far it came.
  Nothing is changed: Settings > Safety saves a change after its trial.

  A change (any of these, repeated as needed):
      --add-namespace NS      a namespace of yours (github.com/you, npm:@scope, pypi:name, crates:name)
      --remove-namespace NS   one of your namespaces taken away
      --grant KIND:PATTERN    a standing grant (KIND: shell, edit or tool), for every folder,
                              or KIND:PATTERN@FOLDER for one folder
      --revoke ID             a standing grant revoked (any unique prefix of its id)
      --mode MODE             every session judged in this mode
      --patch FILE            a unified diff of the rule modules (src/safety/...), applied to a copy of
                              a Keel source checkout. Run from that checkout or one of its subfolders,
                              or pass --repo. The installed binary's location does not matter.
                              Requires git and the daemon's store on this machine. Only use trusted patches:
                              this command loads the patched code in its own process, not the daemon's.
      --repo DIR              with --patch, name the root of the Keel source checkout explicitly
  --calls                     list the calls that would change, with a link to each`;

const trialSource = (d: string) => join(d, "src", "safety", "trial-rules.ts");
function repoOf(from: string): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(trialSource(d))) return d;
    if (dirname(d) === d) return undefined;
  }
}

// The trial of a patch, here: the checkout's source copied twice, the patch applied to one copy, each copy's
// rules loaded, and the stored calls replayed over a read-only connection with the daemon's facts.
async function patchTrial(c: Client, repo: string, patch: string, days: number, change?: RuleChange): Promise<TrialReport | string> {
  const facts = await c.get<Omit<TrialAsk, "days" | "change">>("/api/safety/trial/facts");
  const dbPath = storePath(facts.state);
  if (!existsSync(dbPath)) return `the daemon's store ${dbPath} is not on this machine: a patch is tried where the daemon runs`;
  const dir = mkdtempSync(join(tmpdir(), "keel-trial-"));
  try {
    for (const side of ["base", "cand"]) {
      cpSync(join(repo, "src"), join(dir, side, "src"), { recursive: true });
      if (existsSync(join(repo, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(dir, side, "node_modules"));
    }
    writeFileSync(join(dir, "change.patch"), patch);
    // (The copy is no repository: git looks for none above it, so the paths are the patch's own, and no repository's
    // config is in force: "plain", through the one helper that runs git.)
    const p = await git(join(dir, "cand"), ["apply", "--whitespace=nowarn", join(dir, "change.patch")], { mode: "plain", env: { GIT_CEILING_DIRECTORIES: dir }, timeout: 60_000 });
    if (p.code !== 0) return `the patch does not apply to ${repo}: ${p.err.trim().slice(0, 400)}`;
    const base: Rules = await import(trialSource(join(dir, "base")));
    const cand: Rules = await import(trialSource(join(dir, "cand")));
    const { trialRead } = await import("../safety/trial-read.ts");
    const db = new Database(dbPath, { readonly: true });
    try {
      return await trialRead(db, { days, ...(change ? { change } : {}), ...facts }, { rules: { base, cand } });
    } finally { db.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
  if (v.repo !== undefined && !v.patch) return usageError("safety", "--repo requires --patch", USAGE);
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
  const some = Object.keys(change).length ? change : undefined;
  let r: TrialReport;
  if (v.patch) {
    const cwd = process.cwd();
    const repo = v.repo === undefined ? repoOf(cwd) : resolve(v.repo);
    if (!repo) return usageError("safety", `no Keel source checkout above ${cwd}; change directory or pass --repo DIR`, USAGE);
    if (!existsSync(trialSource(repo))) return usageError("safety", `--repo ${repo} does not contain src/safety/trial-rules.ts`, USAGE);
    const got = await patchTrial(c, repo, readFileSync(resolve(v.patch), "utf8"), days, some);
    if (typeof got === "string") { console.error(`keel safety: ${got}`); return EXIT.error; }
    r = got;
  } else {
    r = await c.post<TrialReport>("/api/safety/trial", { days, ...(some ? { change: some } : {}) });
  }
  if (v.json) return (printJson(r), EXIT.ok);
  const a = r.agreement;
  console.log(`Replayed ${r.calls} calls of the last ${r.days} days in ${(r.ms / 1000).toFixed(1)} s ${v.patch ? "in this process" : "on the daemon's read thread"}.`);
  if (r.partial) console.log(`Stopped at its ${Math.round(r.partial.budgetMs / 1000)} s budget after ${r.partial.sessions} of ${r.partial.of} sessions, the newest first: every count below is of those.`);
  console.log(`The current rules agree with what was stored for ${a.agreed} of ${a.compared} calls (${pct(a.share)}); with the rules' own record, ${a.recorded.agreed} of ${a.recorded.compared}.`);
  for (const k of a.causes.slice(0, 8)) console.log(`  ${String(k.n).padStart(6)}  ${k.from} then, ${k.to} now: ${k.cause}`);
  const apart = Object.entries(a.before).map(([k, n]) => `${n} ${k}`);
  if (apart.length) console.log(`  Refused beside the rules, not replayed: ${apart.join(", ")}.`);
  if (!some && !v.patch) {
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
