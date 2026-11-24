import { expect, test } from "bun:test";
import { allowedFor, allowedOnly, allows, checkRule, crossingText, EMPTY_RULE, firstAllowed, folderEntry, originOf, type RouteRule } from "./route-rule.ts";
import { seenBy } from "./route-seen.ts";

const HOME = "/home/o";
const rule: RouteRule = {
  default: ["bedrock"],
  folders: { "~/work/client": ["vertex"], "/srv/open": ["bedrock", "openai"], "/srv/open/secret/": ["bedrock"] },
};

test("no rule allows every provider, as before", () => {
  expect(allowedFor(EMPTY_RULE, ["/any/where"], HOME)).toBeNull();
  expect(allows(allowedFor(EMPTY_RULE, ["/any/where"], HOME), "openai")).toBe(true);
});

test("the deepest folder entry decides, else the default", () => {
  expect(folderEntry(rule, "/home/o/work/client/app", HOME)).toEqual({ providers: ["vertex"], by: "~/work/client" });
  expect(folderEntry(rule, "/srv/open/secret/x", HOME)).toEqual({ providers: ["bedrock"], by: "/srv/open/secret/" });
  expect(folderEntry(rule, "/srv/open", HOME)).toEqual({ providers: ["bedrock", "openai"], by: "/srv/open" });
  // A sibling whose name only starts the same is not under the entry.
  expect(folderEntry(rule, "/srv/openness", HOME)).toEqual({ providers: ["bedrock"], by: "default" });
  expect(folderEntry({ default: null, folders: { "/srv/open": ["openai"] } }, "/elsewhere", HOME)).toBeNull();
});

test("a session may use only what every folder of its chain allows", () => {
  // An agent working in a scratch folder (default: bedrock) for a session in /srv/open (bedrock, openai).
  const a = allowedFor(rule, ["/scratch/wt", "/srv/open/app"], HOME);
  expect(a).toEqual({ providers: ["bedrock"], by: ["default", "/srv/open"] });
  expect(allows(a, "openai")).toBe(false);
  // Folders that share nothing allow nothing.
  expect(allowedFor(rule, ["/home/o/work/client", "/srv/open"], HOME)?.providers).toEqual([]);
  // A folder no entry covers adds nothing when there is no default.
  expect(allowedFor({ default: null, folders: { "/srv/open": ["openai"] } }, ["/tmpx", "/srv/open"], HOME)?.providers).toEqual(["openai"]);
});

test("choices keep only allowed providers, in order", () => {
  const a = allowedFor(rule, ["/srv/open"], HOME);
  const models = [{ id: "vertex:m1", provider: "vertex" }, { id: "openai:m2", provider: "openai" }, { id: "bedrock:m3", provider: "bedrock" }];
  expect(allowedOnly(a, models).map((m) => m.id)).toEqual(["openai:m2", "bedrock:m3"]);
  expect(firstAllowed(a, [null, "vertex:judge", "bedrock:own"])).toBe("bedrock:own");
  expect(firstAllowed(a, ["vertex:judge"])).toBeUndefined();
});

test("what is said names the purpose, the provider and what happens instead", () => {
  const t = crossingText({ purpose: "reader", provider: "openai", model: "openai:small", by: ["/srv/open/secret/"], allowed: ["bedrock"] });
  expect(t).toContain("reader call to openai:small not sent");
  expect(t).toContain("provider openai is not allowed");
  expect(t).toContain("allowed: bedrock");
  expect(t).toContain("An allowed reader reads instead");
  expect(t.indexOf("Rule: /srv/open/secret/")).toBeGreaterThan(t.indexOf("reads instead"));
});

test("the setting is checked before it is saved", () => {
  expect(checkRule({ default: null, folders: {} })).toBeUndefined();
  expect(checkRule(rule)).toBeUndefined();
  expect(checkRule({ default: "bedrock", folders: {} })).toContain("default");
  expect(checkRule({ default: null, folders: { "relative/path": ["x"] } })).toContain("absolute");
  expect(checkRule({ default: null, folders: { "/a": ["bedrock:model"] } })).toContain("provider ids");
  expect(checkRule({ default: null, folders: [] })).toContain("folders");
});

