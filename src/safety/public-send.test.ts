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
import type { Mode } from "./policy.ts";
import { held, learner, type Deps, type Visibility } from "./public-send.ts";
import { sentencesOf } from "./private-words.ts";

// A push or a gh call that goes to a public repository is read for private words (public-send.ts). Real git in
// scratch repositories; what a remote's visibility is, is the one thing handed in.
const tmp = () => process.env.TMPDIR ?? tmpdir();
const OWNER = "Please make the release notes shorter and move the install steps to the top.";
const before = settings().private?.terms ?? [];
const owned = settings().accounts?.namespaces ?? [];
// (The repository is the owner's own, so no card for an account beyond his gets in the way of what is held here.)
beforeAll(() => { const r = patchSettings({ private: { terms: ["buildbox"] }, accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ private: { terms: before }, accounts: { namespaces: owned } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); };
// A repository whose remote is a public-looking address, and a commit on it.
async function repo(message: string, file = "a.txt", body = "plain\n", remote = "git@github.com:acme/open.git") {
  const dir = mkdtempSync(join(tmp(), "pub-send-"));
  await sh(dir, "init", "-q", "-b", "main");
  await sh(dir, "config", "user.email", "o@example.org");
  await sh(dir, "config", "user.name", "o");
  await sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, file), body);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", message);
  await sh(dir, "remote", "add", "origin", remote);
  return dir;
}
const deps = (vis: Visibility | Record<string, Visibility> = "public", said = [OWNER]): Deps & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    visibility: async (r) => { const k = `${r.host}/${r.path.join("/")}`; asked.push(k); return typeof vis === "string" ? vis : vis[k] ?? "public"; },
    words: async () => ({ words: { terms: ["buildbox"], projects: [], homes: ["/home/someone"], sentences: sentencesOf(said) }, folders: new Map() }),
  };
};

test("a commit message with a sentence the owner typed is held, quoted with its place", async () => {
  const dir = await repo(`Docs\n\n${OWNER}`);
  const h = await held("git push origin main", dir, deps(), "s");
  expect(h?.found.map((f) => f.kind)).toEqual(["quote"]);
  expect(h!.found[0]!.where).toMatch(/^commit [0-9a-f]{7} message$/);
  expect(h!.found[0]!.line).toBe(3);
  expect(h!.found[0]!.text).toContain("release notes shorter");
});

test("a host name in a commit message, or in a line a commit adds, is held with its file and line", async () => {
  const msg = await repo("Deploy from buildbox to the box");
  expect((await held("git push origin main", msg, deps(), "s"))?.found[0]).toMatchObject({ kind: "host", word: "buildbox" });
  const diff = await repo("Add config", "conf.txt", "one\ntwo\nrun on BuildBox.lan now\n");
  const h = await held("cd " + diff + " && git push -u origin main", tmp(), deps(), "s");
  expect(h?.found[0]).toMatchObject({ kind: "host", line: 3 });
  expect(h!.found[0]!.where).toEndWith(":conf.txt");
});

test("a clean push passes, and so does a push to a private repository", async () => {
  const clean = await repo("Fix the parser");
  const d = deps();
  expect(await held("git push origin main", clean, d, "s")).toBeNull();
  expect(d.asked).toEqual(["github.com/acme/open"]);
  const dirty = await repo("Deploy from buildbox");
  expect(await held("git push origin main", dirty, deps("private"), "s")).toBeNull();
  // A repository that cannot be told is read.
  expect(await held("git push origin main", dirty, deps("unknown"), "s")).not.toBeNull();
});

test("a personal path and a secret are held, and the secret is not repeated", async () => {
  const token = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
  const dir = await repo("Add notes", "n.md", `see /home/someone/work/x\nTOKEN ${token}\n`);
  const h = await held("git push origin main", dir, deps(), "s");
  expect(h?.found.map((f) => f.kind).sort()).toEqual(["path", "secret"]);
  expect(JSON.stringify(h)).not.toContain(token);
});

