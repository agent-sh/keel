// Writes with the owner's accounts beyond his namespaces: the matching alone, then the table of commands through the
// policy in every mode.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { foreign, ghBase, say, namespaceOf, owned, parseNamespace, parseNamespaces, repoOf, writesOf, namedOwners, type Manifest, type Remotes } from "./accounts.ts";
import type { Looked } from "./looked.ts";
import { accountContext, classify, decide, type CallClass, type Mode } from "./policy.ts";
import { PARTS_MAX, dirsOf, elseOf, unwrap } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

test("a namespace is read from the owner's words", () => {
  expect(parseNamespace("avifenesh")).toEqual({ kind: "forge", host: "github.com", path: ["avifenesh"] });
  expect(parseNamespace("GitHub.com/Agent-Sh")).toEqual({ kind: "forge", host: "github.com", path: ["agent-sh"] });
  expect(parseNamespace("gitlab.com/group/sub")).toEqual({ kind: "forge", host: "gitlab.com", path: ["group", "sub"] });
  expect(parseNamespace("https://git.example.org/team/")).toEqual({ kind: "forge", host: "git.example.org", path: ["team"] });
  expect(parseNamespace("npm:@Scope")).toEqual({ kind: "package", registry: "npm", name: "@scope" });
  expect(parseNamespace("pypi:tool")).toEqual({ kind: "package", registry: "pypi", name: "tool" });
  expect(parseNamespace("cargo:crate")).toEqual({ kind: "package", registry: "crates", name: "crate" });
  for (const bad of ["", "two words", "gitlab.com", "a*", "npm:", "x@y"]) expect([bad, parseNamespace(bad)]).toEqual([bad, null]);
});

test("a repository address is read in every form git takes", () => {
  const me = { host: "github.com", path: ["me", "repo"] };
  for (const url of ["https://github.com/me/repo.git", "https://github.com/me/repo", "https://user:tok@github.com/Me/Repo.git/", "ssh://git@github.com/me/repo.git", "ssh://git@github.com:22/me/repo", "git@github.com:me/repo.git", "github.com:me/repo", "git://github.com/me/repo.git", "git+https://github.com/me/repo.git"])
    expect([url, repoOf(url)]).toEqual([url, /^(ssh|git@|github\.com:)/.test(url) ? { ...me, ssh: true } : me]);
  expect(repoOf("git@gitlab.com:g/sub/proj.git")).toEqual({ host: "gitlab.com", path: ["g", "sub", "proj"], ssh: true });
  // A folder on this machine is no account.
  for (const dir of ["/srv/git/repo.git", "../repo", "./x", "file:///srv/x.git", "repo.git", "."]) expect([dir, repoOf(dir)]).toEqual([dir, null]);
});

test("a namespace holds what is under it, and nothing beside it", () => {
  const list = parseNamespaces(["me", "gitlab.com/g", "npm:@mine", "npm:solo", "pypi:tool"]);
  const forge = (host: string, ...path: string[]) => ({ kind: "forge" as const, host, path });
  const pkg = (registry: "npm" | "pypi" | "crates", name: string) => ({ kind: "package" as const, registry, name });
  expect(owned(list, forge("github.com", "me", "x"))).toBe(true);
  expect(owned(list, forge("github.com", "mex", "x"))).toBe(false);
  expect(owned(list, forge("gitlab.com", "g", "sub", "x"))).toBe(true);
  expect(owned(list, forge("gitlab.com", "me", "x"))).toBe(false);
  expect(owned(list, forge("example.com", "me", "x"))).toBe(false);
  expect(owned(list, pkg("npm", "@mine/a"))).toBe(true);
  expect(owned(list, pkg("npm", "@minefield/a"))).toBe(false);
  expect(owned(list, pkg("npm", "solo"))).toBe(true);
  expect(owned(list, pkg("npm", "solo2"))).toBe(false);
  expect(owned(list, pkg("pypi", "tool"))).toBe(true);
  expect(owned(list, pkg("crates", "tool"))).toBe(false);
});

test("the namespace a card's Mine adds holds the account it names, and parses back as one", () => {
  const forge = (host: string, ...path: string[]) => ({ kind: "forge" as const, host, path });
  const pkg = (registry: "npm" | "pypi" | "crates", name: string) => ({ kind: "package" as const, registry, name });
  for (const [a, said] of [
    [forge("github.com", "them", "lib"), "them"], [forge("github.com", "my.org", "lib"), "github.com/my.org"], [forge("gitlab.com", "g", "sub", "p"), "gitlab.com/g"],
    [forge("ghcr.io", "them", "img"), "ghcr.io/them"], [pkg("npm", "@them/tool"), "npm:@them"], [pkg("npm", "solo"), "npm:solo"], [pkg("pypi", "tool"), "pypi:tool"], [pkg("crates", "kb"), "crates:kb"],
  ] as const) {
    expect([say(a), namespaceOf(a)]).toEqual([say(a), said]);
    expect(owned([parseNamespace(namespaceOf(a))!], a)).toBe(true);
  }
});

test("an ssh name is looked up as a name and nothing else", async () => {
  const { hostnameOf } = await import("./looked.ts");
  for (const bad of ["-oProxyCommand=x", "a b", "", "x;y", "$(x)"]) expect([bad, await hostnameOf(bad)]).toEqual([bad, null]);
});

const remotes = (fetch: Record<string, string>, more: Partial<Remotes> = {}): Remotes => ({ fetch, push: Object.fromEntries(Object.entries(fetch).map(([k, v]) => [k, [v]])), resolved: {}, ...more });
const mine = "https://github.com/me/repo.git", theirs = "https://github.com/them/lib.git";