test("the ledger's rows by folder and root session, agents folded in, crossings counted", () => {
  const sessions = [
    { id: "r1", workspace: "/srv/open/app", parent_id: null, title: "Open work" },
    { id: "k1", workspace: "/scratch/wt", parent_id: "r1", title: "Agent" },
    { id: "r2", workspace: "/home/o/work/client", parent_id: null, title: "Client" },
  ];
  const rows = [
    { session_id: "r1", purpose: "turn", provider: "openai", calls: 5, last_ms: 10 },
    { session_id: "r1", purpose: "reader", provider: "bedrock", calls: 2, last_ms: 11 },
    // The agent's chain allows bedrock only: its openai turns cross, the root's do not.
    { session_id: "k1", purpose: "turn", provider: "openai", calls: 3, last_ms: 12 },
    { session_id: "r2", purpose: "title", provider: "bedrock", calls: 1, last_ms: 13 },
    { session_id: "gone", purpose: "turn", provider: "openai", calls: 1, last_ms: 14 },
  ];
  const s = seenBy(rows, sessions, rule, HOME);
  expect(s.calls).toBe(12);
  expect(s.crossing).toBe(3 + 1 + 0); // agent's openai turns, the client's bedrock title; a removed session has no folder
  const open = s.folders.find((f) => f.folder === "/srv/open/app")!;
  expect(open.allowed).toEqual(["bedrock", "openai"]);
  expect(open.sessions).toHaveLength(1);
  expect(open.sessions[0]).toMatchObject({ id: "r1", agents: 1, calls: 10, crossing: 3 });
  expect(open.sessions[0]!.rows.find((r) => r.purpose === "turn")).toEqual({ purpose: "turn", provider: "openai", calls: 8, crossing: 3, last_ms: 12 });
  expect(open.providers).toEqual({ openai: 8, bedrock: 2 });
  const client = s.folders.find((f) => f.folder === "/home/o/work/client")!;
  expect(client).toMatchObject({ allowed: ["vertex"], by: "~/work/client", crossing: 1 });
  // With no rule nothing crosses.
  expect(seenBy(rows, sessions, EMPTY_RULE, HOME).crossing).toBe(0);
});

test("a worktree session holds its repository's folder, at the same place under it", () => {
  const wt = { repo_root: "/home/o/work/client", path: "/state/worktrees/client-abc123" };
  expect(originOf("/state/worktrees/client-abc123", wt)).toBe("/home/o/work/client");
  expect(originOf("/state/worktrees/client-abc123/pkg/a/", wt)).toBe("/home/o/work/client/pkg/a");
  // Moved back to the main checkout, or a folder that only starts the same: its own folder.
  expect(originOf("/home/o/work/client/pkg", wt)).toBe("/home/o/work/client/pkg");
  expect(originOf("/state/worktrees/client-abc1234", wt)).toBe("/state/worktrees/client-abc1234");
  expect(originOf("/x", undefined)).toBe("/x");
});

test("folders are compared as spelled: a link and its real path are one folder", () => {
  const links: Record<string, string> = { "/home/o/link": "/home/o/work/client" };
  const spell = (p: string) => Object.entries(links).reduce((v, [l, r]) => (v === l || v.startsWith(`${l}/`) ? r + v.slice(l.length) : v), p);
  expect(folderEntry(rule, "/home/o/link/app", HOME)).toEqual({ providers: ["bedrock"], by: "default" });
  expect(folderEntry(rule, "/home/o/link/app", HOME, spell)).toEqual({ providers: ["vertex"], by: "~/work/client" });
  // A rule written through the link holds the real folder too.
  const viaLink: RouteRule = { default: null, folders: { "~/link": ["vertex"] } };
  expect(allowedFor(viaLink, ["/home/o/work/client/app"], HOME, spell)?.providers).toEqual(["vertex"]);
});

test("the ledger holds a worktree session to its repository's folder, an agent's whose parent is gone too", () => {
  const sessions = [
    // The owner's own session in a worktree of Keel's, made from the client folder.
    { id: "w1", workspace: "/state/worktrees/client-aaa", parent_id: null, title: "Client wt", wt_root: "/home/o/work/client", wt_path: "/state/worktrees/client-aaa" },
    // An agent of a removed session, in its own worktree of the client repository.
    { id: "k2", workspace: "/state/worktrees/client-bbb/sub", parent_id: "removed", title: "Orphan agent", wt_root: "/home/o/work/client", wt_path: "/state/worktrees/client-bbb" },
  ];
  const rows = [
    { session_id: "w1", purpose: "turn", provider: "bedrock", calls: 4, last_ms: 1 },
    { session_id: "w1", purpose: "turn", provider: "vertex", calls: 2, last_ms: 2 },
    { session_id: "k2", purpose: "reader", provider: "bedrock", calls: 3, last_ms: 3 },
  ];
  const s = seenBy(rows, sessions, rule, HOME);
  // Read by their worktree folders they would fall to the default (bedrock) and count 2 crossing.
  expect(s.crossing).toBe(4 + 3);
  expect(s.folders.map((f) => f.folder).sort()).toEqual(["/home/o/work/client", "/home/o/work/client/sub"]);
  expect(s.folders.find((f) => f.folder === "/home/o/work/client")).toMatchObject({ allowed: ["vertex"], crossing: 4 });
});
