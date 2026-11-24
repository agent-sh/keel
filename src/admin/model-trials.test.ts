// A model trial is an experiment made in one call, with its own id in its arm; a tree is in it while it runs.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { allHooks } from "../engine/hooks.ts";
import { trialModel } from "../engine/model-trial.ts";
import { Experiments } from "./experiments.ts";
import { Outcomes } from "./outcomes.ts";
import { Telemetry } from "./telemetry.ts";
import { TRIAL_KIND, trialExperiment, trialIn } from "./model-trials.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-model-trials-"));
const store = new Store(dir);
const before = allHooks().length;
if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
new Telemetry(store, new Bus());
const x = new Experiments(store);
new Outcomes(store, x);
const mine = allHooks().slice(before);
// Hooks are process-wide: taken off again with the folder.
afterAll(() => {
  for (const h of mine) { const i = allHooks().indexOf(h); if (i >= 0) allHooks().splice(i, 1); }
  rmSync(dir, { recursive: true, force: true });
});
const m = { id: "p:new", name: "New one" };
const tree = { id: "top", settings: {} } as unknown as Session;

test("a trial is made with its template and its id in one call, and a tree is in it only while it runs", () => {
  const exp = Bun.randomUUIDv7();
  const made = x.create({ ...trialExperiment(m, "small", exp), template: TRIAL_KIND }, { id: exp, kind: TRIAL_KIND });
  expect(made.id).toBe(exp);
  expect(trialIn(made)).toEqual({ role: "small", model: "p:new", exp });
  const top = { ...tree, settings: { trial: trialIn(made) } } as unknown as Session;
  const get = () => undefined;
  // A draft is not running.
  expect(trialModel("small", top, get)).toBeUndefined();
  x.start(exp);
  expect(trialModel("small", top, get)).toBe("p:new");
  x.stop(exp);
  // Stopped (a press, a guard or the sample's end): the settings stay on the session, the trial does not.
  expect(trialModel("small", top, get)).toBeUndefined();
  expect(x.list().filter((e) => e.state === "draft")).toEqual([]);
});

test("a template the owner names must exist; a trial's own kind is not one of them", () => {
  expect(() => x.create({ ...trialExperiment(m, "reader", "i"), template: TRIAL_KIND })).toThrow("no template");
});
