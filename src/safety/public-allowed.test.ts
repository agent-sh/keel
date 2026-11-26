// Words the owner allowed once to go to a public place are not asked about again in the session (public-allowed.ts):
// the key of a finding, what is left of a hold, and the gate over a real repository.
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
import { Gate } from "./gate.ts";
import { matcher, type Finding } from "./private-words.ts";
import { PublicAllowed, hitKey, left, remembered } from "./public-allowed.ts";
import { heldWhy, type Held } from "./public-send.ts";

const f = (where: string, text: string, word = "buildbox", line = 3): Finding => ({ kind: "host", word, where, line, text });
const TO = ["github.com/acme/open"];

test("a finding is the same one by where it goes, its file, its word and its line, whatever commit carries it", () => {
  const k = hitKey(TO, f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox"));
  expect(k).not.toBeNull();
  // The same line in the same file under another commit (a rebase), at another line number, in another case of the word.
  expect(hitKey(TO, f("commit 5d4c3b2a1:src/a.test.ts", "run on buildbox", "Buildbox", 9))).toBe(k);
  expect(hitKey(["github.com/acme/open", "github.com/acme/open"], f("commit 9f8e7d6c5:src/a.test.ts", "run on buildbox"))).toBe(k);
  // Another repository, file, word, kind or text is another finding.
  const others = [
    hitKey(["github.com/acme/other"], f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox")),
    hitKey([...TO, "github.com/acme/other"], f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox")),
    hitKey(TO, f("commit 1a2b3c4d5:src/b.test.ts", "run on buildbox")),
    hitKey(TO, f("commit 1a2b3c4d5 message", "run on buildbox")),
    hitKey(TO, f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox", "box")),
    hitKey(TO, f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox again")),
    hitKey(TO, { ...f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox"), kind: "project" }),
    hitKey(TO, f("working tree:src/a.test.ts", "run on buildbox")),
  ];
  expect(new Set([k, ...others]).size).toBe(others.length + 1);
  expect(hitKey(TO, f("commit 1a2b3c4d5 message", "Deploy from buildbox"))).toBe(hitKey(TO, f("commit 0a1b2c3d4 message", "Deploy from buildbox")));
  // Not kept: a send whose repository is not known, and a line too long to show whole.
  expect(hitKey([], f("commit 1a2b3c4d5:src/a.test.ts", "run on buildbox"))).toBeNull();
  expect(hitKey(TO, f("commit 1a2b3c4d5:src/a.test.ts", `${"x".repeat(160)}...`))).toBeNull();
});

test("what is left of a hold is what was not allowed before, and whatever could not be read", () => {
  const a = f("commit 1111111:src/a.ts", "run on buildbox"), b = f("commit 1111111:src/b.ts", "ssh buildbox"), long = f("commit 1111111:src/c.ts", `${"buildbox ".repeat(20)}...`);
  const allowed = new Set([hitKey(TO, a)!]);
  const h = (found: Finding[], unread: string[] = [], to: string[] = TO): Held => ({ found, acts: ["git push to github.com/acme/open"], unread, to });
  // All of it allowed before: nothing to ask.
  expect(left(h([a]), allowed)).toBeNull();
  expect(left(h([{ ...a, where: "commit 2222222:src/a.ts", line: 40 }]), allowed)).toBeNull();
  // Something new: only that is listed, and the card says how many are not.
  const some = left(h([a, b]), allowed)!;
  expect(some.found).toEqual([b]);
  expect(heldWhy(some)).toContain("commit 1111111:src/b.ts");
  expect(heldWhy(some)).not.toContain("src/a.ts");
  expect(heldWhy(some)).toContain("Not listed again: 1 more that you allowed to go there earlier in this session.");
  // What could not be read asks, with nothing new in what was read.
  const cut = left(h([a], ["git push: the commits past the first 8 MB of text were not read"]), allowed)!;
  expect([cut.found, cut.unread.length, cut.again]).toEqual([[], 1, 1]);
  // A line too long to show whole, another repository, a send that names none: asked as before.
  expect(left(h([long]), new Set([hitKey(TO, { ...long, text: "x" })!]))?.found).toEqual([long]);
  expect(left(h([a], [], ["github.com/acme/other"]), allowed)?.found).toEqual([a]);
  expect(left(h([a], [], []), allowed)?.found).toEqual([a]);
  expect(left({ found: [a], acts: ["git push"], unread: [] }, allowed)?.found).toEqual([a]);
  expect(left(h([a]), new Set())?.found).toEqual([a]);
});

test("only what the card quoted is kept: a finding past the first six asks again, and a secret is never kept", () => {
  const store = new Store(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "public-allowed-kept-")));
  const s = store.createSession({ model: "m", workspace: process.env.TMPDIR ?? tmpdir() });
  const kept = new PublicAllowed(store);
  const h = (found: Finding[]): Held => ({ found, acts: ["git push to github.com/acme/open"], unread: [], to: TO });
  // Nine findings: the card quotes six and counts the rest, so the answer is for the six.
  const nine = Array.from({ length: 9 }, (_, i) => f(`commit 1111111:src/f${i}.ts`, `run ${i} on buildbox`));
  expect(heldWhy(h(nine))).toContain("and 3 more");
  expect(remembered(h(nine))).toContain("for 6 of the findings quoted above");
  kept.allow(s.id, h(nine));
  const next = kept.left(s.id, h(nine))!;
  expect([next.found, next.again]).toEqual([nine.slice(6), 6]);
  expect(remembered(next)).toContain("remembered until this session ends: the same words");
  kept.allow(s.id, next);
  expect(kept.left(s.id, h(nine))).toBeNull();
  // A token's shape: the line is hidden and the word is the kind of token, so another token on that line of that file
  // would have the same key. (Both made up here, in two pieces so the file holds no token's shape.)
  const find = matcher({ terms: [], projects: [], homes: [], sentences: [], holds: (t) => t.includes("vault-value-one") || t.includes("vault-value-two") });
  const one = find([{ where: "commit 1111111:config/dev.env", first: 3, text: `TOKEN=${"ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}` }]);
  const two = find([{ where: "commit 2222222:config/dev.env", first: 3, text: `TOKEN=${"ghp_" + "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8"}` }]);
  expect([one.length, one[0]?.kind, two[0]?.kind]).toEqual([1, "secret", "secret"]);
  expect(hitKey(TO, one[0]!)).toBeNull();
  expect(remembered(h(one))).toBe("");
  kept.allow(s.id, h(one));
  expect(kept.left(s.id, h(two))?.found).toEqual(two);
  expect(kept.left(s.id, h(one))?.found).toEqual(one);
  // A value the vault holds, in any line.
  const v1 = find([{ where: "commit 1111111 message", first: 1, text: "note vault-value-one" }]), v2 = find([{ where: "commit 3333333 message", first: 1, text: "another line with vault-value-two in it" }]);
  expect([v1[0]?.kind, hitKey(TO, v1[0]!)]).toEqual(["secret", null]);
  kept.allow(s.id, h(v1));
  expect(kept.left(s.id, h(v2))?.found).toEqual(v2);
  // Beside a finding that is kept, the card says which.
  const mixed = h([nine[0]!, one[0]!]);
  expect(remembered(mixed)).toContain("for 1 of the findings quoted above");
  expect(kept.left(s.id, mixed)?.found).toEqual(one);
});

// ---- the gate ----

const tmp = () => process.env.TMPDIR ?? tmpdir();
const namesBefore = settings().accounts?.namespaces ?? [], termsBefore = settings().private?.terms ?? [];
beforeAll(() => { const r = patchSettings({ private: { terms: ["buildbox", "stagebox"] }, accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ private: { terms: termsBefore }, accounts: { namespaces: namesBefore } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); return r.out.trim(); };
// The owner's own public repository: main, and a branch whose commit names a private host in a file and in its message.
async function repo(file = "b.txt", text = "ran on buildbox\n") {
  const dir = mkdtempSync(join(tmp(), "public-allowed-"));
  await sh(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.email", "o@example.org"], ["user.name", "o"], ["commit.gpgsign", "false"]]) await sh(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "plain\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "Fix");
  await sh(dir, "checkout", "-q", "-b", "other");
  writeFileSync(join(dir, file), text);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", file === "b.txt" ? "Deploy from buildbox" : "Add a note");
  await sh(dir, "remote", "add", "origin", "git@github.com:acme/open.git");
  return dir;
}
const bash = toolsFor("claude").find((t) => t.name === "Bash") as Tool;
function rig(sentences: string[] = []) {
  const store = new Store(mkdtempSync(join(tmp(), "public-allowed-gate-")));
  const make = () => {
    const g = new Gate(store, new Bus(), () => false);
    g.publicSend = { visibility: async () => "public", words: async () => ({ words: { terms: ["buildbox", "stagebox"], projects: [], homes: [], sentences }, folders: new Map() }) };
    return g;
  };
  let g = make();
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const session = (dir: string): Session => { const s = store.createSession({ model: "m", workspace: dir }); g.setPerm(s.id, { mode: "full-auto", sandbox: "off" }); return store.session(s.id)!; };
  // What a call is decided as: "ran", "refused", or "card" with the card's words, answered as `choice` says.
  const decide = async (s: Session, command: string, choice: "once" | "deny" = "once") => {
    const call: ToolCall = { id: crypto.randomUUID(), tool: bash, input: { command }, ctx: { sessionId: s.id, cwd: s.workspace, signal: new AbortController().signal, spillDir: s.workspace, seen: new Map() } };
    const out = g.check(s, call);
    let done = false;
    out.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 200 && !done && !g.approvals({ session: s.id, pending: true }).length; i++) await Bun.sleep(15);
    if (done) { const r = await out; return "deny" in r ? { is: "refused" as const, text: r.deny } : { is: "ran" as const, text: "" }; }
    const [card] = g.approvals({ session: s.id, pending: true });
    if (card) g.resolve(card.id, s.id, { choice, seen: "whole" });
    await out;
    return { is: "card" as const, text: card?.why ?? "" };
  };
  return { session, decide, restart: () => { g = make(); } };
}

test("gate: the same commit and the same private word are asked about once in a session; a new word, another session and a refusal still ask", async () => {
  const dir = await repo();
  const { session, decide, restart } = rig();
  const s = session(dir);
  // A card the owner refuses keeps nothing.
  const refused = await decide(s, "git push -q origin other", "deny");
  expect(refused.is).toBe("card");
  const first = await decide(s, "git push -q origin other");
  expect(first.is).toBe("card");
  expect(first.text).toContain("a private host name or word (buildbox)");
  expect(first.text).toContain("Allowing it is remembered until this session ends: the same words going to the same place are not asked about again.");
  expect(refused.text).toBe(first.text);
  // The push is sent again (it failed, or was held for something else): the same commit, the same words, no card.
  expect((await decide(s, "git push -q origin other")).is).toBe("ran");
  // The same commit rebased (another id, the same file and line): no card. After a restart of the daemon too.
  await sh(dir, "commit", "-q", "--amend", "--no-edit", "--date", "2020-01-01T00:00:00Z");
  restart();
  expect((await decide(s, "git push -q origin other")).is).toBe("ran");
  // A new private word in a later commit asks, and lists only what is new.
  writeFileSync(join(dir, "c.txt"), "then on stagebox\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "More");
  const more = await decide(s, "git push -q origin other");
  expect(more.is).toBe("card");
  expect(more.text).toContain("stagebox");
  expect(more.text).not.toContain("(buildbox)");
  expect(more.text).toContain("Not listed again: 2 more that you allowed to go there earlier in this session.");
  // Another session of the owner's was never asked: it is.
  const other = await decide(session(dir), "git push -q origin other");
  expect(other.is).toBe("card");
  expect(other.text).toContain("(buildbox)");
});

const ONE = "alpha beta gamma delta epsilon zeta one two three", OTHER = "alpha beta gamma delta epsilon zeta nine eight seven";

test("a sentence of the owner's that runs past the line quoted is never kept: another that opens with the same words and wraps the same way is another finding", () => {
  const find = matcher({ terms: [], projects: [], homes: [], sentences: [ONE, OTHER] });
  const at = (text: string) => find([{ where: "commit 1111111:n.md", first: 1, text }]);
  // On one line the finding's text holds every word of it: kept, and the other sentence is another text.
  const whole = at(`${ONE}\n`), other = at(`${OTHER}\n`);
  expect([whole.length, whole[0]!.past, hitKey(TO, whole[0]!) !== null]).toEqual([1, undefined, true]);
  expect(hitKey(TO, other[0]!)).not.toBe(hitKey(TO, whole[0]!));
  // Wrapped after its sixth word, the line quoted and the six words named are the same for both: neither is kept.
  const wrapped = at("alpha beta gamma delta epsilon zeta\none two three\n"), wrappedOther = at("alpha beta gamma delta epsilon zeta\nnine eight seven\n");
  expect([wrapped.length, wrapped[0]!.text, wrapped[0]!.word, wrapped[0]!.past]).toEqual([1, "alpha beta gamma delta epsilon zeta", "alpha beta gamma delta epsilon zeta ...", true]);
  expect([wrappedOther[0]!.text, wrappedOther[0]!.word]).toEqual([wrapped[0]!.text, wrapped[0]!.word]);
  expect([hitKey(TO, wrapped[0]!), hitKey(TO, wrappedOther[0]!)]).toEqual([null, null]);
  // Two that open alike on one line are one finding: past when either runs on, whichever comes first.
  for (const text of [`${ONE}. alpha beta gamma delta epsilon zeta\nnine eight seven\n`, `alpha beta gamma delta epsilon zeta\nnine eight seven. ${ONE}\n`]) {
    const two = at(text).filter((f) => f.line === 1);
    expect([text, two.length, two[0]!.past]).toEqual([text, 1, true]);
  }
  const h: Held = { found: wrapped, acts: ["git push to github.com/acme/open"], unread: [], to: TO };
  expect(remembered(h)).toBe("");
  expect(remembered({ ...h, found: [...whole, ...wrapped] })).toContain("for 1 of the findings quoted above");
  expect(remembered({ ...h, found: [...whole, ...wrapped] })).toContain("words of yours that run past the line quoted");
});

test("gate: a wrapped sentence the owner allowed does not let another with the same opening go with no card; one on a single line is asked about once", async () => {
  // The first line of the file is the same in both commits: only the words after the wrap differ.
  const dir = await repo("n.md", "alpha beta gamma delta epsilon zeta\none two three\n");
  const { session, decide } = rig([ONE, OTHER]);
  const s = session(dir);
  const first = await decide(s, "git push -q origin other");
  expect(first.is).toBe("card");
  expect(first.text).toContain("your own words from this session (alpha beta gamma delta epsilon zeta ...)");
  expect(first.text).not.toContain("Allowing it is remembered");
  await sh(dir, "rm", "-q", "n.md");
  await sh(dir, "commit", "-q", "-m", "Drop the note");
  writeFileSync(join(dir, "n.md"), "alpha beta gamma delta epsilon zeta\nnine eight seven\n");
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", "Add the note again");
  expect((await decide(s, "git push -q origin other")).is).toBe("card");
  // On one line the words are all on the card: the same push again runs, the other sentence asks.
  const flat = await repo("n.md", `${ONE}\n`);
  const t = session(flat);
  const shown = await decide(t, "git push -q origin other");
  expect([shown.is, shown.text.includes("Allowing it is remembered until this session ends")]).toEqual(["card", true]);
  expect((await decide(t, "git push -q origin other")).is).toBe("ran");
  writeFileSync(join(flat, "n.md"), `${OTHER}\n`);
  await sh(flat, "add", "-A");
  await sh(flat, "commit", "-q", "-m", "Change the note");
  expect((await decide(t, "git push -q origin other")).is).toBe("card");
});
