// A plan the model wrote before the owner renamed a row lands after the
// rename, driven the way the panel's PATCH and the plan tool's hook drive it.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as goals from "./goals.ts";
import * as renames from "./task-renames.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-task-renames-")));
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => true } } as any);
activity.migrate();
goals.migrate();
const session = () => store.createSession({ model: "m", workspace: "/", title: "t" });
const plan = (...items: [string, string][]) => ({ plan: items.map(([step, status]) => ({ step, status })) });
const rows = (id: string) => goals.tasks(id).map((t) => [t.id, t.text, t.status, t.dest_session ?? null]);

test("a row renamed while an older plan is in flight keeps its id, status and destination", () => {
  const s = session();
  renames.fromPlan(s.id, "update_plan", plan(["Run migration", "pending"], ["Docs", "pending"]));
  const [a, b] = goals.tasks(s.id);
  goals.editTask(s.id, a!.id, { status: "in_progress", dest_session: "dest-1" }); // taken into a session of its own
  renames.edit(s.id, a!.id, { text: "Run the migration on staging", was: "Run migration" });
  // The plan written before the rename: it still says the old words.
  renames.fromPlan(s.id, "update_plan", plan(["Run migration", "completed"], ["Docs", "completed"]));
  expect(rows(s.id)).toEqual([[a!.id, "Run the migration on staging", "in_progress", "dest-1"], [b!.id, "Docs", "completed", null]]);
  // Told of the rename, the model's next plan carries the new words: the row is the same row.
  goals.tellModel(s.id);
  renames.told(s.id);
  renames.fromPlan(s.id, "update_plan", plan(["Run the migration on staging", "completed"], ["Docs", "completed"]));
  expect(rows(s.id)).toEqual([[a!.id, "Run the migration on staging", "completed", "dest-1"], [b!.id, "Docs", "completed", null]]);
});

for (const which of [0, 1]) test(`of two tasks that read the same, the one not renamed stays its own row (the ${which ? "second" : "first"} renamed)`, () => {
  const s = session();
  renames.fromPlan(s.id, "TodoWrite", { todos: [{ content: "Verify", status: "pending" }, { content: "Verify", status: "pending" }] });
  const twins = goals.tasks(s.id);
  renames.edit(s.id, twins[which]!.id, { text: "Verify the build" });
  renames.fromPlan(s.id, "TodoWrite", { todos: [{ content: "Verify", status: "completed" }, { content: "Verify", status: "in_progress" }] });
  const other = which ? ["Verify", "completed"] : ["Verify", "in_progress"];
  const want = [[twins[which]!.id, "Verify the build", "pending", null], [twins[1 - which]!.id, ...other, null]];
  expect(rows(s.id)).toEqual(which ? want.reverse() : want);
});

test("a renamed row the owner then removed does not come back under its old words", () => {
  const s = session();
  renames.fromPlan(s.id, "write_todos", { todos: [{ description: "Draft", status: "pending" }, { description: "Ship", status: "pending" }] });
  const [a, b] = goals.tasks(s.id);
  renames.edit(s.id, a!.id, { text: "Draft the note" });
  goals.removeTask(s.id, a!.id);
  renames.fromPlan(s.id, "write_todos", { todos: [{ description: "Draft", status: "in_progress" }, { description: "Ship", status: "pending" }] });
  expect(rows(s.id)).toEqual([[b!.id, "Ship", "pending", null]]);
});
