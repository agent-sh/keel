// The daemon's rule trial: a settings diff only (a patch is refused, never applied or loaded), one trial at a
// time, and only a change it replayed saves, with a passkey signed over that change's hash.
import { expect, test } from "bun:test";
import type { RuleChange, TrialReport } from "../../safety/trial.ts";
import type { TrialAsk } from "../../safety/trial-read.ts";
import { saveAction, trialRoutes } from "./safety-trial.ts";

const report = (): TrialReport => ({
  days: 1, since: 0, calls: 0, ms: 0, limits: [],
  changed: { n: 0, allow: 0, ask: 0, refuse: 0, succeeded: 0, share: null, tools: [], classes: [], calls: [], more: 0 },
  agreement: { compared: 0, agreed: 0, share: null, recorded: { compared: 0, agreed: 0 }, before: {}, skipped: {}, causes: [] },
});

function rig(opts: { read?: (a: TrialAsk) => Promise<TrialReport>; signed?: string } = {}) {
  const made: unknown[] = [];
  const asked: string[] = [];
  const gate = {
    trialFacts: () => ({ home: "/h", state: "/st", config: ["/cfg"], path: "", defaultMode: "ask" as const }),
    rules: () => [], revoke: () => true, addStanding: (...a: unknown[]) => { made.push(a); return {} as any; },
  };
  // A remote device: it may do only the action its receipt was signed for.
  const presence = { allows: (_r: Request, action: string) => (asked.push(action), action === opts.signed) };
  const reads: TrialAsk[] = [];
  const routes = trialRoutes({ store: {} as any }, () => gate as any, () => presence as any, async (a) => (reads.push(a), opts.read ? opts.read(a) : report())) as any;
  const post = (path: string, body: unknown) => routes[path].POST(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })) as Promise<Response>;
  return { post, made, asked, reads };
}

const change: RuleChange = { grants: { add: [{ kind: "shell", pattern: "make test", scope: "/" }] } };

test("a patch is refused: the daemon tries settings changes only", async () => {
  const { post, reads } = rig();
  const r = await post("/api/safety/trial", { days: 1, repo: "/somewhere", patch: "--- a/src/safety/trial-rules.ts\n+++ b/src/safety/trial-rules.ts\n" });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toContain("keel safety trial --patch");
  expect(reads).toEqual([]);
  // More days than the budget fits are refused before anything runs.
  expect((await post("/api/safety/trial", { days: 30 })).status).toBe(400);
});

test("one trial runs at a time: another asked meanwhile is told so", async () => {
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  let n = 0;
  const { post } = rig({ read: async () => (n++ ? report() : (started(), new Promise((r) => (release = () => r(report()))))) });
  const first = post("/api/safety/trial", { days: 1 });
  await begun;
  const second = await post("/api/safety/trial", { days: 1 });
  expect(second.status).toBe(409);
  expect((await second.json()).running).toBe(true);
  release();
  expect((await first).status).toBe(200);
  // Once it ended, the next one runs.
  expect((await post("/api/safety/trial", { days: 1 })).status).toBe(200);
});

test("only a change the daemon replayed saves, and the passkey signs that change's hash", async () => {
  const other: RuleChange = { grants: { add: [{ kind: "shell", pattern: "rm -rf /", scope: "/" }] } };
  const { post, made, asked } = rig({ signed: saveAction(change) });
  // Not tried yet: refused before any passkey is asked for.
  expect((await post("/api/safety/trial/save", { change })).status).toBe(409);
  expect(asked).toEqual([]);
  const tried = await (await post("/api/safety/trial", { days: 1, change })).json();
  expect(saveAction(change)).toBe(`trial-save:${tried.change_hash}`);
  // A receipt for the tried change does not save another one, tried or not.
  await post("/api/safety/trial", { days: 1, change: other });
  const refused = await post("/api/safety/trial/save", { change: other });
  expect(refused.status).toBe(428);
  expect((await refused.json()).presence.action).toBe(saveAction(other));
  expect(made).toEqual([]);
  // The same change, its keys in another order, is the change tried.
  const saved = await post("/api/safety/trial/save", { change: { grants: { add: [{ scope: "/", pattern: "make test", kind: "shell" }] } } });
  expect(saved.status).toBe(200);
  expect(made).toEqual([["shell", "make test", "/"]]);
  expect(saveAction(change)).not.toBe(saveAction(other));
});