test("gh acts on the repository it is told to, else the one it marked, else upstream before origin", () => {
  expect(ghBase(remotes({ origin: mine, upstream: theirs }))).toEqual({ host: "github.com", path: ["them", "lib"] });
  expect(ghBase(remotes({ origin: mine, upstream: theirs }, { resolved: { origin: "base" } }))).toEqual({ host: "github.com", path: ["me", "repo"] });
  expect(ghBase(remotes({ origin: mine, other: theirs }))).toEqual({ host: "github.com", path: ["me", "repo"] });
  expect(ghBase(remotes({}))).toBeNull();
});

test("a push with no remote named goes where git's settings pick: a remote, or an address that is no remote's name", () => {
  const at = (r: Remotes) => writesOf(["git", "push"], { dir: "/w/x", remotes: () => r }).map((w) => (w.account ? say(w.account) : "unplaced"));
  expect(at(remotes({ origin: mine, upstream: theirs }, { pushDefault: "upstream" }))).toEqual(["github.com/them/lib"]);
  expect(at(remotes({ origin: mine, upstream: theirs }, { pushDefault: "upstream", branch: "main", branchPushRemote: "origin" }))).toEqual(["github.com/me/repo"]);
  expect(at(remotes({ origin: mine }, { pushDefault: theirs }))).toEqual(["github.com/them/lib"]);
  expect(at(remotes({ origin: mine }, { branch: "main", branchRemote: "git@github.com:them/lib.git" }))).toEqual(["github.com/them/lib"]);
  // A name that is no remote, or a folder: git does not go on to origin, and nothing is written with an account.
  expect(at(remotes({ origin: theirs }, { pushDefault: "gone" }))).toEqual([]);
  expect(at(remotes({ origin: theirs }, { branch: "main", branchPushRemote: "/srv/git/x.git" }))).toEqual([]);
});

test("an MCP call's input names the owner it acts for", () => {
  expect(namedOwners({ owner: "Me", repo: "x" })).toEqual(["me"]);
  expect(namedOwners({ repository: "them/lib", body: "x" })).toEqual(["them"]);
  expect(namedOwners({ args: { url: "https://github.com/a/b/pull/1" } })).toEqual(["a"]);
  expect(namedOwners({ channel: "general", text: "hi" })).toEqual([]);
});

// ---- the table: each command with the decision it gets ----

const ws = "/w/own";
const disk: Record<string, Remotes> = {
  "/w/own": remotes({ origin: mine }),
  "/w/fork": remotes({ origin: mine, upstream: theirs }),
  "/w/clone": remotes({ origin: theirs }, { branch: "main" }),
  "/w/ssh": remotes({ origin: "git@github.com:them/lib.git" }),
  "/w/local": remotes({ origin: "/srv/git/repo.git" }),
  "/w/two": remotes({ origin: mine, backup: "ssh://git@gitlab.com/them/backup.git" }, { pushDefault: "backup" }),
  // (Remotes by the ssh names of the owner's config: github-me stands for github.com, work for another host.)
  "/w/aliasme": remotes({ origin: "git@github-me:me/repo.git" }),
  "/w/aliaswork": remotes({ origin: "git@work:acme/repo.git" }),
};
const HOSTS: Record<string, string> = { "github-me": "github.com", work: "git.corp.example" };
const packages: Record<string, Manifest> = {
  "/w/own": { npm: "@me/tool", pypi: "metool", crates: "me-crate" },
  "/w/clone": { npm: "@them/tool", pypi: "theirtool", crates: "their-crate" },
  "/w/plain": { npm: "solo" },
};
const looked = (): Looked => ({
  kept: () => ({ n: 0 }), exists: () => "dir", targets: () => null, read: () => null,
  // (As the disk reads a folder: a `..` in it resolved. This one has no links.)
  remotes: (d) => disk[resolve(d)] ?? null, manifest: (d) => packages[resolve(d)] ?? null, hostname: (h) => HOSTS[h] ?? null,
});
const names = ["me", "ghcr.io/me", "npm:@me", "pypi:metool", "crates:me-crate", "npm:solo"];
const facts = (mode: Mode, agent = false, list = names) => ({ mode, workspace: ws, sandboxed: false, rules: [], tool: "t", home: "/home/u", looked: looked(), accounts: { names: parseNamespaces(list), ...(agent ? { agent: true as const } : {}) } });
const how = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : d.ask.account !== undefined ? "account" : d.ask.ownerOnly ? "owner" : `ask-${d.ask.risk}`);
const run = (command: string, cwd: string, mode: Mode = "ask", agent = false) => decide({ kind: "shell", command, cwd }, facts(mode, agent));

