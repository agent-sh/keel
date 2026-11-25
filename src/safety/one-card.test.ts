// One call opens one card: a push that holds private words and goes beyond the owner's accounts asks him once, with
// both reasons on the card, not once for each.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings, settings } from "../admin/settings.ts";
import { Bus } from "../core/bus.ts";
import { git } from "../core/git.ts";
import { Store } from "../core/store.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { toolsFor } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import { Gate } from "./gate.ts";

const tmp = () => process.env.TMPDIR ?? tmpdir();
const namesBefore = settings().accounts?.namespaces ?? [];
beforeAll(() => { const r = patchSettings({ accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ accounts: { namespaces: namesBefore } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); };
async function repo(message: string, remote: string) {
  const dir = mkdtempSync(join(tmp(), "one-card-"));
  await sh(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "o@example.org"], ["user.name", "o"], ["commit.gpgsign", "false"]]) await sh(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "plain\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", message);
  await sh(dir, "remote", "add", "origin", remote);
  return dir;
}
const bash = toolsFor("claude").find((t) => t.name === "Bash") as Tool;

// The cards a call opens, each allowed once as it opens, until the call is settled.
async function cards(dir: string, command: string) {
  const store = new Store(mkdtempSync(join(tmp(), "one-card-gate-")));
  const g = new Gate(store, new Bus(), () => false);
  g.publicSend = { visibility: async () => "public", words: async () => ({ words: { terms: ["buildbox"], projects: [], homes: [], sentences: [] }, folders: new Map() }) };
  const s = store.createSession({ model: "m", workspace: dir });
  g.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
  const call: ToolCall = { id: crypto.randomUUID(), tool: bash, input: { command }, ctx: { sessionId: s.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() } };
  const out = g.check(store.session(s.id)!, call);
  let done = false;
  out.then(() => { done = true; }, () => { done = true; });
  const seen: string[] = [];
  for (let i = 0; i < 400 && !done; i++) {
    const [card] = g.approvals({ session: s.id, pending: true });
    if (card) { seen.push(card.why ?? ""); g.resolve(card.id, s.id, { choice: "once", seen: "whole" }); }
    await Bun.sleep(10);
  }
  const r = await out;
  return { seen, ran: !("deny" in r) };
}

test("a push that holds private words and goes beyond the owner's accounts opens one card that says both", async () => {
  const dir = await repo("Deploy from buildbox", "git@github.com:others/open.git");
  const r = await cards(dir, "git push origin main");
  expect(r.seen.length).toBe(1);
  expect(r.seen[0]).toContain("a private host name or word (buildbox)");
  expect(r.seen[0]).toContain("github.com/others/open, which is not one of your namespaces");
  expect(r.ran).toBe(true);
});

test("each reason alone still asks: private words to his own repository, a clean push beyond his accounts", async () => {
  const own = await cards(await repo("Deploy from buildbox", "git@github.com:acme/open.git"), "git push origin main");
  expect(own.seen.length).toBe(1);
  expect(own.seen[0]).toContain("buildbox");
  expect(own.seen[0]).not.toContain("namespaces");
  const clean = await cards(await repo("Fix", "git@github.com:others/open.git"), "git push origin main");
  expect(clean.seen.length).toBe(1);
  expect(clean.seen[0]).toContain("not one of your namespaces");
  expect(clean.seen[0]).not.toContain("private");
});
