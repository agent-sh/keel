import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchSettings, settings } from "../admin/settings.ts";
import { git } from "../core/git.ts";
import { Store } from "../core/store.ts";
import { ownEnv, tempTree } from "../../test/env.ts";
import { held, learner, learned, type Deps, type Visibility } from "./public-send.ts";
import { narrow } from "./line-vars.ts";
import { sentencesOf } from "./private-words.ts";

// What a send's words stand for before they are read (~, $HOME, a variable the line set), what is learned from sessions
// (scratch folders, imported notices), and a word cut by the slice of a long line.
const OWNER = "Please make the release notes shorter and move the install steps to the top.";
const owned = settings().accounts?.namespaces ?? [];
const home = tempTree("pub-home-");
ownEnv({ HOME: home });
beforeAll(() => { const r = patchSettings({ accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ accounts: { namespaces: owned } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); };
async function repo(message = "Fix", file = "a.txt", body = "plain\n", name = "pub-res-") {
  const dir = mkdtempSync(join(home, name));
  await sh(dir, "init", "-q", "-b", "main");
  await sh(dir, "config", "user.email", "o@example.org");
  await sh(dir, "config", "user.name", "o");
  await sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, file), body);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", message);
  await sh(dir, "remote", "add", "origin", "git@github.com:acme/open.git");
  return dir;
}
type Part = { terms?: string[]; projects?: string[]; folders?: [string, string[]][] };
const deps = (p: Part = {}, vis: Visibility = "public"): Deps => ({
  visibility: async () => vis,
  words: async () => ({ words: { terms: p.terms ?? ["buildbox"], projects: p.projects ?? [], homes: ["/home/someone"], sentences: sentencesOf([OWNER]) }, folders: new Map(p.folders ?? []) }),
});
const run = async (cmd: string, dir: string, p?: Part) => held(cmd, dir, deps(p), "s");

test("~ and $HOME in a file word are the home folder", async () => {
  const dir = await repo();
  writeFileSync(join(home, "b.md"), "ran on buildbox\n");
  writeFileSync(join(home, "m.txt"), "ran on buildbox\n");
  for (const f of ["~/b.md", "$HOME/b.md", "${HOME}/b.md", '"$HOME/b.md"', '"~/b.md"']) {
    const h = await run(`gh pr comment 3 -R acme/open -F ${f}`, dir);
    expect([f, h?.unread, h?.found.map((x) => x.kind)]).toEqual([f, [], ["host"]]);
  }
  for (const c of ["git commit -F ~/m.txt && git push origin main", "git commit --file=$HOME/m.txt && git push origin main"]) {
    const h = await run(c, dir);
    expect([c, h?.unread, h?.found.some((x) => x.kind === "host")]).toEqual([c, [], true]);
  }
  const w = await run("cat > ~/w.md <<'EOF'\nran on buildbox\nEOF\ngh pr create -R acme/open -t T -F ~/w.md", dir);
  expect([w?.unread, w?.found[0]?.kind]).toEqual([[], "host"]);
  const p = await run("cat ~/b.md | gh pr create -R acme/open -t T -F -", dir);
  expect([p?.unread, p?.found[0]?.kind]).toEqual([[], "host"]);
});

test("a variable the line set to a written-out value is read as that value, in a line with other commands too", async () => {
  const dir = await repo("Deploy from buildbox");
  const other = mkdtempSync(join(home, "pub-other-"));
  writeFileSync(join(home, "b.md"), "ran on buildbox\n");
  const lines = [
    "set -e; B=~/b.md; gh pr comment 3 -R acme/open -F \"$B\"",
    "for x in 1; do :; done; B=$HOME/b.md; gh pr comment 3 -R acme/open -F \"$B\"",
    "if true; then echo a; fi; B=~/b.md; export B; gh pr comment 3 -R acme/open --body-file \"${B}\"",
  ];
  for (const c of lines) {
    const h = await run(c, other);
    expect([c, h?.unread, h?.found.map((x) => x.kind)]).toEqual([c, [], ["host"]]);
  }
  for (const c of [`set -e; D=${dir}; cd "$D" && git push origin main`, `for x in 1; do :; done; D=${dir}; git -C "$D" push origin main`]) {
    const h = await run(c, other);
    expect([c, h?.unread, h?.found[0]?.where]).toEqual([c, [], expect.stringMatching(/^commit [0-9a-f]{7} message$/)]);
  }
  // A name the line sets twice is read by its last literal before the use (the gate's written-out line does the same),
  // so the push is read in the folder the second assignment names.
  const twice = await run(`set -e; D=${other}; D=${dir}; cd "$D" && git push origin main`, other);
  expect([twice?.unread, twice?.found[0]?.where]).toEqual([[], expect.stringMatching(/^commit [0-9a-f]{7} message$/)]);
  // A name bound by a loop is not known: the hold says so.
  const loop = await run(`for D in ${other}; do :; done; cd "$D" && git push origin main`, other);
  expect(loop?.unread[0]).toContain("is not known");
});