// [command, folder, foreign namespace named on the card or null for an ordinary command]
const TABLE: [string, string, string | null][] = [
  // git push: addresses
  ["git push https://github.com/me/repo.git main", "/w/own", null],
  ["git push https://github.com/them/lib.git main", "/w/own", "github.com/them/lib"],
  ["git push ssh://git@github.com/them/lib.git HEAD", "/w/own", "github.com/them/lib"],
  ["git push git@github.com:them/lib.git HEAD", "/w/own", "github.com/them/lib"],
  ["git push git@github.com:me/repo.git HEAD", "/w/own", null],
  ["git push --repo=git@github.com:them/lib.git", "/w/own", "github.com/them/lib"],
  ["git push -u git@gitlab.com:me/repo.git main", "/w/own", "gitlab.com/me/repo"],
  // git push: names and defaults
  ["git push origin main", "/w/own", null],
  ["git push", "/w/own", null],
  ["git push origin main", "/w/clone", "github.com/them/lib"],
  ["git push", "/w/clone", "github.com/them/lib"],
  ["git push -f origin main", "/w/ssh", "github.com/them/lib"],
  ["git push upstream HEAD:main", "/w/fork", "github.com/them/lib"],
  ["git push origin HEAD", "/w/fork", null],
  ["git push", "/w/two", "gitlab.com/them/backup"],
  ["git push origin main", "/w/local", null],
  ["git push /srv/git/other.git main", "/w/own", null],
  ["cd /w/clone && git push", "/w/own", "github.com/them/lib"],
  ["git -C /w/clone push origin main", "/w/own", "github.com/them/lib"],
  ["GIT_TERMINAL_PROMPT=0 git push upstream", "/w/fork", "github.com/them/lib"],
  ["git commit -m x && git push", "/w/clone", "github.com/them/lib"],
  ["bash -c 'git push upstream'", "/w/fork", "github.com/them/lib"],
  // ssh names of the owner's config stand for the host they say
  ["git push", "/w/aliasme", null],
  ["git push origin main", "/w/aliasme", null],
  ["git push git@github-me:me/repo.git", "/w/own", null],
  ["git push git@github-me:them/lib.git", "/w/own", "github.com/them/lib"],
  ["git push", "/w/aliaswork", "git.corp.example/acme/repo"],
  // a line that changes where a remote points, then pushes: where it lands is not known
  ["git config remote.origin.url https://github.com/them/lib.git && git push", "/w/own", ""],
  ["git remote set-url origin https://github.com/them/lib.git && git push origin", "/w/own", "github.com/them/lib"],
  ["git remote set-url origin https://github.com/them/lib.git && git push", "/w/own", "github.com/them/lib"],
  ["git remote set-url origin https://github.com/me/repo.git && git push", "/w/clone", null],
  ["git remote add loc /srv/git/x.git && git push loc HEAD:main", "/w/clone", null],
  ["git remote add loc $X && git push loc HEAD:main", "/w/clone", ""],
  ["git remote add loc $PWD/x.git; git push loc HEAD:main", "/w/clone", null],
  ["git push $PWD/x.git HEAD:main", "/w/clone", null],
  ["git remote rename origin x && git push x", "/w/clone", ""],
  ["git remote add up https://github.com/them/lib.git && gh pr create --fill", "/w/own", ""],
  ["git -c remote.origin.pushurl=https://github.com/them/lib.git push", "/w/own", ""],
  ["git -c url.https://github.com/them/.insteadOf=https://github.com/me/ push", "/w/own", ""],
  ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl GIT_CONFIG_VALUE_0=https://github.com/them/lib.git git push", "/w/own", ""],
  ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.pushurl GIT_CONFIG_VALUE_0=https://github.com/them/lib.git; git push", "/w/own", ""],
  ["git remote add evil https://github.com/them/lib.git && git push evil", "/w/own", "github.com/them/lib"],
  ["gh repo set-default them/lib && gh pr create --fill", "/w/own", ""],
  // other ways to name the folder or the line
  ["git --git-dir=/w/clone/.git push", "/w/own", "github.com/them/lib"],
  ["git --git-dir /w/own/.git push", "/w/clone", null],
  ["bash -lc 'git -C /w/clone push'", "/w/own", "github.com/them/lib"],
  ["bash -ic \"git push\"", "/w/clone", "github.com/them/lib"],
  ["eval 'git push'", "/w/clone", "github.com/them/lib"],
  ["eval git push", "/w/clone", "github.com/them/lib"],
  ["sudo -u x bash -lc 'git push'", "/w/clone", "github.com/them/lib"],
  // gh
  ["export GH_REPO=them/lib; gh pr create --fill", "/w/own", "github.com/them/lib"],
  ["export GH_REPO=them/lib && cd /w/own && gh issue comment 3 -b x", "/w/own", "github.com/them/lib"],
  ["export GH_REPO=me/repo; gh pr create --fill", "/w/clone", null],
  ["export GH_REPO=them/lib; unset GH_REPO; gh pr create --fill", "/w/own", null],
  ["GH_REPO=them/lib; gh pr create --fill", "/w/own", null],
  ["GH_REPO=them/lib; export GH_REPO; gh pr create --fill", "/w/own", "github.com/them/lib"],
  ["gh pr create -R them/lib --title x", "/w/own", "github.com/them/lib"],
  ["gh pr create --repo me/repo --title x", "/w/own", null],
  ["gh pr create --fill", "/w/fork", "github.com/them/lib"],
  ["gh pr create --fill", "/w/own", null],
  ["gh pr review 5 --approve -R them/lib", "/w/own", "github.com/them/lib"],
  ["gh pr review https://github.com/them/lib/pull/5 --comment -b ok", "/w/own", "github.com/them/lib"],
  ["gh issue comment 3 -b hi -R them/lib", "/w/own", "github.com/them/lib"],
  ["gh issue comment 3 -b hi", "/w/own", null],
  ["gh release create v1 -R them/lib", "/w/own", "github.com/them/lib"],
  ["gh release create v1", "/w/own", null],
  ["gh pr merge 5 --squash -R github.com/them/lib", "/w/own", "github.com/them/lib"],
  ["gh api -X POST repos/them/lib/issues -f title=x", "/w/own", "github.com/them/lib"],
  ["gh api repos/me/repo/issues -f title=x", "/w/own", null],
  ["GH_REPO=them/lib gh issue close 4", "/w/own", "github.com/them/lib"],
  // publishes
  ["npm publish", "/w/own", null],
  ["npm publish --access public", "/w/clone", "npm:@them/tool"],
  ["pnpm publish", "/w/clone", "npm:@them/tool"],
  ["npm publish", "/w/plain", null],
  ["npm publish", "/w/empty", null],
  ["npm unpublish @them/tool@1.0.0", "/w/own", "npm:@them/tool"],
  ["cargo publish", "/w/own", null],
  ["cargo publish", "/w/clone", "crates:their-crate"],
  ["cargo publish -p other", "/w/own", "crates:other"],
  ["twine upload dist/*", "/w/own", null],
  ["twine upload dist/*", "/w/clone", "pypi:theirtool"],
  ["uv publish", "/w/clone", "pypi:theirtool"],
  ["docker push ghcr.io/them/img:1", "/w/own", "ghcr.io/them/img"],
  ["docker push ghcr.io/me/img:1", "/w/own", null],
  ["docker buildx build --push -t ghcr.io/them/img:1 .", "/w/own", "ghcr.io/them/img"],
  ["docker build -t ghcr.io/them/img --push .", "/w/own", "ghcr.io/them/img"],
  ["docker buildx build --push -t ghcr.io/me/img .", "/w/own", null],
  ["docker buildx build -t ghcr.io/them/img .", "/w/own", null],
  ["docker buildx build --push .", "/w/own", ""],
  ["docker compose push", "/w/own", ""],
  ["docker image push ghcr.io/them/img", "/w/own", "ghcr.io/them/img"],
  ["docker manifest push ghcr.io/them/img:1", "/w/own", "ghcr.io/them/img"],
  ["podman push ghcr.io/them/img", "/w/own", "ghcr.io/them/img"],
  ["skopeo copy docker://ghcr.io/me/img docker://ghcr.io/them/img", "/w/own", "ghcr.io/them/img"],
  ["uvx twine upload dist/*", "/w/clone", "pypi:theirtool"],
  ["uvx --from twine twine upload dist/*", "/w/clone", "pypi:theirtool"],
  ["pipx run twine upload dist/*", "/w/clone", "pypi:theirtool"],
  ["python3 -m twine upload dist/*", "/w/clone", "pypi:theirtool"],
  // reads and ordinary commands stay as they were
  ["git pull", "/w/clone", null],
  ["git fetch upstream", "/w/fork", null],
  ["git push --dry-run", "/w/local", null],
  ["gh pr view 5 -R them/lib", "/w/own", null],
  ["gh pr list -R them/lib", "/w/own", null],
  ["gh issue view 3 --repo them/lib --comments", "/w/own", null],
  ["gh api repos/them/lib/issues", "/w/own", null],
  ["gh api -X GET repos/them/lib/issues", "/w/own", null],
  ["gh repo clone them/lib", "/w/own", null],
  ["gh pr checkout 5", "/w/fork", null],
  ["npm install", "/w/clone", null],
  ["npm test", "/w/clone", null],
  ["npm pack", "/w/clone", null],
  ["cargo build", "/w/clone", null],
  ["git remote -v", "/w/clone", null],
];

