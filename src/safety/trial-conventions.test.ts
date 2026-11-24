// A rule module exposes the pure function a trial's replay calls (src/safety/trial-rules.ts RULE_MODULES), and the
// replay reaches every rule module through it and nothing of the daemon: a trial of a patch loads trial-rules.ts
// from a patched copy of the source, so a rule the replay reached some other way would be tried as it is now.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { RULE_MODULES } from "./trial-rules.ts";

const SRC = resolve(import.meta.dir, "..");
// What holds the daemon's state or runs it: a replay that reached one would read live state instead of its input.
const DAEMON = [/^core\/store\.ts$/, /^core\/bus\.ts$/, /^safety\/gate\.ts$/, /^engine\/turn\.ts$/, /^server\//, /^admin\/settings\.ts$/, /^safety\/account-settings\.ts$/, /^safety\/content-routes\.ts$/];

// The files a module imports, by their static imports (type-only ones carry no code and are left out).
function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm)) {
      const to = resolve(dirname(file), m[1]!);
      if (existsSync(to)) walk(to);
    }
  };
  walk(entry);
  return seen;
}

describe("the rule modules a trial replays", () => {
  const reached = graph(join(SRC, "safety", "trial-rules.ts"));
  const rel = [...reached].map((f) => relative(SRC, f));

  test("the replay reaches nothing of the daemon", () => {
    expect(rel.filter((f) => DAEMON.some((d) => d.test(f)))).toEqual([]);
  });

  test("each rule module is reached by the replay and exposes its pure function", async () => {
    for (const m of RULE_MODULES) {
      const file = join(SRC, "safety", m.file);
      expect(reached.has(file), `${m.file} is not reached from trial-rules.ts`).toBe(true);
      const mod = await import(file);
      expect(typeof mod[m.fn], `${m.file} exports no function ${m.fn}`).toBe("function");
    }
  });

  test("every rule module of the policy is listed", () => {
    // What decide reaches in src/safety is a rule the replay runs: each such module that holds a rule is named in
    // RULE_MODULES (a helper with no rule of its own, such as looked.ts or risk-reach.ts, is reached through them).
    const policy = [...graph(join(SRC, "safety", "policy.ts"))].map((f) => relative(join(SRC, "safety"), f)).filter((f) => !f.startsWith(".."));
    const listed = new Set(RULE_MODULES.map((m) => m.file));
    const helpers = new Set(["looked.ts", "risk-reach.ts", "closed-code.ts", "shell-reads.ts", "secrets.ts", "addresses.ts", "own-places.ts", "chars.ts",
      // shared-branches.ts takes from ref-guard.ts only the name of the file its git notes made branches in (PAD), and
      // ref-guard.ts reaches the sandbox's view and scope for the folders it offers the sandbox: no decision of a call
      // is made in any of the three, so the replay has nothing of them to run.
      // env-secret.ts is the sandbox view's rule of which variable names and values hold a secret: it hides them from a
      // command's environment and decides no call.
      // unstarted.ts reads a line for the acts a turn nobody started may not do; the replay has no record of who started
      // the turn (the gate asks the engine), so it runs none of it and counts such refusals apart (trial.ts, BEFORE).
      "ref-guard.ts", "sandbox-view.ts", "sandbox-scope.ts", "env-secret.ts", "unstarted.ts"]);
    expect(policy.filter((f) => !listed.has(f) && !helpers.has(f))).toEqual([]);
  });

  test("the replay is the same function of the same input", async () => {
    const { replayCall } = await import("./trial-rules.ts");
    const s = { id: "s", workspace: "/w", scope: { workspace: "/w", scratch: [] }, agent: false, machine: true, mode: "ask" as const, sandboxed: false, folders: new Map() };
    const c = { home: "/h", state: "/st", config: ["/cfg"], bins: () => [], tools: new Map([["Bash", { name: "Bash", readOnly: false, kind: "shell" as const, props: ["command"] }]]), mcp: [], runCode: "run_code", mcpCall: "mcp_call" };
    const u = { id: "c1", name: "Bash", input: { command: "rm -rf build && git push origin main" } };
    const a = replayCall(u, s, c, { mode: "ask", namespaces: [], rules: [] });
    const b = replayCall(u, s, c, { mode: "ask", namespaces: [], rules: [] });
    expect(a).toEqual(b);
    expect(a.judged.outcome).toBe("ask");
  });
});
