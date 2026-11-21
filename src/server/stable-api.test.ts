import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStable, renderApiDoc, routeTable, STABLE } from "./stable-api.ts";

test("docs/http-api.md is what the stable route table says (bun scripts/api-docs.ts writes it)", () => {
  expect(readFileSync(join(import.meta.dir, "../../docs/http-api.md"), "utf8")).toBe(renderApiDoc());
});

test("a route table is listed with its stable methods, and a stable route it lacks is named", () => {
  const h = () => new Response();
  const t = routeTable({ "/": h, "/api/health": { GET: h }, "/api/run": { POST: h, GET: h }, "/api/other": h });
  expect(t.routes).toEqual([
    { path: "/api/health", methods: ["GET"], stable: ["GET"] },
    { path: "/api/other", methods: ["ALL"], stable: [] },
    { path: "/api/run", methods: ["GET", "POST"], stable: ["POST"] },
  ]);
  expect(t.missing).toEqual(STABLE.filter((s) => !["/api/health", "/api/run"].includes(s.path)).map((s) => `${s.method} ${s.path}`));
  expect([isStable("POST", "/api/sessions/abc/approvals/x1"), isStable("PUT", "/api/sessions/abc/permissions"), isStable("GET", "/api/sessions/abc/events/1")]).toEqual([true, false, false]);
});