// The rows whose target is read from the repository's own remotes (by name, or by default), not named by the command.
const OWN = new Set<string>([
  "/w/clone git push origin main",
  "/w/clone git push",
  "/w/ssh git push -f origin main",
  "/w/fork git push upstream HEAD:main",
  "/w/two git push",
  "/w/own cd /w/clone && git push",
  "/w/own git -C /w/clone push origin main",
  "/w/fork GIT_TERMINAL_PROMPT=0 git push upstream",
  "/w/clone git commit -m x && git push",
  "/w/fork bash -c 'git push upstream'",
  "/w/aliaswork git push",
  "/w/own git --git-dir=/w/clone/.git push",
  "/w/own bash -lc 'git -C /w/clone push'",
  "/w/clone bash -ic \"git push\"",
  "/w/clone eval 'git push'",
  "/w/clone eval git push",
  "/w/clone sudo -u x bash -lc 'git push'",
  "/w/fork gh pr create --fill",
]);

test("a table of commands: a write beyond the owner's namespaces asks him in every mode and names the namespace", () => {
  const rows: string[] = [];
  for (const [command, cwd, theirs] of TABLE) {
    for (const mode of ["ask", "auto-edits", "auto", "reviewer", "full-auto"] as Mode[]) {
      const d = run(command, cwd, mode);
      if (theirs === null) {
        expect([command, cwd, mode, how(d) === "account"]).toEqual([command, cwd, mode, false]);
      } else {
        expect([command, cwd, mode, how(d)]).toEqual([command, cwd, mode, "account"]);
        const ask = (d as { ask: { why: string; account: string; ownerOnly?: true } }).ask;
        expect([command, ask.account]).toEqual([command, theirs]);
        expect(ask.why).toContain(theirs);
        expect(ask.ownerOnly).toBe(true);
        // The card's "Mine" names a namespace that is a namespace, when the rules know whose it is.
        const mine = (d as { ask: { mine?: string } }).ask.mine;
        expect([command, mine === undefined ? theirs === "" : parseNamespace(mine) !== null]).toEqual([command, true]);
      }
    }
    // An agent is refused, told to report what it wanted to do.
    const a = run(command, cwd, "auto-edits", true);
    if (theirs === null) expect([command, "deny" in a && a.deny.includes("report")]).toEqual([command, false]);
    else if (OWN.has(`${cwd} ${command}`)) {
      // (A push or a gh write to where a remote of the repository the agent works in points waits for the owner, who can say Mine.)
      expect([command, how(a)]).toEqual([command, "account"]);
      expect((a as { ask: { why: string; mine?: string } }).ask.why).toContain("An agent's write");
      expect((a as { ask: { mine?: string } }).ask.mine).toBeDefined();
    } else {
      expect([command, how(a)]).toEqual([command, "deny"]);
      expect((a as { deny: string }).deny).toContain("Report to your parent");
      expect((a as { deny: string }).deny).toContain("Your accounts");
    }
    rows.push(`${theirs === null ? "ordinary" : "owner   "}  ${cwd}  ${command}`);
  }
  expect(TABLE.length).toBeGreaterThanOrEqual(30);
  expect(rows.length).toBe(TABLE.length);
});

