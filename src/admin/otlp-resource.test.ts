import { expect, test } from "bun:test";
import { parseAttributes, resourceOf } from "./otlp-resource.ts";
import { toOtlp } from "./otlp.ts";
import { telemetryRows } from "./health-rules.ts";

const base = { "service.name": "keel", "service.version": "1", "process.pid": 7 };

test("OTEL_RESOURCE_ATTRIBUTES: valid, malformed, empty and encoded input", () => {
  expect(parseAttributes("a=1,b=two")).toEqual({ pairs: [["a", "1"], ["b", "two"]], dropped: [] });
  expect(parseAttributes(" a = 1 ,, ")).toEqual({ pairs: [["a", "1"]], dropped: [] });
  expect(parseAttributes("")).toEqual({ pairs: [], dropped: [] });
  expect(parseAttributes(undefined)).toEqual({ pairs: [], dropped: [] });
  expect(parseAttributes("deployment.environment=prod%2Cwest,team=a%20b,k=x=y")).toEqual({ pairs: [["deployment.environment", "prod,west"], ["team", "a b"], ["k", "x=y"]], dropped: [] });
  // A bad pair is dropped alone: no equal sign, no key, a broken escape, a key with a space.
  expect(parseAttributes("ok=1,novalue,=x,bad=%E0%A4%A,a b=1,last=2")).toEqual({ pairs: [["ok", "1"], ["last", "2"]], dropped: ["novalue", "=x", "bad=%E0%A4%A", "a b=1"] });
  expect(parseAttributes("empty=").pairs).toEqual([["empty", ""]]);
});

test("the resource follows OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES, and an exported payload carries them", () => {
  expect(resourceOf({}, base).resource).toEqual(base);
  expect(resourceOf({ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs,env=ci" }, base).resource).toMatchObject({ "service.name": "from-attrs", env: "ci", "service.version": "1" });
  const both = resourceOf({ OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs,env=ci,bad", OTEL_SERVICE_NAME: "named" }, base);
  expect(both.dropped).toEqual(["bad"]);
  expect(resourceOf({ OTEL_SERVICE_NAME: "  " }, base).resource["service.name"]).toBe("keel");
  const payload: any = toOtlp([], both.resource);
  const attrs = Object.fromEntries(payload.resourceSpans[0].resource.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
  expect(attrs).toMatchObject({ "service.name": "named", env: "ci" });
});

test("Health names the pairs left out once, whatever else it says of telemetry", () => {
  const rows = telemetryRows({}, { OTEL_RESOURCE_ATTRIBUTES: "a=1,bad,worse" });
  expect(rows.filter((r) => r.id === "telemetry:resource").length).toBe(1);
  expect(rows.find((r) => r.id === "telemetry:resource")).toMatchObject({ level: "warning", detail: expect.stringContaining("bad, worse") });
  expect(telemetryRows({}, { OTEL_RESOURCE_ATTRIBUTES: "a=1" }).map((r) => r.id)).toEqual(["telemetry:ok"]);
});
