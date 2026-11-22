// The judge of Auto and Full auto when its provider cannot be reached: the review waits for the
// provider and is asked again. It never allows unreviewed, and a network blip refuses no work.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { emptyUsage } from "../core/types.ts";
import { notReached } from "../providers/http.ts";
import { Outages } from "../providers/outage.ts";
import { makeJudge } from "./judge.ts";

const FAST = { quickMs: [10, 10, 10, 10], slowMinMs: 20, slowMaxMs: 30, probeMs: 200, canaryMs: 60, staggerMs: 10, spreadMs: 100, maxMs: 60_000, carryMs: 60_000 };
const gone = () => notReached("P", Object.assign(new TypeError("getaddrinfo EAI_AGAIN p.example"), { code: "EAI_AGAIN" }));

function rig(downFor: number) {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-judge-outage-")));
  const session = store.createSession({ model: "p:m", workspace: "/w" });
  let asked = 0;
  const outages = new Outages({ timing: FAST });
  const providers = {
    outages,
    resolve: async () => ({
      info: { id: "p:m", name: "M", model: "m", efforts: [], output: 1000 },
      provider: { stream: async () => {
        if (++asked <= downFor) throw gone();
        outages.answered("p");
        return { blocks: [{ type: "text", text: '{"decision":"allow","risk":"low","reason":"in scope"}' }], usage: emptyUsage() };
      } },
    }),
  } as any;
  const judge = makeJudge(store, providers, () => undefined);
  return { judge, session, outages, asked: () => asked };
}

test("a judge whose provider cannot be reached is waited for with the turn, then gives its verdict", async () => {
  const r = rig(3);
  const turn = new AbortController();
  const verdict = r.judge({ session: r.session, tool: "Bash", kind: "shell", summary: "rm -rf build", input: {}, high: { why: "it deletes files" }, signal: turn.signal });
  await Bun.sleep(15);
  // Meanwhile the session waits for the provider: no verdict, no refusal.
  expect(r.outages.of(r.session.id)?.provider).toBe("p");
  const v = await verdict;
  expect(v).toMatchObject({ allow: true, risk: "low", reason: "in scope" });
  expect(r.asked()).toBe(4);
  expect(r.outages.of(r.session.id)).toBeUndefined();
});

test("the owner's stop ends the judge's wait with no verdict, and a caller that gave no signal gets none at once", async () => {
  const r = rig(Infinity);
  const turn = new AbortController();
  const verdict = r.judge({ session: r.session, tool: "Bash", kind: "shell", summary: "rm -rf build", input: {}, high: { why: "it deletes files" }, signal: turn.signal });
  await Bun.sleep(40);
  turn.abort();
  const v = await verdict;
  expect("unavailable" in v).toBe(true); // never an allow
  expect(r.outages.of(r.session.id)).toBeUndefined();
  // Reviewer mode asks the owner instead: it does not wait.
  const t0 = Date.now();
  const fast = await rig(Infinity).judge({ session: r.session, tool: "Bash", kind: "shell", summary: "ls", input: {} });
  expect("unavailable" in fast && fast.unavailable).toContain("EAI_AGAIN");
  expect(Date.now() - t0).toBeLessThan(500);
});