test("gh pr create, gh pr comment and gh issue create are read: flags, a body file and a here-document", async () => {
  const dir = await repo("Fine");
  writeFileSync(join(dir, "body.md"), "Notes from buildbox.\n");
  const d = deps();
  expect((await held("gh pr create --title T --body 'ran on buildbox'", dir, d, "s"))?.found[0]?.where).toBe("gh pr create body");
  expect((await held("gh issue create -t T -F body.md", dir, d, "s"))?.found[0]).toMatchObject({ where: "body.md", line: 1 });
  const doc = await held("gh pr comment 3 -F - <<'EOF'\nlooked at buildbox\nEOF", dir, d, "s");
  expect(doc?.found[0]).toMatchObject({ where: "gh pr comment body", line: 1 });
  const sub = await held("gh pr create --title T --body \"$(cat <<'EOF'\nran on buildbox\nEOF\n)\"", dir, d, "s");
  expect(sub?.found[0]?.kind).toBe("host");
  expect(await held("gh pr comment 3 --body 'looks good'", dir, d, "s")).toBeNull();
  // -R names the repository: a private one is not read.
  expect(await held("gh pr comment 3 -R acme/closed --body 'buildbox'", dir, deps({ "github.com/acme/closed": "private" }), "s")).toBeNull();
  expect(await held("gh pr comment 3 -R acme/open --body 'buildbox'", dir, deps({ "github.com/acme/closed": "private" }), "s")).not.toBeNull();
});

test("a command that is not a push or a gh write is not read", async () => {
  const dir = await repo("Deploy from buildbox");
  const d = deps();
  expect(await held("git log --oneline", dir, d, "s")).toBeNull();
  expect(await held("gh pr view 3", dir, d, "s")).toBeNull();
  expect(d.asked).toEqual([]);
});

// ---- the gate ----

const bash = toolsFor("claude").find((t) => t.name === "Bash") as Tool;
const rig = (mode: Mode, vis: Visibility = "public") => {
  const store = new Store(mkdtempSync(join(tmp(), "pub-gate-")));
  const g = new Gate(store, new Bus(), () => false);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  store.migrate("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT)");
  g.publicSend = { visibility: async () => vis, words: learner(store) };
  const session = (dir: string, parent?: Session): Session => {
    const s = store.createSession({ model: "m", workspace: dir });
    if (parent) {
      store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
      store.db.query("INSERT INTO agents (id, parent_id, session_id) VALUES (?, ?, ?)").run(`ag-${s.id.slice(0, 6)}`, parent.id, s.id);
    }
    g.setPerm(s.id, { mode, sandbox: "off" });
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
    const text = card?.why ?? "";
    if (card) g.resolve(card.id, s.id, { choice: "once", seen: "whole" });
    const after = await out;
    return { is: "card" as const, text, once: card?.once, then: "deny" in after ? "refused" : "ran" };
  };
  return { store, session, decide };
};

test("gate: the owner's card quotes what was found and allows once; an agent is refused with the same words", async () => {
  for (const mode of ["ask", "auto-edits"] as const) {
    const dir = await repo(`Docs\n\n${OWNER}`);
    const { store, session, decide } = rig(mode);
    const s = session(dir);
    store.append(s.id, "user", { text: `${OWNER} Then push it.` });
    const r = await decide(s, "git push origin main");
    expect(r.is).toBe("card");
    expect(r.text).toContain("public place under your name");
    expect(r.text).toContain("your own words from this session");
    expect(r.once).toBe(true);
    expect(r).toMatchObject({ then: "ran" });
    const kid = session(dir, s);
    const k = await decide(kid, "git push origin main");
    expect(k.is).toBe("refused");
    expect(k.text).toContain("release notes shorter");
  }
});

test("gate: a clean push, and a private repository are not held", async () => {
  const dir = await repo("Deploy from buildbox");
  const clean = await repo("Fix");
  const ask = rig("ask");
  expect((await ask.decide(ask.session(clean), "git push origin main")).text).not.toContain("private words");
  const priv = rig("ask", "private");
  expect((await priv.decide(priv.session(dir), "git push origin main")).text).not.toContain("private word");
  const open = rig("ask");
  expect((await open.decide(open.session(dir), "git push origin main")).text).toContain("a private host name or word (buildbox)");
});