test("a refspec the line cannot know reads every branch, not a revision that does not exist", async () => {
  const dir = await repo("Deploy from buildbox");
  for (const c of ['c=$(git rev-parse HEAD); git push origin "$c":refs/heads/main', "git push origin $SHA:refs/heads/main", 'git push origin "$(git rev-parse HEAD)":main']) {
    const h = await run(c, dir);
    expect([c, h?.unread, h?.found[0]?.where]).toEqual([c, [], expect.stringMatching(/^commit [0-9a-f]{7} message$/)]);
  }
});

test("a scratch folder is no project", async () => {
  const store = new Store(mkdtempSync(join(home, "pub-store-")));
  const keep = join(home, "projects", "secret-app");
  const scratch = join(home, ".cache", "task-7", "pr-1234");
  mkdirSync(keep, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  store.createSession({ model: "m", workspace: keep });
  store.createSession({ model: "m", workspace: scratch });
  const got = await learner(store)(store.createSession({ model: "m", workspace: keep }).id);
  expect(got.words.projects).toEqual(["secret-app"]);
});

test("a project word in a branch or file name is no hold only when the repository already has that name", async () => {
  const keep = join(home, "projects", "secret-app");
  mkdirSync(keep, { recursive: true });
  const p = { projects: ["secret-app"], folders: [["secret-app", [keep]]] as [string, string[]][] };
  const a = await repo("Base", "secret-app.md", "plain\n");
  // What the remote has: its main with that file, and a branch of that name.
  await sh(a, "update-ref", "refs/remotes/origin/main", "HEAD");
  await sh(a, "update-ref", "refs/remotes/origin/feat/secret-app-fix", "HEAD");
  await sh(a, "checkout", "-q", "-b", "feat/secret-app-fix");
  writeFileSync(join(a, "secret-app.md"), "changed\n");
  await sh(a, "commit", "-q", "-am", "Edit");
  expect(await run("git push -u origin feat/secret-app-fix", a, p)).toBeNull();
  // A new branch, or a new file, that carries the word is public once pushed.
  await sh(a, "checkout", "-q", "-b", "feat/secret-app-new");
  const nb = await run("git push -u origin feat/secret-app-new", a, p);
  expect(nb?.found.map((f) => `${f.kind}:${f.where}`)).toEqual(["project:git push branch names"]);
  writeFileSync(join(a, "secret-app-notes.md"), "plain\n");
  await sh(a, "add", "-A");
  await sh(a, "commit", "-q", "-m", "Notes");
  const nf = await run("git push origin HEAD:feat/secret-app-fix", a, p);
  expect(nf?.found.map((f) => `${f.kind}:${f.text}`)).toEqual(["project:secret-app-notes.md"]);
});

test("a variable is written out only when its value is one plain word", () => {
  for (const d of ["'#x'", "'a;b'", "'/x&&y'", "'/x|y'", "'/x>y'", "'/x<y'", "'a b'", "'$(id)'"]) {
    expect([d, narrow(`D=${d}; cd $D && git push origin main`, "/h")]).toEqual([d, null]);
  }
  expect(narrow("set -e; D=/a/b-c.d; cd $D && git push origin main", "/h")).toBe("set -e; D=/a/b-c.d; cd /a/b-c.d && git push origin main");
});

test("a variable set in a subshell, a substitution, a function, a here-document or for one command is not the line's", () => {
  for (const c of [
    "(D=/a; true); cd $D && git push origin main",
    "X=$(D=/a; echo); cd $D && git push origin main",
    "echo `D=/a`; cd $D && git push origin main",
    "f() { local D=/a; }; cd $D && git push origin main",
    "cat <<EOF\nD=/a\nEOF\ncd $D && git push origin main",
    "D=/a true; cd $D && git push origin main",
  ]) expect([c, narrow(c, "/h")]).toEqual([c, null]);
  expect(narrow("export D=/a; cd $D && git push origin main", "/h")).toBe("export D=/a; cd /a && git push origin main");
  // A word of a here-document is text, not a command.
  expect(narrow("D=/a; cat <<EOF\ncd $D\nEOF\ngit push", "/h")).toBeNull();
});

test("a value the line quotes cannot hide the push", async () => {
  const dir = await repo("Deploy from buildbox");
  for (const c of ["D='#x'; cd $D && git push origin main", "D='/x;y'; cd $D && git push origin main"]) {
    const h = await run(c, dir);
    expect([c, h?.unread.some((u) => u.includes("is not known"))]).toEqual([c, true]);
  }
});

test("a delete sends no commit: nothing is read, and no revision is asked for", async () => {
  const dir = await repo("Deploy from buildbox");
  for (const c of ["git push origin --delete gone-branch", "git push origin -d gone-branch", "git push origin :gone-branch", "git push origin :a :b"]) {
    expect([c, await run(c, dir)]).toEqual([c, null]);
  }
  // A delete beside a push: the push is read.
  const h = await run("git push origin :gone-branch main", dir);
  expect(h?.found.map((f) => f.kind)).toEqual(["host"]);
  // A commit of the same line goes nowhere on a delete.
  expect(await run("git commit --allow-empty -m 'Deploy from buildbox' && git push origin --delete gone-branch", dir)).toBeNull();
});

test("a line that sets HOME does not say what ~ and $HOME are", async () => {
  const dir = await repo();
  writeFileSync(join(home, "b.md"), "ran on buildbox\n");
  for (const c of ["HOME=/x; gh pr comment 3 -R acme/open -F ~/b.md", "export HOME=/x; gh pr comment 3 -R acme/open -F $HOME/b.md", "HOME=/x gh pr comment 3 -R acme/open -F ~/b.md"]) {
    const h = await run(c, dir);
    expect([c, h?.found, h?.unread.length]).toEqual([c, [], 1]);
  }
});

test("an owner's message that starts like a notice is his; a notice's block is cut out of a message, not the message", async () => {
  const store = new Store(mkdtempSync(join(home, "pub-start-")));
  const root = store.createSession({ model: "m", workspace: home });
  const a = "Something failed in Keel when I clicked the save button and the whole panel went blank for me.";
  const b = "Then I reloaded the page twice and the list of sessions came back with every title missing.";
  const c = "Please look at the third item again because the numbers there do not add up to the total.";
  store.append(root.id, "user", { text: a });
  store.append(root.id, "user", { text: `<task-notification>some words of a task that ended</task-notification>\n${b}` });
  store.append(root.id, "user", { text: `<task-notification>${c} and it never closed` });
  store.append(root.id, "user", { text: "[momentum] A reminder that the lane is waiting on a review from somebody else today." });
  store.append(root.id, "user", { text: `Something failed in Keel (session "x"): boom\n\nThe debug bundle is /tmp/a.md. ${c}` });
  store.append(root.id, "user", { text: "Typed once, with an origin the owner's own composer gives it, so it is kept as it is.", origin: "owner" });
  const words = (await learner(store)(root.id)).words;
  expect([...words.sentences].sort()).toEqual([a, b, "Typed once, with an origin the owner's own composer gives it, so it is kept as it is."].sort());
});

test("what a session's notices said is not the owner's sentence", async () => {
  const store = new Store(mkdtempSync(join(home, "pub-say-")));
  const root = store.createSession({ model: "m", workspace: home });
  const heard = "Please keep the output narrow and put the failing case on top of the table.";
  store.append(root.id, "user", { text: OWNER });
  store.append(root.id, "user", { text: `<wait_fired id="a1" kind="timer">${heard}</wait_fired>` });
  store.append(root.id, "user", { text: `<task-notification>${heard}</task-notification>` });
  store.append(root.id, "user", { text: "The wait finished and the notes were all read over by the agent.", origin: "wait" });
  store.append(root.id, "user", { text: "Agent report: the build was checked on three machines and all of them passed.", origin: "subagent" });
  store.append(root.id, "user", { text: `An agent you started has reported. Each block below is the output of an agent.\n\n<subagent_result agent_id="a">${heard} Then more words.</subagent_result>` });
  store.append(root.id, "user", { text: `[from session "other" (01a1ed88)] ${heard}` });
  store.append(root.id, "user", { text: "Restarted, and the daemon picked the turn up where it was cut off.", origin: "restart" });
  const words = (await learner(store)(root.id)).words;
  expect(words.sentences).toEqual([OWNER]);
});

test("the owner's sentences are made once for a session until it says something new", async () => {
  const store = new Store(mkdtempSync(join(home, "pub-cache-")));
  const root = store.createSession({ model: "m", workspace: home });
  store.append(root.id, "user", { text: OWNER });
  const l = learner(store);
  const n = learned.sentences;
  await l(root.id); await l(root.id); await l(root.id);
  expect(learned.sentences - n).toBe(1);
  store.append(root.id, "user", { text: "And also tell me when the release notes are ready for a read." });
  await l(root.id);
  expect(learned.sentences - n).toBe(2);
});

test("a word cut by the edge of a slice of one very long line is found", async () => {
  const body = "ab ".repeat(66_665) + "buildbox and more\n";
  const dir = await repo("Long", "long.txt", body);
  const h = await run("git push origin main", dir);
  expect(h?.found.map((f) => `${f.kind}:${f.word}:${f.where.replace(/ [0-9a-f]{7}:/, " H:")}:${f.line}`)).toEqual(["host:buildbox:commit H:long.txt:1"]);
});
