import { describe, expect, test } from "bun:test";
import type { Session } from "../../../src/core/types.ts";
import { busyWords, workingIn } from "./folder-busy.ts";

const s = (id: string, workspace: string, o: Partial<Session> = {}) => ({ id, title: id, workspace, updated: 1, archived: false, ...o }) as Session;
const all = [s("a", "/r/app"), s("b", "/r/app/"), s("c", "/r/other"), s("d", "/r/app", { archived: true }), s("e", "/r/app", { machine: "box" }), s("f", "/r/app"), s("g", "/r/app")];
const work = (x: Session) => (x.id === "f" ? "idle" : x.id === "g" ? "need" : "work");

describe("sessions working in a folder", () => {
  test("those of this folder that work, and no other", () => {
    expect(workingIn("/r/app", all, work).map((x) => x.id).sort()).toEqual(["a", "b", "g"]);
    expect(workingIn("/r/nobody", all, work)).toEqual([]);
    expect(workingIn("", all, work)).toEqual([]);
  });
  test("the words say how many and name two", () => {
    expect(busyWords(["Fix the build"])).toBe("A session works in this folder (Fix the build)");
    expect(busyWords(["a", "b"])).toBe("Two sessions work in this folder (a, b)");
    expect(busyWords(["a", "b", "c", "d"])).toBe("Four sessions work in this folder (a, b and 2 more)");
  });
});
