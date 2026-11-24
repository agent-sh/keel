// Two sessions run the named check at the same time, and a provider gave their calls the same id (ids are
// only the session's own: the scripted provider numbers its calls by position). Each run is recorded on its own tree.
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import type { Job } from "../tools/jobs.ts";
import { bindLedger, ofTree, unbindLedger } from "./ledger.ts";
import { afterCall, beforeCall, jobDone } from "./runs.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `runs-concurrent-${process.pid}`);
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
ownEnv({ GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
afterAll(() => { unbindLedger(); rmSync(root, { recursive: true, force: true }); });

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const repoOf = (name: string) => {
  const repo = join(root, name);
  mkdirSync(join(repo, ".keel"), { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "check.sh"), "true\n");
  writeFileSync(join(repo, "notes.md"), `${name}\n`);
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" } }));
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", name);
  return { repo, tree: g(repo, "rev-parse", "HEAD^{tree}") };
};

test("two calls with one id in two sessions each leave their own run", async () => {
  bindLedger(new Store(join(root, "state")));
  const a = repoOf("alpha"), b = repoOf("beta");
  const call = (cwd: string) => ({ id: "call-3-1", tool: { kind: "shell" }, input: { command: "sh check.sh" }, ctx: { cwd } }) as any;
  const job = (sessionId: string, cwd: string): Job => ({ id: sessionId, num: 1, sessionId, command: "sh check.sh", cwd, pty: false, log: join(root, "none.log"), started: 1, ended: 2, exitCode: 0, background: false, callId: "call-3-1" }) as Job;
  // Both calls are on their way before either ends.
  await beforeCall({ id: "session-a" } as any, call(a.repo));
  await beforeCall({ id: "session-b" } as any, call(b.repo));
  jobDone(job("session-a", a.repo));
  jobDone(job("session-b", b.repo));
  await afterCall({ id: "session-a" } as any, call(a.repo), { content: "" } as any);
  await afterCall({ id: "session-b" } as any, call(b.repo), { content: "" } as any);
  expect(ofTree(a.tree).map((r) => [r.session_id, r.result])).toEqual([["session-a", "pass"]]);
  expect(ofTree(b.tree).map((r) => [r.session_id, r.result])).toEqual([["session-b", "pass"]]);
});
