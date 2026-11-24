import { expect, test } from "bun:test";
import { allowedFor, allowedOnly, allows, checkRule, crossingText, EMPTY_RULE, firstAllowed, folderEntry, type RouteRule } from "./route-rule.ts";
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