test("gate: full auto is held too: the owner's card, an agent refused", async () => {
  const dir = await repo("Deploy from buildbox");
  const full = rig("full-auto");
  const s = full.session(dir);
  const r = await full.decide(s, "git push origin main");
  expect(r.is).toBe("card");
  expect(r.text).toContain("a private host name or word (buildbox)");
  const k = await full.decide(full.session(dir, s), "git push origin main");
  expect(k.is).toBe("refused");
  const clean = await repo("Fix");
  expect(await full.decide(full.session(clean), "git push origin main")).toMatchObject({ is: "ran" });
});

// ---- what the world says, and what is learned ----

test("visibility comes from gh repo view, once for a few minutes", async () => {
  const { askVisibility, forgetVisibility } = await import("./public-send.ts");
  const dir = mkdtempSync(join(tmp(), "pub-gh-"));
  const log = join(dir, "calls");
  const stub = join(dir, "gh");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${log}\ncase "$3" in *closed*) echo PRIVATE;; *) echo PUBLIC;; esac\n`, { mode: 0o755 });
  const was = process.env.KEEL_GH_BIN;
  process.env.KEEL_GH_BIN = stub;
  try {
    forgetVisibility();
    expect(await askVisibility({ host: "github.com", path: ["acme", "open"] })).toBe("public");
    expect(await askVisibility({ host: "github.com", path: ["acme", "open"] })).toBe("public");
    expect(await askVisibility({ host: "github.com", path: ["acme", "closed"] })).toBe("private");
    expect((await Bun.file(log).text()).trim().split("\n")).toEqual(["repo view github.com/acme/open --json visibility -q .visibility", "repo view github.com/acme/closed --json visibility -q .visibility"]);
  } finally {
    if (was === undefined) delete process.env.KEEL_GH_BIN; else process.env.KEEL_GH_BIN = was;
    forgetVisibility();
  }
});

test("what is private is learned: the fleet's machines, the ssh config's aliases, the owner's sentences of the root session", async () => {
  const store = new Store(mkdtempSync(join(tmp(), "pub-learn-")));
  store.migrate("CREATE TABLE IF NOT EXISTS fleet_machines (id TEXT PRIMARY KEY, name TEXT, ssh_host TEXT, daemon_url TEXT)");
  store.db.query("INSERT INTO fleet_machines (id, name, ssh_host, daemon_url) VALUES ('m1', 'workbox', 'buildhost-7', 'http://rack9.lan:47950')").run();
  const conf = join(mkdtempSync(join(tmp(), "pub-ssh-")), "config");
  writeFileSync(conf, "Host github.com\n  User git\nHost lab-gpu *.x\n  User me\n");
  const was = process.env.KEEL_SSH_CONFIG;
  process.env.KEEL_SSH_CONFIG = conf;
  try {
    const folder = join(mkdtempSync(join(tmp(), "pub-w-")), "some-private-app");
    mkdirSync(folder);
    const gone = store.createSession({ model: "m", workspace: join(tmp(), "pub-gone", "old-private-app") });
    const root = store.createSession({ model: "m", workspace: folder });
    void gone;
    store.append(root.id, "user", { text: OWNER });
    store.append(root.id, "user", { text: "[harness] Please make the release notes shorter and move the install steps first, said a notice.", origin: "harness" });
    const got = (await learner(store)(root.id)).words;
    expect(got.terms).toEqual(expect.arrayContaining(["buildbox", "workbox", "buildhost-7", "rack9.lan", "lab-gpu"]));
    expect(got.terms).not.toContain("github.com");
    // (A folder that is gone is no project of his.)
    expect(got.projects).toEqual(["some-private-app"]);
    expect(got.sentences).toEqual([OWNER]);
  } finally {
    if (was === undefined) delete process.env.KEEL_SSH_CONFIG; else process.env.KEEL_SSH_CONFIG = was;
  }
});
