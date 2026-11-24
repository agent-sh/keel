import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings, settings } from "../admin/settings.ts";
import { git } from "../core/git.ts";
import { bounded, held, heldWhy, type Deps, type Visibility } from "./public-send.ts";
import { sentencesOf } from "./private-words.ts";

// What a public send reads and what it leaves out (public-send.ts): commits made on the same line, what is the
// owner's own, short names inside longer ones, reads that fail, long texts, every text a send carries.
const tmp = () => process.env.TMPDIR ?? tmpdir();
const OWNER = "Please make the release notes shorter and move the install steps to the top.";
const owned = settings().accounts?.namespaces ?? [];
beforeAll(() => { const r = patchSettings({ accounts: { namespaces: ["github.com/acme"] } }); if (!r.ok) throw new Error(r.error); });
afterAll(() => { patchSettings({ accounts: { namespaces: owned } }); });

const sh = async (dir: string, ...args: string[]) => { const r = await git(dir, args, { mode: "plain" }); if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`); };
async function repo(message = "Fix", file = "a.txt", body = "plain\n", remote = "git@github.com:acme/open.git", author = "o <o@example.org>") {
  const dir = mkdtempSync(join(tmp(), "pub-reads-"));
  await sh(dir, "init", "-q", "-b", "main");
  await sh(dir, "config", "user.email", "o@example.org");
  await sh(dir, "config", "user.name", "o");
  await sh(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, file), body);
  await sh(dir, "add", "-A");
  await sh(dir, "commit", "-q", "-m", message, `--author=${author}`);
  await sh(dir, "remote", "add", "origin", remote);
  return dir;
}
type Part = { terms?: string[]; projects?: string[]; folders?: [string, string[]][]; mine?: string[]; common?: (w: string) => boolean };
const deps = (p: Part = {}, vis: Visibility = "public"): Deps => ({
  visibility: async () => vis,
  words: async () => ({ words: { terms: p.terms ?? ["buildbox"], projects: p.projects ?? [], homes: ["/home/someone"], sentences: sentencesOf([OWNER]), common: p.common }, folders: new Map(p.folders ?? []), mine: p.mine }),
});
const kinds = async (cmd: string, dir: string, p?: Part) => (await held(cmd, dir, deps(p), "s"))?.found.map((f) => `${f.kind}:${f.word}:${f.where}`) ?? null;

test("a commit made on the same line is read: what it adds, what it says, in every form", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "a.txt"), "plain\nrun on buildbox now\n");
  const staged = await held("git add -A && git commit -m x && git push", dir, deps(), "s");
  expect(staged?.found[0]).toMatchObject({ kind: "host", where: "working tree:a.txt", line: 2 });
  writeFileSync(join(dir, "new.txt"), "one\ntwo buildbox\n");
  writeFileSync(join(dir, "a.txt"), "plain\n");
  const untracked = await held("git add -A && git commit -m x && git push", dir, deps(), "s");
  expect(untracked?.found[0]).toMatchObject({ kind: "host", where: "working tree:new.txt", line: 2 });
  // The same words through the shell, and with no add: what a commit -a takes.
  expect((await held("sh -c 'git add . && git commit -m x && git push'", dir, deps(), "s"))?.found[0]?.where).toBe("working tree:new.txt");
  rmNew(dir);
  expect(await held("git add -A && git commit -m x && git push", dir, deps(), "s")).toBeNull();
  for (const c of ['git commit -am "ran on buildbox"', 'git commit -qm "ran on buildbox"', 'git commit -m"ran on buildbox"', 'git commit --message="ran on buildbox"']) {
    expect([c, (await held(`${c} && git push`, dir, deps(), "s"))?.found[0]?.kind]).toEqual([c, "host"]);
  }
  writeFileSync(join(dir, "msg.txt"), "ran on buildbox\n");
  expect((await held("git commit -F msg.txt && git push", dir, deps(), "s"))?.found[0]).toMatchObject({ kind: "host", where: "msg.txt" });
  expect((await held("git commit -F - <<'EOF'\nIt isn't done: ran on buildbox\nEOF\ngit push", dir, deps(), "s"))?.found[0]).toMatchObject({ kind: "host", where: "git commit message" });
  expect((await held("git commit -F nope.txt && git push", dir, deps(), "s"))?.unread[0]).toContain("nope.txt");
  expect((await held("git tag -a v1 -m 'from buildbox' && git push --tags", dir, deps(), "s"))?.found[0]?.where).toBe("git tag message");
  expect((await held('git commit --author="buildbox admin <a@b.example>" -m x && git push', dir, deps(), "s"))?.found[0]?.where).toBe("git commit author");
});
function rmNew(dir: string) { Bun.spawnSync(["rm", "-f", join(dir, "new.txt")]); Bun.spawnSync(["git", "checkout", "--", "a.txt"], { cwd: dir }); }

test("what a push names is read: author and committer, file paths, branch names, an annotated tag", async () => {
  const a = await repo("Fix", "a.txt", "plain\n", undefined, "buildbox admin <admin@example.org>");
  expect((await held("git push origin main", a, deps(), "s"))?.found[0]).toMatchObject({ kind: "host" });
  expect((await held("git push origin main", a, deps(), "s"))!.found[0]!.where).toMatch(/author and committer$/);
  const f = await repo("Fix", "buildbox-notes.md");
  expect((await held("git push origin main", f, deps(), "s"))?.found[0]?.where).toMatch(/file names$/);
  const b = await repo();
  await sh(b, "checkout", "-q", "-b", "feat/buildbox-fix");
  expect((await held("git push -u origin feat/buildbox-fix", b, deps(), "s"))?.found[0]?.where).toBe("git push branch names");
  expect((await held("git push -u origin HEAD", b, deps(), "s"))?.found[0]?.where).toBe("git push branch names");
  const t = await repo();
  await sh(t, "tag", "-a", "v1", "-m", "built on buildbox");
  expect((await held("git push origin v1", t, deps(), "s"))?.found.map((x) => x.where)).toContain("tag v1 message");
  expect((await held("git push --tags", t, deps(), "s"))?.found.map((x) => x.where)).toContain("tag v1 message");
});

test("the owner's own names are no private words: his login, his accounts' owners, the repository it goes to, a URL's owner", async () => {
  const dir = await repo("See https://github.com/someone/tool and github.com/acme/open and /home/someone/x for acme and someone");
  const p = { terms: ["someone", "acme", "buildbox"], mine: ["someone", "acme"] };
  expect(await kinds("git push origin main", dir, p)).toEqual(["path:/home/someone:commit " + (await head(dir)) + " message"]);
  // (Not his: a name that sits in a URL's owner place is the URL's.)
  const url = await repo("Docs at https://github.com/buildbox/tool and github.com/buildbox/x");
  expect(await held("git push origin main", url, deps(), "s")).toBeNull();
  const own = await repo("Fix the open widget", "a.txt", "plain\n", "git@github.com:acme/widget.git");
  expect(await held("git push origin main", own, deps({ terms: ["widget"], projects: ["widget"] }), "s")).toBeNull();
});
const head = async (dir: string) => (await git(dir, ["log", "-1", "--format=%h"], { mode: "plain" })).out.trim();

test("a short or common name is not found inside a longer name, but is found on its own", async () => {
  const p = { terms: ["pico", "workbox"], common: (w: string) => w === "workbox" };
  const sentence = (m: string) => repo(m);
  expect(await held("git push origin main", await sentence("Uses model-pico-large and pico_batch and pico.ts and my-workbox-2"), deps(p), "s")).toBeNull();
  for (const m of ["Ran it on pico", "Ran it on pico.", "ssh pico; done", "(pico) and pico-"]) {
    expect([m, (await held("git push origin main", await sentence(m), deps(p), "s"))?.found[0]?.word]).toEqual([m, "pico"]);
  }
  // A longer name with a mark is still found where it stands in a name.
  expect((await held("git push origin main", await sentence("deploy to buildbox-ci"), deps(), "s"))?.found[0]?.word).toBe("buildbox");
});

test("a probe is cut at its end, whatever its helpers hold open", async () => {
  const t0 = Date.now();
  const r = await bounded(["sh", "-c", "sleep 30 & sleep 30"], { PATH: process.env.PATH }, 400);
  expect(r.code).toBe(-1);
  expect(Date.now() - t0).toBeLessThan(5000);
});

test("a push to a folder of this machine goes to no public place", async () => {
  const dir = await repo("Deploy from buildbox");
  for (const c of ["git push . main:other", "git push ../elsewhere main", "git push file:///x/y main"]) expect([c, await held(c, dir, deps(), "s")]).toEqual([c, null]);
  expect(await held("cd /gone/folder && git push origin main", dir, deps(), "s")).toBeNull();
});

test("what could not be read holds the call, and says what", async () => {
  const dir = await repo();
  const h = await held("git push origin no-such-branch", dir, deps(), "s");
  expect(h?.found).toEqual([]);
  expect(h?.unread[0]).toContain("reading the commits failed");
  expect(heldWhy(h!)).toContain("could not be read for private words");
  // A folder that is no repository sends nothing: nothing is missing.
  expect(await held("git push origin main", mkdtempSync(join(tmp(), "pub-nogit-")), deps(), "s")).toBeNull();
  expect((await held("gh pr create --title T -F missing.md", dir, deps(), "s"))?.unread[0]).toContain("missing.md could not be read");
  expect((await held("cd \"$WHERE\" && git push", dir, deps(), "s"))?.unread[0]).toContain("the folder it runs in is not known");
  // A private repository has nothing to read, and nothing unread.
  expect(await held("git push origin main", dir, deps({}, "private"), "s")).toBeNull();
});

test("a long text is read in slices with the loop free between, and a unit is capped", async () => {
  const lines: string[] = [];
  for (let i = 1; i <= 120_000; i++) lines.push(i === 90_000 ? "now on buildbox" : `line number ${i} of a long file`);
  const dir = await repo("Big", "big.txt", lines.join("\n") + "\n");
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const h = await held("git push origin main", dir, deps(), "s");
  clearInterval(timer);
  expect(h?.found[0]).toMatchObject({ kind: "host", line: 90_000 });
  expect(ticks).toBeGreaterThan(2);
  const huge = await repo("Huge", "huge.txt", "x".repeat(60) + "\n".repeat(1) + "y ".repeat(2_400_000) + "\nbuildbox\n");
  const g = await held("git push origin main", huge, deps(), "s");
  expect(g?.found).toEqual([]);
  expect(g?.unread.join("\n")).toContain("were not read");
});

test("a body file the line writes before it sends is read from what wrote it, or held as unread", async () => {
  const dir = await repo();
  const d = deps();
  expect((await held("cat > b.md <<'EOF'\nran on buildbox\nEOF\ngh pr create --title T --body-file b.md", dir, d, "s"))?.found[0]).toMatchObject({ kind: "host", where: "b.md" });
  expect((await held("echo 'ran on buildbox' > b.md && gh pr create -t T -F b.md", dir, d, "s"))?.found[0]?.kind).toBe("host");
  expect((await held("echo 'ran on buildbox' | gh pr create -t T -F -", dir, d, "s"))?.found[0]?.kind).toBe("host");
  expect(await held("printf 'a\\n' | tee b.md && gh pr create -t T -F b.md", dir, d, "s")).toBeNull();
  const other = await held("make-notes > b.md && gh pr create -t T -F b.md", dir, d, "s");
  expect(other?.found).toEqual([]);
  expect(other?.unread[0]).toContain("an earlier command of the line writes it");
  const piped = await held("make-notes | gh pr create -t T -F -", dir, d, "s");
  expect(piped?.unread[0]).toContain("standard input");
  // A document with prose in it (an apostrophe) is still the text that is sent.
  expect((await held("cat > b.md <<'EOF'\nIt isn't done: ran on buildbox\nEOF\ngh pr create -t T -F b.md", dir, d, "s"))?.found[0]).toMatchObject({ kind: "host", line: 1 });
  expect((await held("gh pr comment 3 -F - <<'EOF'\nIt isn't done: ran on buildbox\nEOF", dir, d, "s"))?.found[0]?.kind).toBe("host");
  // A file the line does not write is read where it is.
  writeFileSync(join(dir, "c.md"), "buildbox\n");
  expect((await held("gh pr create -t T -F c.md", dir, d, "s"))?.found[0]?.kind).toBe("host");
});

test("what gh publishes besides pr and issue is read: release, merge, api, public gist, repo edit", async () => {
  const dir = await repo();
  writeFileSync(join(dir, "notes.md"), "built on buildbox\n");
  const cases: [string, string][] = [
    ["gh release create v1.0 -t Rel -n 'built on buildbox'", "gh release create body"],
    ["gh release create v1.0 -F notes.md", "notes.md"],
    ["gh release edit v1.0 --notes 'built on buildbox'", "gh release edit body"],
    ["gh pr merge 4 --squash -b 'built on buildbox'", "gh pr merge body"],
    ["gh pr merge 4 -t 'buildbox fix' --delete-branch", "gh pr merge title"],
    ["gh api repos/acme/open/issues -f title=T -f body='built on buildbox'", "gh api body"],
    ["gh api repos/acme/open/issues/3/comments -F body=@notes.md", "notes.md"],
    ["gh api -X PATCH repos/acme/open --raw-field description='buildbox tool'", "gh api description"],
    ["gh gist create --public notes.md", "notes.md"],
    ["gh gist create -p -d 'buildbox notes' notes.md", "gh gist create title"],
    ["gh repo edit acme/open -d 'a tool for buildbox'", "gh repo edit title"],
    ["gh repo edit --homepage https://buildbox.example/x", "gh repo edit title"],
  ];
  for (const [c, where] of cases) expect([c, (await held(c, dir, deps(), "s"))?.found[0]?.where]).toEqual([c, where]);
  // Not a publication: a secret gist, a read, a clean text.
  expect(await held("gh gist create notes.md", dir, deps(), "s")).toBeNull();
  expect(await held("gh api repos/acme/open/issues -X GET -f state=open", dir, deps(), "s")).toBeNull();
  expect(await held("gh release create v1.0 -n 'fixes'", dir, deps(), "s")).toBeNull();
  // The repository decides: a private one is not read.
  expect(await held("gh release create v1.0 -R acme/closed -n 'built on buildbox'", dir, { ...deps(), visibility: async (r) => (r.path[1] === "closed" ? "private" : "public") }, "s")).toBeNull();
});

test("a project's name is private only for a live folder whose repository is not public", async () => {
  const live = mkdtempSync(join(tmp(), "pub-proj-"));
  mkdirSync(join(live, "side-app"));
  const folder = join(live, "side-app");
  await sh(folder, "init", "-q");
  const msg = "Work on side-app today";
  const dir = await repo(msg);
  const p = (f: string[]) => ({ projects: ["side-app"], terms: [], folders: [["side-app", f]] as [string, string[]][] });
  expect((await held("git push origin main", dir, deps(p([folder])), "s"))?.found[0]).toMatchObject({ kind: "project", word: "side-app" });
  // The folder is gone: not his project any more.
  expect(await held("git push origin main", dir, deps(p([join(live, "gone")])), "s")).toBeNull();
  // Its repository is public: nothing private in the name.
  await sh(folder, "remote", "add", "origin", "https://github.com/acme/side-app.git");
  expect(await held("git push origin main", dir, deps(p([folder])), "s")).toBeNull();
  // Never the name of the repository the text goes to.
  const same = await repo(msg, "a.txt", "plain\n", "git@github.com:acme/side-app.git");
  await sh(folder, "remote", "remove", "origin");
  expect(await held("git push origin main", same, deps(p([folder])), "s")).toBeNull();
});
