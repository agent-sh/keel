// A push by hand to the base of a repository that lands through its queue goes back once with the queue call to make
// (land-push.ts, the gate's landBack); a turn nobody started is refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings, settings } from "../admin/settings.ts";
import { Bus } from "../core/bus.ts";
import { git } from "../core/git.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { toolsFor } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import { Gate } from "./gate.ts";
import { movesBase, pushesOf } from "./land-push.ts";

test("the pushes of a line: the folder each runs in, its refspecs, and whether it pushes every branch", () => {
  const rows: [string, ReturnType<typeof pushesOf>][] = [
    ["git push -q origin abc:main 2>&1 | tail -1", [{ dir: "/w", specs: ["abc:main"], all: false }]],
    ["cd /r/wt && git push origin HEAD:main", [{ dir: "/r/wt", specs: ["HEAD:main"], all: false }]],
    ["cd ~/r; git fetch -q; git push origin main", [{ dir: "/home/u/r", specs: ["main"], all: false }]],
    ["git -C ~/r push --all origin", [{ dir: "/home/u/r", specs: [], all: true }]],
    ['S=/x; cd $S/wt && git push -o ci.skip origin "$H:main"', [{ dir: null, specs: ["$H:main"], all: false }]],
    ["git push", [{ dir: "/w", specs: [], all: false }]],
    ["git fetch origin main && git log -1", []],
    ["cat > t.sh <<'EOF'\ngit push origin x:main\nEOF", []],
  ];
  for (const [command, want] of rows) expect([command, pushesOf(command, "/w", "/home/u")]).toEqual([command, want]);
});

test("a refspec moves the base when its destination is the base: by name, by ref, or HEAD with the base out", () => {
  const rows: [string, string | null, boolean][] = [
    ["abc123:main", null, true],
    ["+abc123:refs/heads/main", null, true],
    ["main", null, true],
    ["HEAD:main", "feat", true],
    ["HEAD", "main", true],
    ["HEAD", "feat", false],
    ["feat", null, false],
    ["main:feat", null, false],
    [":main", null, false],
    ["$H:main", null, true],
    ["abc:$B", null, false],
  ];
  for (const [spec, current, want] of rows) expect([spec, movesBase(spec, "main", current)]).toEqual([spec, want]);
});

// ---- the gate ----

const tmp = () => process.env.TMPDIR ?? tmpdir();
const namesBefore = settings().accounts?.namespaces ?? [];
beforeAll(() => { const r = patchSettings({ accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ accounts: { namespaces: namesBefore } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); return r.out.trim(); };
// A repository of the owner's namespace on main, with a branch `feat` one commit ahead; `land`: its checks name a land block.
async function repo(land: boolean) {
  const dir = mkdtempSync(join(tmp(), "land-push-"));
  await sh(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "o@example.org"], ["user.name", "o"], ["commit.gpgsign", "false"]]) await sh(dir, "config", k!, v!);
  mkdirSync(join(dir, ".keel"));
  writeFileSync(join(dir, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "bun test" } }, ...(land ? { land: { checks: ["unit"], push: "origin" } } : {}) }));
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "Start");
  await sh(dir, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, "b.txt"), "more\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "Add b");
  const feat = await sh(dir, "rev-parse", "HEAD");
  await sh(dir, "checkout", "-q", "main");
  await sh(dir, "remote", "add", "origin", "git@github.com:acme/open.git");
  return { dir, feat };
}
const bash = toolsFor("claude").find((t) => t.name === "Bash") as Tool;
const rig = (owner = true) => {
  const store = new Store(mkdtempSync(join(tmp(), "land-push-gate-")));
  const g = new Gate(store, new Bus(), () => false);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  g.publicSend = { visibility: async () => "public", words: async () => ({ words: { terms: [], projects: [], homes: [], sentences: [] }, folders: new Map() }) };
  g.byOwner = () => owner;
  const session = (dir: string, parent?: string): Session => {
    const s = store.createSession({ model: "m", workspace: dir });
    if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
    g.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
    return store.session(s.id)!;
  };
  const decide = async (s: Session, command: string) => {
    const call: ToolCall = { id: crypto.randomUUID(), tool: bash, input: { command }, ctx: { sessionId: s.id, cwd: s.workspace, signal: new AbortController().signal, spillDir: s.workspace, seen: new Map() } };
    const out = g.check(s, call);
    let done = false;
    out.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 200 && !done && !g.approvals({ session: s.id, pending: true }).length; i++) await Bun.sleep(15);
    if (done) { const r = await out; return "deny" in r ? { is: "refused" as const, text: r.deny } : { is: "ran" as const, text: "" }; }
    const [card] = g.approvals({ session: s.id, pending: true });
    if (card) g.resolve(card.id, s.id, { choice: "once", seen: "whole" });
    await out;
    return { is: "card" as const, text: card?.why ?? "" };
  };
  return { session, decide };
};

test("gate: a hand push to the base of a repository with a land block goes back once with the queue call; the same line again is judged as it is", async () => {
  const { dir, feat } = await repo(true);
  const { session, decide } = rig();
  const s = session(dir);
  const line = `git push -q origin ${feat}:main 2>&1 | tail -1`;
  const first = await decide(s, line);
  expect(first.is).toBe("refused");
  expect(first.text).toContain('keel__landing_queue with action "queue" and branches ["feat"]');
  expect(first.text).toContain("Nothing was run");
  expect((await decide(s, line)).is).toBe("ran");
  // Another hand landing is its own line; a branch name in place of the commit is read the same way.
  const named = await decide(s, "git push origin feat:main");
  expect(named.is).toBe("refused");
  expect(named.text).toContain('["feat"]');
  // A push of anything but the base, and of the commit the base already is here, are no landing.
  expect((await decide(s, "git push origin feat")).is).toBe("ran");
  expect((await decide(s, "git push origin main")).is).toBe("ran");
  // A folder spelled with a variable: the queue first, then written out; its HEAD is not taken for the session's own.
  const vague = `D=${dir}; cd "$D" && git push -q origin HEAD:main`;
  expect((await decide(s, vague)).text).toContain("keel__landing_queue");
  expect((await decide(s, vague)).text).toContain("written out");
});

test("gate: a repository with no land block is pushed as before", async () => {
  const { dir, feat } = await repo(false);
  const { session, decide } = rig();
  expect((await decide(session(dir), `git push -q origin ${feat}:main`)).is).toBe("ran");
});

test("gate: a turn nobody started is refused its hand landing every time; an agent is told to report the branch", async () => {
  const { dir, feat } = await repo(true);
  const unattended = rig(false);
  const s = unattended.session(dir);
  for (let i = 0; i < 2; i++) {
    const r = await unattended.decide(s, `git push -q origin ${feat}:main`);
    expect([i, r.is]).toEqual([i, "refused"]);
    expect(r.text).toContain("No message of the owner's is in this turn");
  }
  const attended = rig();
  const agent = attended.session(dir, attended.session(dir).id);
  const r = await attended.decide(agent, `git push -q origin ${feat}:main`);
  expect(r.is).toBe("refused");
  expect(r.text).toContain("An agent does not land");
});
