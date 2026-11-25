// A push or a gh write spelled with a variable goes back to the model once to be written out, in the place of the
// owner's card (written-out.ts): the words found, and the gate over real repositories.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { Gate, WRITE_OUT_MAX } from "./gate.ts";
import type { Mode } from "./policy.ts";
import { unwritten } from "./written-out.ts";

const words = (command: string) => unwritten(command, "/w", "/home/u").map((x) => `${x.what} ${x.word}`);

test("the words of a send an expansion makes are found: the folder, the remote, what it pushes, a gh repository or address", () => {
  const rows: [string, string[]][] = [
    ['D=/w/own; cd "$D" && git push origin main', ["folder $D"]],
    ["S=$HOME/scr; cd $S/wt && git push -q origin abc:main 2>&1 | tail -2", ["folder $S/wt"]],
    ['git -C "$D" push', ["folder $D"]],
    ["git --git-dir=$D/.git push", ["folder $D/.git"]],
    ["cd $X; git -C /w/own push", ["folder $X"]],
    ["git push $REMOTE main", ["remote $REMOTE"]],
    ["H=$(git rev-parse x); git push -q origin $H:main", ["source $H:main"]],
    ['git push origin "$B"', ["source $B"]],
    ["cd $S/wt && git push origin $H:main", ["folder $S/wt", "source $H:main"]],
    ['gh pr comment 5 -R "$REPO" -b hi', ["repository $REPO"]],
    ["gh api -X POST repos/$O/$R/issues -f title=x", ["address repos/$O/$R/issues"]],
    ['cd "$(git rev-parse --show-toplevel)" && gh pr create --fill', ["folder $(...)"]],
  ];
  for (const [command, want] of rows) expect([command, words(command)]).toEqual([command, want]);
});

test("a line written out has none, and neither has one whose variables are not in what places the send", () => {
  for (const command of [
    "cd /w/own && git push origin main",
    "git -C ~/own push -q origin abc123:main",
    'git commit -m "$MSG" && git push origin main',
    "git push -o ci.skip=$X origin main",
    "cd $X && git status",
    "cd $X; cd /w/own && git push",
    "echo '$D'; git push origin 'a$b'",
    "git fetch $REMOTE main",
    "gh pr view $N",
    'gh pr comment 5 -b "$BODY"',
  ]) expect([command, words(command)]).toEqual([command, []]);
});

// ---- the gate ----

const tmp = () => process.env.TMPDIR ?? tmpdir();
const namesBefore = settings().accounts?.namespaces ?? [], termsBefore = settings().private?.terms ?? [];
beforeAll(() => { const r = patchSettings({ private: { terms: ["buildbox"] }, accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ private: { terms: termsBefore }, accounts: { namespaces: namesBefore } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); return r.out.trim(); };
// The owner's own repository (its remote is in his namespaces): a clean commit on main, and another branch whose commit
// names a private host.
async function repo() {
  const dir = mkdtempSync(join(tmp(), "written-out-"));
  await sh(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "o@example.org"], ["user.name", "o"], ["commit.gpgsign", "false"]]) await sh(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "plain\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "Fix");
  const clean = await sh(dir, "rev-parse", "HEAD");
  await sh(dir, "checkout", "-q", "-b", "other");
  writeFileSync(join(dir, "b.txt"), "more\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "Deploy from buildbox");
  await sh(dir, "checkout", "-q", "main");
  await sh(dir, "remote", "add", "origin", "git@github.com:acme/open.git");
  return { dir, clean };
}
const bash = toolsFor("claude").find((t) => t.name === "Bash") as Tool;
const rig = (mode: Mode) => {
  const store = new Store(mkdtempSync(join(tmp(), "written-out-gate-")));
  const g = new Gate(store, new Bus(), () => false);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  g.publicSend = { visibility: async () => "public", words: async () => ({ words: { terms: ["buildbox"], projects: [], homes: [], sentences: [] }, folders: new Map() }) };
  const session = (dir: string): Session => { const s = store.createSession({ model: "m", workspace: dir }); g.setPerm(s.id, { mode, sandbox: "off" }); return store.session(s.id)!; };
  // What a call is decided as: "ran", "refused" (with the words), or "card" (with the card's reason; it is then allowed).
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
  return { g, session, decide };
};

test("gate: a push behind a folder spelled with a variable goes back to be written out; written out, the owner's own repository runs with no card", async () => {
  for (const mode of ["full-auto", "ask"] as const) {
    const { dir } = await repo();
    const { session, decide } = rig(mode);
    const s = session(dir);
    const vague = `D=${dir}; cd "$D" && git push origin main`;
    const first = await decide(s, vague);
    expect([mode, first.is]).toEqual([mode, "refused"]);
    expect(first.text).toContain("the folder ($D)");
    expect(first.text).toContain("written out");
    // Written out: placed in his namespace. Full auto runs it; Ask asks as it asks for any command, not for an account.
    const exact = await decide(s, `cd ${dir} && git push origin main`);
    expect([mode, exact.is]).toEqual([mode, mode === "full-auto" ? "ran" : "card"]);
    expect(exact.text).not.toContain("accounts");
    // The same line again is judged as it is: the owner's card, as before.
    const again = await decide(s, vague);
    expect([mode, again.is]).toEqual([mode, "card"]);
    expect(again.text).toContain("the folder it runs in is not known");
  }
});

test("gate: a push whose source is a variable is not read as every branch for the owner: it goes back, and the commit written out is read alone", async () => {
  const { dir, clean } = await repo();
  const { session, decide } = rig("full-auto");
  const s = session(dir);
  const first = await decide(s, "H=$(git rev-parse main); git push -q origin $H:main");
  expect(first.is).toBe("refused");
  expect(first.text).toContain("what it pushes ($H:main)");
  expect(first.text).not.toContain("buildbox");
  // The commit by its hash: only what it sends is read, and it holds nothing private.
  expect((await decide(s, `git push -q origin ${clean}:main`)).is).toBe("ran");
  // What holds a private word still asks, written out or not.
  const held = await decide(s, "git push -q origin other");
  expect(held.is).toBe("card");
  expect(held.text).toContain("a private host name or word (buildbox)");
});

test("gate: a model that keeps its variables reaches the owner's card: the lines of one turn sent back are bounded, and a new turn starts over", async () => {
  const { dir } = await repo();
  const { g, session, decide } = rig("full-auto");
  const s = session(dir);
  for (let i = 0; i < WRITE_OUT_MAX; i++) expect([i, (await decide(s, `D${i}=${dir}; cd "$D${i}" && git push origin main`)).is]).toEqual([i, "refused"]);
  expect((await decide(s, `E=${dir}; cd "$E" && git push origin main`)).is).toBe("card");
  g.turnStarted(s.id);
  expect((await decide(s, `E=${dir}; cd "$E" && git push origin main`)).is).toBe("refused");
});
