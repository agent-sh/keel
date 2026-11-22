// keel rules [list] | rm ID | check SAMPLE: the owner's standing permission
// rules (what an approval's "always" or "this session" granted) from a
// terminal, and how the gate would judge a command, a file edit or a tool in
// a folder under them. The judgment runs the gate's own pure decision
// (src/safety/policy.ts) on the daemon's rules for that folder.
import { resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { decide, isMode, MODES, type Rule } from "../safety/policy.ts";
import { ago, command, EXIT, line, printJson, usageError } from "./client.ts";

const USAGE = `keel rules [list] [--cwd DIR] [--json]
keel rules rm ID
keel rules check SAMPLE [--tool shell|edit|tool] [--mode MODE] [--cwd DIR] [--json]
  The standing permission rules the owner granted, newest last.

  list            every rule, or with --cwd those that hold in that folder
  rm ID           revoke a rule (any unique prefix of its id)
  check SAMPLE    how a call would be judged in --cwd (default: here):
                  --tool shell (default) SAMPLE is a command line,
                  --tool edit SAMPLE is a file path, --tool tool SAMPLE is a tool name
      --mode MODE the permission mode to judge in (default: the daemon's default):
                  ${MODES.map((m) => m.id).join(", ")}
      --session   include rules granted for one session only (judged as if in it)`;

// The rules that hold for a session in `cwd`: every "always" rule whose scope
// holds the folder (the gate scopes a rule to the repository root).
export const rulesIn = (all: Rule[], cwd: string, session?: string) =>
  all.filter((r) => (r.lifetime === "session" ? !!session && r.session_id === session : contains(r.scope, cwd)));

export const rulesCmd = command("rules", USAGE, {
  cwd: { type: "string" }, tool: { type: "string" }, mode: { type: "string" }, session: { type: "string" },
}, async (v, pos, c) => {
  const [sub = "list", ...rest] = pos;
  const { grants } = await c.get<{ grants: Rule[] }>("/api/permissions/grants");
  const cwd = resolve(v.cwd ?? process.cwd());
  if (sub === "rm") {
    const id = rest[0];
    if (!id) return usageError("rules", "rm needs a rule id", USAGE);
    const hits = grants.filter((g) => g.id.startsWith(id));
    if (hits.length !== 1) return usageError("rules", hits.length ? `${id} names ${hits.length} rules; give more of the id` : `no rule ${id}`, USAGE);
    await c.del(`/api/permissions/grants/${hits[0]!.id}`);
    console.log(`revoked ${hits[0]!.kind} ${hits[0]!.pattern}`);
    return EXIT.ok;
  }
  if (sub === "list") {
    const list = v.cwd ? rulesIn(grants, cwd, v.session) : grants;
    if (v.json) return (printJson(list), EXIT.ok);
    if (!list.length) return (console.error(v.cwd ? `no rules hold in ${cwd}` : "no standing rules"), EXIT.ok);
    for (const r of list) console.log(`${r.id.slice(0, 8)}  ${ago(r.created).padStart(4)}  ${r.kind.padEnd(5)}  ${r.lifetime === "session" ? "session" : "always "}  ${line(r.pattern)}  ${r.lifetime === "session" ? `(session ${r.session_id?.slice(0, 8)})` : r.scope}`);
    return EXIT.ok;
  }
  if (sub === "check") {
    const sample = rest.join(" ").trim();
    if (!sample) return usageError("rules", "check needs a sample: a command line, a path or a tool name", USAGE);
    const tool = v.tool ?? "shell";
    if (!["shell", "edit", "tool"].includes(tool)) return usageError("rules", "--tool is shell, edit or tool", USAGE);
    const mode = v.mode ?? (await c.get<{ default_mode: string }>("/api/permissions/settings")).default_mode;
    if (!isMode(mode)) return usageError("rules", `--mode is one of ${MODES.map((m) => m.id).join(", ")}`, USAGE);
    const rules = rulesIn(grants, cwd, v.session);
    const cls = tool === "shell" ? { kind: "shell" as const, command: sample } : tool === "edit" ? { kind: "edit" as const, paths: [resolve(cwd, sample)] } : { kind: "other" as const };
    const d = decide(cls, { mode, workspace: cwd, sandboxed: false, rules, tool: tool === "tool" ? sample : tool === "shell" ? "shell" : "edit" });
    const verdict = "allow" in d ? "allow" : "deny" in d ? "deny" : "ask";
    if (v.json) return (printJson({ sample, tool, mode, cwd, decision: verdict, detail: d, rules: rules.length }), EXIT.ok);
    const why = "allow" in d ? d.why : "deny" in d ? d.deny : d.ask.why;
    console.log(`${verdict}${"ask" in d ? ` (${d.ask.risk} risk${d.ask.rule ? `: ${d.ask.rule}` : ""})` : ""}: ${tool} ${line(sample)} in ${cwd}, mode ${mode}, ${rules.length} rule${rules.length === 1 ? "" : "s"} in scope`);
    if (why) console.log(`  ${why}`);
    if ("ask" in d && d.ask.suggest.length) console.log(`  an "always" would grant: ${d.ask.suggest.map((s) => `${s.kind} ${s.pattern}`).join(", ")}`);
    return EXIT.ok;
  }
  return usageError("rules", `unknown subcommand ${sub}`, USAGE);
});