test("a standing rule does not cover it, and Read only still refuses the command as before", () => {
  const rule = { id: "r", kind: "shell" as const, pattern: "git push *", scope: ws, lifetime: "always" as const, created: 0 };
  const d = decide({ kind: "shell", command: "git push upstream main", cwd: "/w/fork" }, { ...facts("ask"), rules: [rule] });
  expect(how(d)).toBe("account");
  expect((d as { ask: { notice?: string } }).ask.notice).toContain("does not cover");
  expect(how(decide({ kind: "shell", command: "git push upstream main", cwd: "/w/fork" }, facts("read-only")))).not.toBe("account");
  // A rule covers the push to a namespace of his, as before.
  expect(how(decide({ kind: "shell", command: "git push origin main", cwd: "/w/fork" }, { ...facts("ask"), rules: [rule] }))).toBe("allow");
});

test("what the rules cannot place asks: a folder they cannot follow, an answer that is late, a name with an expansion", () => {
  const f = facts("ask");
  expect(how(decide({ kind: "shell", command: "cd $X && git push", cwd: "/w/own" }, f))).toBe("account");
  expect(how(decide({ kind: "shell", command: "git push $REMOTE main", cwd: "/w/own" }, f))).toBe("account");
  expect(how(decide({ kind: "shell", command: "git push origin", cwd: "/w/own" }, { ...f, looked: { ...looked(), remotes: () => "late" } }))).toBe("account");
  // No facts of the disk (a session on another machine): a push by a remote's name or by default is not placed, so it asks;
  // the addresses a command spells out are read as before, and a folder with nothing to publish still asks nothing of a reader.
  const bare = { ...f, looked: undefined };
  expect(how(decide({ kind: "shell", command: "git push origin", cwd: "/w/clone" }, bare))).toBe("account");
  expect(how(decide({ kind: "shell", command: "git push", cwd: "/w/clone" }, { ...bare, mode: "full-auto" }))).toBe("account");
  expect(how(decide({ kind: "shell", command: "gh pr create --fill", cwd: "/w/clone" }, { ...bare, mode: "full-auto" }))).toBe("account");
  expect(how(decide({ kind: "shell", command: "git push https://github.com/me/repo.git", cwd: "/w/clone" }, bare))).not.toBe("account");
  expect(how(decide({ kind: "shell", command: "git status", cwd: "/w/clone" }, bare))).not.toBe("account");
  expect(how(decide({ kind: "shell", command: "git push git@github.com:them/lib.git", cwd: "/w/clone" }, bare))).toBe("account");
  // No list at all: the rule is not on (a tool that never supplies it).
  expect(how(decide({ kind: "shell", command: "git push git@github.com:them/lib.git", cwd: "/w/clone" }, { ...f, accounts: undefined }))).not.toBe("account");
  // An empty list names nothing as his: every write asks, and says so.
  const none = decide({ kind: "shell", command: "git push origin", cwd: "/w/own" }, facts("ask", false, []));
  expect((none as { ask: { why: string } }).ask.why).toContain("named no namespaces");
});

// A folder the line names with a shell variable, $HOME or a substitution is not a folder the rules place a write by: what
// the shell makes of the word is the shell's to say (a name set twice, in a branch, by eval, read or a loop), so the write is
// the owner's, his own repository included. A folder written out is followed, a relative one from the folder it runs in.
test("a write behind a folder spelled with a variable or a substitution is not placed; a written-out folder is", () => {
  const where = (command: string, cwd = "/w/own") => {
    const d = run(command, cwd, "ask");
    return how(d) === "account" ? ((d as { ask: { account: string } }).ask.account || "unplaced") : null;
  };
  const rows: [string, string | null, string?][] = [
    ["cd /w/own && cd ../clone && git push", "github.com/them/lib"],
    ["git -C ../clone push", "github.com/them/lib"],
    ["git -C ../own push", null, "/w/clone"],
    ["git -C /w -C clone push", "github.com/them/lib"],
    ['D=/w/own; cd "$D" && git push', "unplaced"],
    ["D=/w/own; cd $D && git push origin main", "unplaced"],
    ['D=/w/clone; cd "$D" && git push', "unplaced"],
    ['export WT=/w/own && cd "${WT}" && git push', "unplaced"],
    ['D=/w/own; git -C "$D" push', "unplaced"],
    ["cd $HOME/work/own && git push", "unplaced"],
    ['cd "${HOME}/work/own" && git push', "unplaced"],
    ["git -C $HOME/work/own push", "unplaced"],
    ['cd "$(git rev-parse --show-toplevel)" && git push', "unplaced"],
    ['git -C "$(git rev-parse --show-toplevel)" push', "unplaced"],
    ['cd "$ELSEWHERE" && git push', "unplaced"],
    ["D=/w/own; D=/w/clone; cd $D && git push", "unplaced"],
  ];
  for (const [command, want, cwd] of rows) expect([command, where(command, cwd)]).toEqual([command, want]);
  // The judge is told the same.
  expect(accountContext('D=/w/own; cd "$D" && git push', "/w/own", looked(), parseNamespaces(names), "/home/u")).toContain("where it lands is unknown");
});

