import { expect, test } from "bun:test";
import { LIST_MAX, pageOfSessions } from "./tools.ts";

const rows = Array.from({ length: 130 }, (_, n) => ({ to: `m/s${n}`, session: { title: n % 10 === 0 ? `deploy ${n}` : `work ${n}`, workspace: n < 20 ? "/srv/Site" : "/home/o/app" } }));
const line = (r: (typeof rows)[number]) => r.to;

test("a cut session list says how many it left out, and an offset shows the rest", () => {
  const first = pageOfSessions(rows, {}, line).split("\n");
  expect(LIST_MAX).toBe(100);
  expect(first.length).toBe(101);
  expect(first[99]).toBe("m/s99");
  expect(first[100]).toBe("30 more: call again with offset 100.");
  const last = pageOfSessions(rows, { offset: 100 }, line).split("\n");
  expect(last).toEqual(rows.slice(100).map(line));
  expect(pageOfSessions(rows, { offset: 130 }, line)).toBe("Nothing at offset 130: 130 sessions.");
});

test("match keeps the sessions whose title or directory holds the text, in any case, and pages those", () => {
  expect(pageOfSessions(rows, { match: "DEPLOY" }, line).split("\n")).toEqual(rows.filter((_, n) => n % 10 === 0).map(line));
  expect(pageOfSessions(rows, { match: "site" }, line).split("\n").length).toBe(20);
  expect(pageOfSessions(rows, { match: "/home/o" }, line).split("\n").slice(-1)[0]).toBe("10 more: call again with offset 100 and the same match.");
  expect(pageOfSessions(rows, { match: "nothing like it" }, line)).toBe('No other session matches "nothing like it".');
  expect(pageOfSessions([], {}, line)).toBe("No other sessions.");
});

test("the tool takes offset and match and refuses a bad offset", async () => {
  const { bindFleetTools, sessionsList } = await import("./tools.ts");
  const addressable = () => rows.map((r) => ({ ...r, session: { ...r.session, id: r.to, settings: {}, usage: { output: 0 }, parent_id: null }, machine: "far", machine_id: "far", daemon_id: "d", local: false }));
  bindFleetTools({} as any, { addressable } as any, undefined, undefined);
  const ctx = { sessionId: "me" } as any;
  const run = async (input: Record<string, unknown>) => (await sessionsList.run(input, ctx)) as { content: string; is_error?: boolean };
  const all = await run({});
  expect(all.content.split("\n").length).toBe(101);
  expect(all.content).toContain("30 more");
  expect((await run({ offset: 100 })).content.split("\n").length).toBe(30);
  expect((await run({ match: "deploy 110" })).content.split("\n")[0]).toContain("m/s110\tdeploy 110\tfar\t/home/o/app");
  expect((await run({ offset: -1 })).is_error).toBe(true);
});
