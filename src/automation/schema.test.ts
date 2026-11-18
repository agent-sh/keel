import { expect, test } from "bun:test";
import { check, extractJson } from "./schema.ts";

const S = {
  type: "object",
  required: ["files", "risk"],
  additionalProperties: false,
  properties: {
    files: { type: "array", items: { type: "object", required: ["path"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } } } },
    risk: { enum: ["low", "high"] },
    note: { type: ["string", "null"] },
  },
};

test("a report that matches passes; each kind of mismatch names where", () => {
  expect(check(S, { files: [{ path: "a.ts", line: 3 }], risk: "low", note: null })).toBeUndefined();
  expect(check(S, { files: [], risk: "mid" })).toContain("$.risk");
  expect(check(S, { files: [{ line: 0 }], risk: "low" })).toContain('$.files[0]: missing "path"');
  expect(check(S, { files: [{ path: "a", line: 0 }], risk: "low" })).toContain("below 1");
  expect(check(S, { files: [], risk: "low", extra: 1 })).toContain('"extra" is not allowed');
  expect(check(S, [])).toContain("expected object");
});

test("the JSON of a report is found in plain, fenced or surrounded text", () => {
  expect(extractJson('{"a":1}')).toEqual({ value: { a: 1 } });
  expect(extractJson('Done.\n```json\n{"a":2}\n```')).toEqual({ value: { a: 2 } });
  expect(extractJson('Here it is: {"a":3} as asked')).toEqual({ value: { a: 3 } });
  expect(extractJson("no json here")).toHaveProperty("error");
});
