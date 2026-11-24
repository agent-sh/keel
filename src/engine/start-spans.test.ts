// A memory step or a stall names which part of a start or of a turn's setup ran: each part is a span of the
// activity record (src/admin/activity.ts), not only the pass around it.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ran } from "../admin/activity.ts";
import { rig } from "./delivery.fixture.ts";

const scratch = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? ".", `${name}-`));
const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) {} };
const labels = (from: number) => ran(from, Date.now() + 5).filter((r) => r.kind === "start" || r.kind === "turn").map((r) => r.label);

test("the parts of a turn's start are spans, each named", async () => {
  const { store, engine, session } = rig(scratch("start-spans-turn"));
  const s = session();
  const warm = store.warm.bind(store);
  store.warm = async (...a: Parameters<typeof warm>) => { await Bun.sleep(25); return warm(...a); };
  const from = Date.now() - 1;
  engine.send(s.id, "hello");
  await engine.idle(s.id);
  expect(labels(from)).toContain("a turn's start: reading its session's rows");
});

test("the parts of the start's recovery are spans, each named", async () => {
  const { store, engine } = rig(scratch("start-spans-recover"));
  const rearm = (engine as any).rearmContinues.bind(engine);
  (engine as any).rearmContinues = () => { busy(25); rearm(); };
  const from = Date.now() - 1;
  await engine.recover(store.bootWorking, async () => {});
  expect(labels(from)).toContain("the start's recovery: telling of the closed turns and arming the queued ones");
});