// A cd says where the shell goes only when it works. What runs after one that may have failed (not joined by &&) also
// runs where the shell was; a folder the line moves to that holds no repository or manifest now may be filled by the line
// itself; and a cd with more than one operand, a relative one beside CDPATH, an eval of one or a turn of pushd's stack
// lands where the rules cannot tell. Each is the owner's write, never no write.
test("a write after a cd that may not land where it says is placed where the shell may be, or not placed", () => {
  const where = (command: string, cwd = "/w/own") => {
    const d = run(command, cwd, "ask");
    return how(d) === "account" ? ((d as { ask: { account: string } }).ask.account || "unplaced") : null;
  };
  const rows: [string, string | null, string?][] = [
    // Joined by &&: the folder it names, and nothing else.
    ["cd /w/own && git push", null, "/w/clone"],
    ["(cd /w/own && git push)", null, "/w/clone"],
    ["cd /w/own || exit 1; git push", null, "/w/clone"],
    ["cd /w/own || return; git push", "github.com/them/lib", "/w/clone"],
    ["cd /w/own\ngit add -A\ngit push", null, "/w/fork"],
    // Not joined by &&: the folder before it counts too.
    ["cd /w/own; git push", "github.com/them/lib", "/w/clone"],
    ["cd /w/own\ngit push", "github.com/them/lib", "/w/clone"],
    ["cd /w/own && git add .; git push", "github.com/them/lib", "/w/clone"],
    ["cd /w/own | cat; git push", "github.com/them/lib", "/w/clone"],
    ["cd /w/own; cd /w/fork; git push", "github.com/them/lib", "/w/clone"],
    ["cd /w/own; npm publish", "npm:@them/tool", "/w/clone"],
    // A cd the shell may pass over or make in a shell of its own, the push joined to it by &&: the folder before it counts.
    ["true || cd /w/own && git push", "github.com/them/lib", "/w/clone"],
    ["test -d .git || cd /w/own && git add -A && git push", "github.com/them/lib", "/w/clone"],
    ["(true) || cd /w/own && git push", "github.com/them/lib", "/w/clone"],
    ["{ true; } || cd /w/own && git push", "github.com/them/lib", "/w/clone"],
    ["true ||\n\ncd /w/own && git push", "github.com/them/lib", "/w/clone"],
    ["true | cd /w/own && git push", "github.com/them/lib", "/w/clone"],
    ["! cd /w/own && git push", "github.com/them/lib", "/w/clone"],
    ["true || cd /w/own && bash -c 'git push'", "unplaced", "/w/clone"],
    ["true && cd /w/own && git push", null, "/w/clone"],
    ["true; cd /w/own && git push", null, "/w/clone"],
    // A folder with nothing in it now, reached by the line: not placed. Where the line started, it is no write.
    ["cd /w/nowhere; git push", "unplaced", "/w/clone"],
    ["cd /w/nowhere && git push", "unplaced"],
    ["git clone https://github.com/them/lib.git /w/new && cd /w/new && git push", "unplaced"],
    ["git -C /w/nowhere push", "unplaced"],
    ["cd /w/nowhere && gh pr create --fill", "unplaced"],
    ["cd /w/nowhere && npm publish", "unplaced"],
    ["bash -c 'cd /w/nowhere; git push'", "unplaced", "/w/clone"],
    ["git push", null, "/w/nowhere"],
    ["npm publish", null, "/w/nowhere"],
    // A cd the shell may read another way.
    ["cd /w/own extra 2>/dev/null; git push", "unplaced", "/w/clone"],
    ["cd /w/own extra && git push", "unplaced", "/w/clone"],
    ["CDPATH=/w/clone; cd sub && git push", "unplaced"],
    ["export CDPATH=/w; cd own && git push", "unplaced", "/w/clone"],
    ["CDPATH=/w; cd ./sub && git push", "unplaced"],
    ["eval 'cd /w/clone'; git push", "unplaced"],
    ["pushd /w/own && pushd && git push", "unplaced", "/w/clone"],
    ["cd /w/own; cd sub; git push", "unplaced", "/w/clone"],
    // A relative cd that may run more than once.
    ["for i in 1 2; do cd ../own && git push; done", "unplaced", "/w/clone"],
    ["f() { cd ../own; }; f; f; git push", "unplaced", "/w/clone"],
    ["for i in 1 2; do cd /w/own && git push; done", null, "/w/clone"],
  ];
  for (const [command, want, cwd] of rows) expect([command, where(command, cwd)]).toEqual([command, want]);
  // The card says which folder the write is in.
  const d = run("cd /w/own; git push", "/w/clone", "full-auto") as { ask: { why: string } };
  expect(d.ask.why).toContain("in /w/clone, where the line is if a cd before it fails");
});

