import { expect, test } from "bun:test";
import { countsOf, doctorExit, healthText, ordered, type Row } from "./health-rows.ts";

const rows: Row[] = [
  { id: "d", group: "disk", level: "ok", title: "5 GB free" },
  { id: "w", group: "hooks", level: "warning", title: "Stop matcher", detail: "ignored", fix: "remove it", link: { section: "hooks" } },
  { id: "b", group: "hooks", level: "broken", title: "PreToolUse matcher", fix: "name a tool", path: "/c/hooks.json", link: { section: "hooks" } },
  { id: "p", group: "providers", level: "ok", title: "A answers", how: "asked for its model listing" },
];

test("the report lists broken before warnings before what is well, group by group, and the exit status follows what is broken", () => {
  expect(ordered(rows).map((r) => r.id)).toEqual(["b", "w", "p", "d"]);
  const report = { at: 0, took_ms: 40, rows: ordered(rows), counts: countsOf(rows) };
  expect(report.counts).toEqual({ ok: 2, warning: 1, broken: 1 });
  expect(doctorExit(report.counts)).toBe(1);
  expect(doctorExit({ ok: 3, warning: 2, broken: 0 })).toBe(0);
  const text = healthText(report);
  expect(text).toContain("Hooks\n  broken  PreToolUse matcher\n          fix: name a tool\n          where: /c/hooks.json  |  Customize > Hooks");
  expect(text).toContain("  ok      A answers");
  expect(text.split("\n").at(-1)).toBe("1 broken, 1 warning, 2 ok (40 ms)");
  // --problems: what is well is left out.
  expect(healthText(report, { all: false })).not.toContain("A answers");
});
