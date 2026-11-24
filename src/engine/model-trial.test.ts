import { expect, test } from "bun:test";
import type { Session } from "../core/types.ts";
import { trialModel, trialOf, type Trial } from "./model-trial.ts";

const on = (exp: string) => exp === "x1";
const t = (role: Trial["role"], exp = "x1"): Trial => ({ role, model: "p:m", exp });
const s = (id: string, settings: Record<string, unknown> = {}, parent_id?: string) => ({ id, settings, parent_id }) as unknown as Session;

test("a tree's trial is read from its top session, down every agent", () => {
  const all = new Map([s("top", { trial: t("builder") }), s("a", {}, "top"), s("b", {}, "a")].map((x) => [x.id, x]));
  const get = (id: string) => all.get(id);
  expect(trialOf(all.get("b"), get, on)).toEqual(t("builder"));
  expect(trialModel("builder", all.get("b"), get, on)).toBe("p:m");
  // Another role of the same tree is not the trial's.
  expect(trialModel("reader", all.get("b"), get, on)).toBeUndefined();
});

test("a tree with no trial, or a damaged one, has none", () => {
  const all = new Map([s("top"), s("a", {}, "top"), s("bad", { trial: { role: "nobody", model: "p:m" } })].map((x) => [x.id, x]));
  expect(trialOf(all.get("a"), (id) => all.get(id), on)).toBeUndefined();
  expect(trialOf(all.get("bad"), (id) => all.get(id), on)).toBeUndefined();
});

test("a tree is in its trial only while the trial's experiment runs", () => {
  const all = new Map([s("top", { trial: t("small", "x1") }), s("a", {}, "top")].map((x) => [x.id, x]));
  const get = (id: string) => all.get(id);
  expect(trialModel("small", all.get("a"), get, (e) => e === "x1")).toBe("p:m");
  // Stopped, by a press, a guard or its sample: the settings stay on the session, the trial does not.
  expect(trialModel("small", all.get("a"), get, () => false)).toBeUndefined();
  // With no experiments to ask (the default), none runs.
  expect(trialOf(all.get("a"), get)).toBeUndefined();
});