// A `..` after a link leaves the link's target on the disk, and the link in the shell's own words. git -C changes folder
// through the disk: its folder is asked of the disk as written (src/core/git.ts resolves it part by part). A cd follows
// the words unless the line asks for real folders (cd -P, set -P): then a `..` is not followed at all.
test("a folder with a .. in it is asked of the disk as written, and not followed where the shell would walk the real folders", () => {
  const asked: string[] = [];
  const f = { ...facts("ask"), looked: { ...looked(), remotes: (d: string) => { asked.push(d); return disk[resolve(d)] ?? null; } } };
  const where = (command: string, cwd = "/w/own") => {
    const d = decide({ kind: "shell", command, cwd }, f);
    return how(d) === "account" ? ((d as { ask: { account: string } }).ask.account || "unplaced") : null;
  };
  expect(where("git -C link/.. push")).toBeNull();
  expect(asked).toContain("/w/own/link/..");
  expect(where("git -C /w/own/link/.. push")).toBeNull();
  expect(asked).toContain("/w/own/link/..");
  expect(where("cd link && git -C .. push")).toBeNull();
  expect(asked).toContain("/w/own/link/..");
  expect(where("git -C link -C .. push")).toBeNull();
  expect(asked).toContain("/w/own/link/..");
  // The shell's own cd walks the words.
  expect(where("cd link/.. && git push")).toBeNull();
  expect(asked.at(-1)).toBe("/w/own");
  for (const c of ["cd -P link/.. && git push", "set -P; cd link/.. && git push", "set -o physical; cd link/.. && git push", "cd -P link && cd .. && git push", "cd link && cd -P .. && git push", "cd -LP link/.. && git push"]) expect([c, where(c)]).toEqual([c, "unplaced"]);
  // (Real folders asked for, and no `..`: the folder the words name.)
  expect(where("cd -P /w/clone && git push")).toBe("github.com/them/lib");
  // Asked of the shell that runs a script by what starts it, and a CDPATH given to it: the script's own words show neither.
  for (const c of ["bash -P -c 'cd link/.. && git push'", "bash -o physical -c 'cd link/.. && git push'", "bash -eP -c 'cd link/.. && git push'", "SHELLOPTS=physical bash -c 'cd link/.. && git push'",
    "env SHELLOPTS=physical bash -c 'cd link/.. && git push'", "CDPATH=/w/clone bash -c 'cd inner && git push'", "env CDPATH=/w/clone bash -c 'cd inner && git push'", "export CDPATH=/w/clone; bash -c 'cd inner && git push'"]) expect([c, where(c)]).toEqual([c, "unplaced"]);
  expect(where("bash -c 'cd link/.. && git push'")).toBeNull();
  expect(where("bash -c 'cd /w/own && git push'", "/w/clone")).toBeNull();
});

// --git-dir names the repository itself: a -C before or after it changes the folder a relative one is read from, not the
// repository. A command xargs or parallel feeds takes its last words from another command's output, and find -execdir
// runs its command in the folder of what it found: neither is placed by the words the line spells.
test("--git-dir stands whatever -C says, and a write another command's output feeds is not placed", () => {
  const where = (command: string, cwd = "/w/own") => {
    const d = run(command, cwd, "ask");
    return how(d) === "account" ? ((d as { ask: { account: string } }).ask.account || "unplaced") : null;
  };
  const rows: [string, string | null, string?][] = [
    ["git --git-dir=/w/clone/.git -C /w/own push", "github.com/them/lib"],
    ["git --git-dir /w/clone/.git -C /w/own push origin main", "github.com/them/lib"],
    ["git -C /w/own --git-dir=/w/clone/.git push", "github.com/them/lib", "/w/fork"],
    ["git --git-dir=.git -C /w/clone push", "github.com/them/lib"],
    ["git -C /w --git-dir clone/.git push", "github.com/them/lib"],
    ["git --git-dir=/w/own/.git -C /w/clone push", null, "/w/clone"],
    ["git --git-dir=$D/.git -C /w/own push", "unplaced"],
    ["echo x | xargs git push", "unplaced"],
    ["echo x | xargs git -C /w/own push origin", "unplaced"],
    ["echo push | xargs git", "unplaced"],
    ["echo x | xargs -I{} git push {} main", "unplaced"],
    ["echo x | parallel git push", "unplaced"],
    ["echo 5 | xargs gh pr comment -b hi", "unplaced"],
    ["echo pkg | xargs npm publish", "unplaced"],
    ["git ls-files | xargs git add", null],
    ["ls | xargs npm test", null],
    ["find /w/clone -maxdepth 0 -execdir git push \\;", "unplaced"],
    ["find . -maxdepth 0 -exec git push \\;", null],
  ];
  for (const [command, want, cwd] of rows) expect([command, where(command, cwd)]).toEqual([command, want]);
  expect((run("echo x | xargs git push", "/w/own", "ask") as { ask: { why: string } }).ask.why).toContain("another command's output");
});

// What one decision costs is bounded: a chain of relative cds that passes the longest path there is leaves the shell
// somewhere the rules cannot name, and no folder is carried past it; a script handed to a shell or to eval is read only
// when it holds no more commands than a whole line may.
test("a long chain of cds carries no folder past the longest path, and a script of too many commands is not read", () => {
  const parts = splitCommand("cd x; ".repeat(6_000) + "git push")!;
  const runs = parts.map((p) => unwrap(p.words));
  const or = elseOf(parts, runs, dirsOf(parts, runs, "/w/own", "/home/u"));
  expect(or[1]).toEqual(["/w/own"]);
  expect(or[5_000]).toEqual([null]);
  expect(or.at(-1)).toEqual([null]);
  const where = (command: string) => {
    const d = run(command, "/w/own", "ask");
    return how(d) === "account" ? (d as { ask: { account: string; why: string } }).ask : null;
  };
  expect(where(`eval "${"true; ".repeat(100)}git push"`)).toBeNull();
  const long = where(`eval "${"true; ".repeat(PARTS_MAX)}git push"`);
  expect(long?.account).toBe("");
  expect(long?.why).toContain(`holds ${PARTS_MAX + 1} commands`);
  expect(where(`bash -c '${"true; ".repeat(PARTS_MAX)}git push'`)?.account).toBe("");
  // (Nothing in it writes with an account: nothing is asked for it.)
  expect(where(`eval "${"true; ".repeat(PARTS_MAX + 5)}"`)).toBeNull();
});

