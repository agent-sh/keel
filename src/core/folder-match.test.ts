import { expect, test } from "bun:test";
import { folderScore, rankFolders, typedPath } from "./folder-match.ts";

test("a path is opened, a name is found", () => {
  expect(["/etc", "~/projects", "./x", "projects/shop"].map(typedPath)).toEqual([true, true, true, true]);
  expect(["resea", "shop api"].map(typedPath)).toEqual([false, false]);
});

test("the name counts before the path, whole before its start before a part before anywhere", () => {
  const s = (q: string, name: string) => folderScore(q, name, `/h/projects/${name}`);
  expect(s("shop", "shop")).toBeGreaterThan(s("shop", "shopfront"));
  expect(s("shop", "shopfront")).toBeGreaterThan(s("api", "shop-api"));
  expect(s("api", "shop-api")).toBeGreaterThan(s("hop", "shop"));
  expect(s("hop", "shop")).toBeGreaterThan(folderScore("projects", "shop", "/h/projects/shop"));
  expect(folderScore("projects", "shop", "/h/projects/shop")).toBeGreaterThan(s("rsch", "research"));
  expect(s("zz", "shop")).toBe(-1);
  expect(s("sp", "shop")).toBe(-1); // letters in order count from three
  expect(s("keel", "ko-codex-desktop-linux")).toBe(-1); // and only close together
  // Every word must match.
  expect(folderScore("keel bun", "keel-bun", "/h/p/keel-bun")).toBeGreaterThan(0);
  expect(folderScore("keel zz", "keel-bun", "/h/p/keel-bun")).toBe(-1);
});

test("the top match: a repository and a used folder a little ahead, then the shorter path", () => {
  const list = [
    { name: "research", path: "/h/a/b/research", is_git: false },
    { name: "research", path: "/h/research", is_git: false },
    { name: "research-api", path: "/h/p/research-api", is_git: true },
    { name: "notes", path: "/h/notes", is_git: false },
  ];
  expect(rankFolders("resea", list).map((h) => h.path)).toEqual(["/h/p/research-api", "/h/research", "/h/a/b/research"]);
  expect(rankFolders("research", list)[0]!.path).toBe("/h/research");
  expect(rankFolders("research", [...list, { name: "research", path: "/h/a/b/research", is_git: false, used: true }].reverse())[0]!.path).toBe("/h/a/b/research");
  expect(rankFolders("resea", list, 1)).toHaveLength(1);
});
