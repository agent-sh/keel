import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { chainOf, realFolder, routeOf } from "./content-routes.ts";

// A store of sessions and the worktree manager's table, as the engine's store holds them.
function storeOf(sessions: { id: string; workspace: string; parent_id: string | null }[], worktrees: { session_id: string; repo_root: string; path: string }[] | null) {
  const db = new Database(":memory:");
  if (worktrees) {
    db.run("CREATE TABLE worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, path TEXT NOT NULL)");
    for (const w of worktrees) db.query("INSERT INTO worktrees VALUES (?, ?, ?)").run(w.session_id, w.repo_root, w.path);
  }
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return { db, session: (id: string) => byId.get(id) };
}

test("a worktree session of a restricted folder is held to that folder's rule", () => {
  const rule = { default: ["anthropic"], folders: { "/repo/client": ["bedrock"] } };
  const store = storeOf(
    [
      { id: "own", workspace: "/state/wt/client-1", parent_id: null }, // the owner's own worktree session
      { id: "orphan", workspace: "/state/wt/client-2/pkg", parent_id: "gone" }, // an agent whose parent is gone
      { id: "plain", workspace: "/elsewhere", parent_id: null },
    ],
    [
      { session_id: "own", repo_root: "/repo/client", path: "/state/wt/client-1" },
      { session_id: "orphan", repo_root: "/repo/client", path: "/state/wt/client-2" },
    ],
  );
  expect(chainOf(store, "own")).toEqual(["/repo/client"]);
  expect(chainOf(store, "orphan")).toEqual(["/repo/client/pkg"]);
  expect(routeOf(store, "own", rule)?.providers).toEqual(["bedrock"]);
  expect(routeOf(store, "orphan", rule)?.providers).toEqual(["bedrock"]);
  expect(routeOf(store, "plain", rule)?.providers).toEqual(["anthropic"]);
  // A store with no worktree table (none was ever made) reads each folder as it is.
  expect(chainOf(storeOf([{ id: "own", workspace: "/state/wt/client-1", parent_id: null }], null), "own")).toEqual(["/state/wt/client-1"]);
});

test("a folder reached through a link is its real folder, one not there its parent's", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "routes-"));
  try {
    mkdirSync(join(dir, "real", "app"), { recursive: true });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const real = realFolder(join(dir, "real"));
    expect(realFolder(join(dir, "link", "app"))).toBe(join(real, "app"));
    expect(realFolder(join(dir, "link", "not-yet", "x"))).toBe(join(real, "not-yet", "x"));
    const store = storeOf([{ id: "s", workspace: join(dir, "link", "app"), parent_id: null }], null);
    expect(routeOf(store, "s", { default: null, folders: { [join(dir, "real")]: ["bedrock"] } })?.providers).toEqual(["bedrock"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
