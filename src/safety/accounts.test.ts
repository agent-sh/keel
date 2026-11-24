// Writes with the owner's accounts beyond his namespaces: the matching alone, then the table of commands through the
// policy in every mode.
import { expect, test } from "bun:test";
import { foreign, ghBase, owned, parseNamespace, parseNamespaces, repoOf, writesOf, namedOwners, type Manifest, type Remotes } from "./accounts.ts";
import type { Looked } from "./looked.ts";
import { classify, decide, type CallClass, type Mode } from "./policy.ts";

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
    expect([url, repoOf(url)]).toEqual([url, me]);
  expect(repoOf("git@gitlab.com:g/sub/proj.git")).toEqual({ host: "gitlab.com", path: ["g", "sub", "proj"] });
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

const remotes = (fetch: Record<string, string>, more: Partial<Remotes> = {}): Remotes => ({ fetch, push: Object.fromEntries(Object.entries(fetch).map(([k, v]) => [k, [v]])), resolved: {}, ...more });
const mine = "https://github.com/me/repo.git", theirs = "https://github.com/them/lib.git";

test("gh acts on the repository it is told to, else the one it marked, else upstream before origin", () => {
  expect(ghBase(remotes({ origin: mine, upstream: theirs }))).toEqual({ host: "github.com", path: ["them", "lib"] });
  expect(ghBase(remotes({ origin: mine, upstream: theirs }, { resolved: { origin: "base" } }))).toEqual({ host: "github.com", path: ["me", "repo"] });
  expect(ghBase(remotes({ origin: mine, other: theirs }))).toEqual({ host: "github.com", path: ["me", "repo"] });
  expect(ghBase(remotes({}))).toBeNull();
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
};
const packages: Record<string, Manifest> = {
  "/w/own": { npm: "@me/tool", pypi: "metool", crates: "me-crate" },
  "/w/clone": { npm: "@them/tool", pypi: "theirtool", crates: "their-crate" },
  "/w/plain": { npm: "solo" },
};
const looked = (): Looked => ({
  kept: () => ({ n: 0 }), exists: () => "dir", targets: () => null, read: () => null,
  remotes: (d) => disk[d] ?? null, manifest: (d) => packages[d] ?? null,
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
  // gh
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
      }
    }
    // An agent is refused, told to report what it wanted to do.
    const a = run(command, cwd, "auto-edits", true);
    if (theirs === null) expect([command, "deny" in a && a.deny.includes("report")]).toEqual([command, false]);
    else {
      expect([command, how(a)]).toEqual([command, "deny"]);
      expect((a as { deny: string }).deny).toContain("Report to your parent");
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
  // No facts of the disk (a session on another machine): only the addresses a command spells out are read.
  const bare = { ...f, looked: undefined };
  expect(how(decide({ kind: "shell", command: "git push origin", cwd: "/w/clone" }, bare))).not.toBe("account");
  expect(how(decide({ kind: "shell", command: "git push git@github.com:them/lib.git", cwd: "/w/clone" }, bare))).toBe("account");
  // No list at all: the rule is not on (a tool that never supplies it).
  expect(how(decide({ kind: "shell", command: "git push git@github.com:them/lib.git", cwd: "/w/clone" }, { ...f, accounts: undefined }))).not.toBe("account");
  // An empty list names nothing as his: every write asks, and says so.
  const none = decide({ kind: "shell", command: "git push origin", cwd: "/w/own" }, facts("ask", false, []));
  expect((none as { ask: { why: string } }).ask.why).toContain("named no namespaces");
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
