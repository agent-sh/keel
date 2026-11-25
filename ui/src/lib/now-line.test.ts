import { expect, test } from "bun:test";
import { momentOf, pathInAction, relIn } from "./now-line.ts";

test("a live turn is thinking, acting or waiting; a session at rest has no moment", () => {
  expect(["model", "turn", "stalled"].map((why) => momentOf({ watch: "work", why }))).toEqual(["thinking", "thinking", "thinking"]);
  expect(["tool", "compacting"].map((why) => momentOf({ watch: "work", why }))).toEqual(["acting", "acting"]);
  expect(["limit", "retry", "agents", "command", undefined].map((why) => momentOf({ watch: "work", why }))).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
  expect([momentOf({ watch: "wait", why: "timer" }), momentOf({ watch: "need", why: "approval" })]).toEqual(["waiting", "need"]);
  expect(["done", "idle", "fail", "stop", "declined"].map((watch) => momentOf({ watch: watch as never }))).toEqual([null, null, null, null, null]);
});

test("the path an action names is a place in the folder", () => {
  expect(pathInAction("Editing src/a.ts", "/w")).toEqual({ before: "Editing ", path: "src/a.ts", rel: "src/a.ts", dir: false });
  expect(pathInAction("Reading /w/src/a.ts", "/w/")?.rel).toBe("src/a.ts");
  expect(pathInAction("Listing src", "/w")?.dir).toBe(true);
  // Not a place the Files panel can show: a command, several calls, a path outside the folder.
  expect(pathInAction("Running bun test", "/w")).toBeNull();
  expect(pathInAction("Editing src/a.ts, and 2 more", "/w")).toBeNull();
  expect(pathInAction("Editing /etc/hosts", "/w")).toBeNull();
  expect(pathInAction("Editing ~/notes.md", "/w")).toBeNull();
  expect(pathInAction("Editing ../x.ts", "/w")).toBeNull();
  expect(relIn("/w", "/w")).toBe("");
  expect(relIn("/w", "/wx/a")).toBeNull();
});
