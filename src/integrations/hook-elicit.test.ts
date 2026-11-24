// Who may answer a server's question through a hook: only the hooks file the owner wrote may answer for him; a
// repository's, a plugin's or a skill's hook may only refuse. What the owner typed goes to the owner's file alone.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { Hooks, projectRoot } from "./hooks.ts";

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const scratch = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });

const dir = scratch("keel-hk-elicit-");
const ownerFile = join(dir, "owner-hooks.json");
ownEnv({ KEEL_HOOKS: ownerFile });
const repo = join(dir, "repo");
mkdirSync(join(repo, ".keel"), { recursive: true });
git(repo, "init", "-q");

// A hook that keeps what it is sent in `<name>.in` and prints what `<name>.say` holds (nothing when the file is absent).
const hook = (name: string) => ({ type: "command", command: `cat > ${dir}/${name}.in; if [ -e ${dir}/${name}.say ]; then cat ${dir}/${name}.say; fi` });
const say = (name: string, action: string, content?: unknown) =>
  writeFileSync(join(dir, `${name}.say`), JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", action, ...(content ? { content } : {}) } }));
const sent = (name: string) => (existsSync(join(dir, `${name}.in`)) ? JSON.parse(readFileSync(join(dir, `${name}.in`), "utf8")) : undefined);
const reset = () => { for (const n of ["own", "proj"]) { rmSync(join(dir, `${n}.say`), { force: true }); rmSync(join(dir, `${n}.in`), { force: true }); } };

const hooks = new Hooks(new Store(scratch("keel-hk-elicit-state-")));
const events = { Elicitation: [{ hooks: [hook("own")] }], ElicitationResult: [{ hooks: [hook("own")] }] };
writeFileSync(ownerFile, JSON.stringify({ hooks: events }));
writeFileSync(join(repo, ".keel/hooks.json"), JSON.stringify({ hooks: { Elicitation: [{ hooks: [hook("proj")] }], ElicitationResult: [{ hooks: [hook("proj")] }] } }));
expect(hooks.pin(repo, hooks.sources(repo).find((s) => s.scope === "project")!.sha256)).toBeNull();
const session = { id: "s", workspace: projectRoot(repo), model: "x:y" } as any;
const run = (event: "Elicitation" | "ElicitationResult", opts?: Parameters<Hooks["run"]>[5]) => hooks.run(event, session, { mcp_server_name: "srv", action: "accept" }, ["srv"], undefined, opts);

test("a repository's hook cannot accept for the owner, but can decline", async () => {
  reset();
  say("proj", "accept", { color: "red" });
  expect((await run("Elicitation")).elicit).toBeUndefined();
  say("proj", "decline");
  expect((await run("Elicitation")).elicit).toEqual({ action: "decline" });
  // Between hooks the answer that asks least of the owner wins: the owner's accept does not outrank a decline.
  say("own", "accept", { color: "blue" });
  expect((await run("Elicitation")).elicit).toEqual({ action: "decline" });
  // The owner's own file may accept.
  rmSync(join(dir, "proj.say"));
  expect((await run("Elicitation")).elicit).toEqual({ action: "accept", content: { color: "blue" } });
});

test("what the owner typed goes to the owner's file alone, and not at all for a secret form", async () => {
  reset();
  await run("ElicitationResult", { ownerOnly: { content: { color: "red" } } });
  expect(sent("own")).toMatchObject({ action: "accept", content: { color: "red" } });
  expect(sent("proj")).toBeDefined();
  expect(sent("proj").content).toBeUndefined();
  expect(JSON.stringify(sent("proj"))).not.toContain("red");
});

test("a hook ends with the turn that asked", async () => {
  const slow = join(dir, "slow.pid");
  writeFileSync(ownerFile, JSON.stringify({ hooks: { Elicitation: [{ hooks: [{ type: "command", command: `echo $$ > ${slow}; exec sleep 30` }] }] } }));
  const ac = new AbortController();
  const t0 = Date.now();
  const p = run("Elicitation", { signal: ac.signal });
  await Bun.sleep(300);
  ac.abort();
  const r = await p;
  expect(Date.now() - t0).toBeLessThan(5_000);
  expect(r.elicit).toBeUndefined();
  const pid = Number(readFileSync(slow, "utf8"));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
  writeFileSync(ownerFile, JSON.stringify({ hooks: events }));
});
