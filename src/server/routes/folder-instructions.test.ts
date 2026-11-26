// A session moved or cloned to another folder gets that folder's instruction files on its own model's
// window, at the tail as the harness's own words: the prompt it holds keeps its bytes. What a small
// window cuts is said, with where to read the rest.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { sessionParts, toMessages } from "../../engine/turn.ts";
import { promptNote, toldOf, type Rendered } from "../../engine/prompt-note.ts";
import { blocksOf } from "../../engine/prompt-store.ts";
import { placesRoutes } from "./places.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `folder-instructions-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const tail = Array.from({ length: 1300 }, (_, i) => `- filler line ${i} of the long file, to pass a small window.`).join("\n");
const post = (routes: any, path: string, id: string, body: unknown) =>
  routes[path].POST(Object.assign(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: { id } }));

function setup(name: string) {
  const from = join(root, name, "one"), to = join(root, name, "two");
  for (const d of [from, to]) mkdirSync(d, { recursive: true });
  writeFileSync(join(to, "AGENTS.md"), `# Local\n\n- LOCAL-NEW: the changed rule.\n\n## Long\n\n${tail}\n\nEND-RULE: the last line.\n`);
  const store = new Store(join(root, name, "state"));
  const bus = new Bus();
  // (The column the agents' migration adds: a move looks for the agents under the session.)
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  const models = [{ id: "s:big", context: 1_000_000 }, { id: "s:small", context: 32_000 }, { id: "s:std", context: 200_000 }];
  const routes = placesRoutes({ store, bus, errors: new ErrorTracker(store, bus), engine: { isRunning: () => false }, workspace: from, providers: { models: async () => models } } as any) as any;
  return { store, routes, from, to };
}
const folderNote = (store: Store, id: string) => store.events(id).find((e: any) => e.kind === "note" && e.data.kind === "folder")!.data as any;

test("a move on a large window carries the whole file, as the harness's own words at the tail", async () => {
  const { store, routes, from, to } = setup("big");
  const s = store.createSession({ workspace: from, model: "s:big", title: "big" });
  expect((await post(routes, "/api/sessions/:id/folder", s.id, { cwd: to })).status).toBe(200);
  const n = folderNote(store, s.id);
  expect(n.text).toContain("LOCAL-NEW");
  expect(n.text).toContain("END-RULE");
  expect(n.system).toBe(true);
  // The request carries it as a system text block of the history's tail.
  const last = toMessages(store.events(s.id)).at(-1)!;
  expect(last.content.some((b: any) => b.type === "text" && b.system === true && b.text.includes("END-RULE"))).toBe(true);
  store.db.close();
});

test("a clone on a small window says what is cut and where to read it", async () => {
  const { store, routes, from, to } = setup("small");
  const s = store.createSession({ workspace: from, model: "s:small", title: "small" });
  const res = await post(routes, "/api/sessions/:id/clone", s.id, { cwd: to });
  expect(res.status).toBe(201);
  const c = (await res.json()).session;
  const n = folderNote(store, c.id);
  expect(n.text).toContain("LOCAL-NEW");
  expect(n.text).not.toContain("END-RULE");
  expect(n.text).toContain(`Read ${join(to, "AGENTS.md")} from line`);
  expect(n.instructions.find((f: any) => f.path === join(to, "AGENTS.md")).state).toBe("cut");
  store.db.close();
});

// This repository's AGENTS.md is longer than a 200K window's share of one file: a move there cuts it
// and says so, with the line its rest starts on.
test("this repository's AGENTS.md is not cut silently by a move", async () => {
  const { store, routes, from, to } = setup("repo");
  writeFileSync(join(to, "AGENTS.md"), readFileSync(join(import.meta.dir, "../../../AGENTS.md"), "utf8"));
  const s = store.createSession({ workspace: from, model: "s:std", title: "std" });
  expect((await post(routes, "/api/sessions/:id/folder", s.id, { cwd: to })).status).toBe(200);
  const n = folderNote(store, s.id);
  const f = n.instructions.find((x: any) => x.path === join(to, "AGENTS.md"));
  // (Whole while the file fits the window's share, as its twin in engine/instructions-move.test.ts.)
  if (f.state === "whole") expect(n.text).toContain(readFileSync(join(to, "AGENTS.md"), "utf8").trimEnd().split("\n").at(-1)!);
  else {
    expect(f.state).toBe("cut");
    expect(n.text).toContain("(Cut here:");
    expect(n.text).toContain(`Read ${join(to, "AGENTS.md")} from line`);
  }
  store.db.close();
});

// The prompt the session holds stays the old folder's; a render made later from the new one (a restart's) is
// what the move's note told already, so it is not told a second time. A render still of the old folder (no
// restart yet) tells nothing either.
test("a restart after a move does not tell the new folder's instructions again", async () => {
  const { store, routes, from, to } = setup("restart");
  const s = store.createSession({ workspace: from, model: "s:std", title: "std" });
  const render = (cwd: string): Rendered => {
    const parts = sessionParts(cwd, s.created, 200_000).parts;
    return { text: parts.map((p) => p.text).join(""), blocks: blocksOf(parts) };
  };
  const sent = render(from);
  expect((await post(routes, "/api/sessions/:id/folder", s.id, { cwd: to })).status).toBe(200);
  const told = toldOf(store.events(s.id));
  expect(promptNote(sent, render(to), told)).toBeUndefined();
  expect(promptNote(sent, sent, told)).toBeUndefined();
  // An edit made after the move is still told, against what the move's note said.
  writeFileSync(join(to, "AGENTS.md"), "# Local\n\n- EDITED-RULE: after the move.\n");
  const later = promptNote(sent, render(to), told);
  expect(later?.names).toEqual(["instruction files"]);
  expect(later?.text).toContain("EDITED-RULE");
  store.db.close();
});