// A config file the line has git read, a setting it takes from the environment, and the keys that pick the remote of a
// push by default: each can send a push by name or by default somewhere the repository's remotes do not say.
test("a line that has git read another config file, or sets which remote a push goes to, is not placed by the remotes on disk", () => {
  const where = (command: string, cwd = "/w/own") => {
    const d = run(command, cwd, "ask");
    return how(d) === "account" ? ((d as { ask: { account: string } }).ask.account || "unplaced") : null;
  };
  for (const c of [
    "git -c include.path=/w/other.config push",
    "git -c Include.Path=/w/other.config push origin main",
    "git -c includeIf.gitdir:/w/.path=/w/other.config push",
    "git config include.path /w/other.config && git push",
    "git config --local --add include.path /w/other.config; git push origin main",
    "git config set include.path /w/other.config && git push",
    "git config -f .git/config include.path /w/other.config && git push",
    "git config 'includeIf.gitdir:/w/.path' /w/other.config && git push",
    "X=/w/other.config git --config-env=include.path=X push",
    "git --config-env remote.origin.url=X push",
    "git -c remote.pushDefault=backup push",
    "git config branch.main.pushRemote backup && git push",
    "git config branch.main.remote backup; git push",
    "git config include.path /w/other.config && gh pr create --fill",
    // Another HOME or XDG_CONFIG_HOME is another file of the owner's own settings, with its own url rewrites.
    "HOME=/w/other git push",
    "export HOME=/w/other; git push origin main",
    "XDG_CONFIG_HOME=/w/xdg git push",
    "export XDG_CONFIG_HOME=/w/xdg && git push",
    "env XDG_CONFIG_HOME=/w/xdg git push",
    "bash -c 'HOME=/w/other git push'",
  ]) expect([c, where(c)]).toEqual([c, "unplaced"]);
  // An address the push spells out is not placed either: the file can rewrite it (url.*.insteadOf).
  expect(where("git -c include.path=/w/other.config push https://github.com/me/repo.git main")).toBe("unplaced");
  // A line with no write asks nothing.
  expect(where("git config --get include.path; git status")).toBeNull();
});

// ---- an MCP tool that writes with an account its server holds ----

const mcpTool = { name: "slack__post", readOnly: false };
const mcp = (account: { server: string; input?: unknown } | undefined, mode: Mode, agent = false) =>
  decide({ kind: "other", ...(account ? { account } : {}) } as CallClass, { ...facts(mode, agent), tool: "slack__post" });

test("an MCP tool that writes with an account its server holds asks in every mode unless the call names an owner of his", () => {
  expect(mcpTool.readOnly).toBe(false);
  for (const mode of ["ask", "auto-edits", "auto", "reviewer", "full-auto"] as Mode[]) {
    const d = mcp({ server: "slack", input: { channel: "general", text: "hi" } }, mode);
    expect([mode, how(d)]).toEqual([mode, "account"]);
    expect((d as { ask: { why: string } }).ask.why).toContain("slack");
    expect([mode, how(mcp({ server: "github", input: { owner: "them", repo: "lib" } }, mode))]).toEqual([mode, "account"]);
    // His own namespace: judged as any other tool.
    expect([mode, how(mcp({ server: "github", input: { owner: "me", repo: "repo" } }, mode)) === "account"]).toEqual([mode, false]);
  }
  expect(how(mcp({ server: "slack" }, "ask", true))).toBe("deny");
  expect((mcp({ server: "slack" }, "ask", true) as { deny: string }).deny).toContain("Report to your parent");
  // A server that holds no account is what it was.
  expect(how(mcp(undefined, "full-auto"))).toBe("allow");
  expect(how(mcp(undefined, "ask"))).toBe("ask-low");
});

test("a command's writes are listed for the judge", async () => {
  const { accountFacts } = await import("./accounts.ts");
  const w = writesOf(["git", "push", "upstream"], { dir: "/w/fork", remotes: (d) => disk[d] ?? null });
  expect(accountFacts(w, parseNamespaces(names))).toContain("NOT under the owner's namespaces");
  expect(foreign(parseNamespaces(names), w)?.account).toEqual({ kind: "forge", host: "github.com", path: ["them", "lib"] });
  expect(classify({ name: "Bash", readOnly: false, kind: "shell" }, { command: "git push" }, "/w").kind).toBe("shell");
});

test("an ssh name is asked once at a time, and an answer that came late is not asked for again at once", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hostnameOf, forgetHosts } = await import("./looked.ts");
  const dir = mkdtempSync(join(tmpdir(), "ssh-g-"));
  const count = join(dir, "count");
  const fake = join(dir, "ssh");
  // A stand-in for ssh: it counts its runs, then answers (the name "slowname" takes longer than the rules wait).
  writeFileSync(fake, `#!/bin/sh\necho x >> ${count}\ncase "$2" in slowname) sleep 4;; *) sleep 0.3;; esac\necho "hostname real.example"\n`);
  chmodSync(fake, 0o755);
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  const runs = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  try {
    forgetHosts();
    const three = await Promise.all([hostnameOf("alias-a"), hostnameOf("alias-a"), hostnameOf("alias-a")]);
    expect(three).toEqual(["real.example", "real.example", "real.example"]);
    expect(runs()).toBe(1);
    expect(await hostnameOf("alias-a")).toBe("real.example");
    expect(runs()).toBe(1);
    const slow = await Promise.all([hostnameOf("slowname"), hostnameOf("slowname")]);
    expect(slow).toEqual(["late", "late"]);
    expect(runs()).toBe(2);
    expect(await hostnameOf("slowname")).toBe("late");
    expect(runs()).toBe(2);
  } finally {
    process.env.PATH = was;
    forgetHosts();
    rmSync(dir, { recursive: true, force: true });
  }
});
