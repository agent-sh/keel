// A turn a restart cut while its question card was open waits on that card in the next daemon and goes on
// when it is answered. Under a dev hot reload the process holds two engines over two stores of one
// database for a moment: the replaced engine, still recovering, continued the cut turn and handed it to
// its successor, whose store did not know the restart message the old one had just written. The
// branch read empty and the turn's request went with no messages.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { rig } from "./delivery.fixture.ts";
import { answer, pendingQuestions } from "../tools/interact.ts";

const scratch = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? ".", `${name}-`));
const Q = { questions: [{ question: "Which way?", header: "Way", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }] };
const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); ) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(20); }
};
const g = globalThis as { __keelEngine?: unknown };
afterEach(() => { delete g.__keelEngine; });

// A session whose turn was waiting on its question when the daemon went down.
function cutAtCard(dir: string) {
  const first = rig(dir, { family: "claude" });
  const s = first.session();
  first.store.append(s.id, "user", { text: "fix it; ask first" });
  first.store.append(s.id, "turn_start", { model: "scripted:stand-in" });
  first.store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Two ways." }, { type: "tool_use", id: "q1", name: "AskUserQuestion", input: Q }], stop: "tool_use" });
  first.store.updateSession(s.id, { phase: "working" });
  first.store.db.close();
  return s.id;
}

test("a hot reload while a cut turn is continued: the card waits in the new engine and the turn goes on with its history", async () => {
  const dir = scratch("restart-card-hot");
  const id = cutAtCard(dir);
  // The engine the first reload made, and the one the second made a moment later in the same process.
  const old = rig(dir, { family: "claude" });
  const now = rig(dir, { family: "claude" });
  // The new engine's store has read the session already (its own start reads the cut sessions).
  now.store.lineage(id);
  let handed = false;
  // The old engine is replaced while it waits for the model to list, before it continues the cut turn.
  await old.engine.recover(old.store.bootWorking, async () => {
    if (handed) return;
    handed = true;
    g.__keelEngine = now.engine;
    await old.engine.drain(0);
  });
  await now.engine.recover(now.store.bootWorking, async () => {});
  await until(() => pendingQuestions(id).length > 0 || now.store.events(id).some((e) => e.kind === "error"));
  expect(now.store.events(id).filter((e) => e.kind === "error").map((e) => e.data.message)).toEqual([]);
  answer(id, "q1", { "0": { picked: ["A"] } });
  await until(() => now.store.events(id).at(-1)?.kind === "turn_end");
  expect(now.store.lineage(id).at(-1)?.data.reason).toBe("end_turn");
  // The request after the answer carried the task, and the restart message once.
  const last = now.requests.at(-1)!;
  expect(last[0]).toBe("fix it; ask first");
  expect(last.filter((t) => t.includes("daemon restarted")).length).toBe(1);
}, 30_000);

test("a store reads what another connection appended to a session it holds", () => {
  const dir = scratch("restart-card-store");
  const id = cutAtCard(dir);
  const a = rig(dir), b = rig(dir);
  expect(b.store.lineage(id).length).toBe(3);
  a.store.append(id, "turn_end", { reason: "restart" });
  a.store.append(id, "user", { text: "[harness] restarted", origin: "restart" });
  expect(b.store.lineage(id).map((e) => e.kind)).toEqual(["user", "turn_start", "assistant", "turn_end", "user"]);
  expect(b.store.events(id).length).toBe(5);
});
