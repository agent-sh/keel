// Fix on a review finding is the owner's own action: a Stop before it does not
// leave the fix waiting in the held queue. The route, the engine and the store
// are real; the turn is a hook that runs until it is stopped.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { Engine } from "../../engine/turn.ts";
import type { Review } from "../../safety/review.ts";
import { reviewRoutes } from "./reviews.ts";

test("Fix on a finding starts after a Stop, behind what the owner must place first", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "review-fix-"));
  const store = new Store(dir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
  const hooks = allHooks().length;
  const routes = reviewRoutes({ store, bus, engine, providers: {}, errors } as any) as any;
  const s = store.createSession({ model: "fixture:m", workspace: dir });
  let running = Promise.withResolvers<void>();
  let pause = true;
  allHooks().push({ external: (session) => session.id === s.id ? async ({ signal }) => {
    if (pause) {
      running.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { reason: "end_turn" };
  } : undefined });
  const finding = (id: number) => ({ id, file: "a.ts", line: id, priority: 2 as const, title: `finding ${id}`, body: "", state: "open" as const });
  const review: Review = { id: "r1", session_id: s.id, child_id: null, kind: "code", scope: "uncommitted", target: "", model: "fixture:m", diff_sha256: "0", files: 1, state: "done", findings: [finding(1), finding(2)], created: Date.now() };
  store.db.query("INSERT INTO reviews (id, session_id, child_id, state, diff_sha, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)").run(review.id, s.id, null, review.state, review.diff_sha256, JSON.stringify(review), review.created);
  const fix = async (id: number) => {
    const req = new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "fix", ids: [id] }) }) as any;
    req.params = { id: s.id, rid: review.id };
    const res: Response = await routes["/api/sessions/:id/reviews/:rid/findings"].POST(req);
    return { status: res.status, findings: ((await res.json()) as any).review?.findings as Review["findings"] };
  };
  const stopped = async () => {
    running = Promise.withResolvers<void>();
    pause = true;
    engine.send(s.id, "work");
    await running.promise;
    await engine.interrupt(s.id, "owner");
    pause = false;
    expect(engine.isHeld(s.id)).toBe(true);
    return store.events(s.id).at(-1)!;
  };
  try {
    // Stopped, nothing queued: the fix is the next turn.
    const end = await stopped();
    const first = await fix(1);
    expect(first.status).toBe(200);
    expect(first.findings.find((f) => f.id === 1)).toMatchObject({ state: "fix_requested", sent_to: "the session" });
    await engine.idle(s.id);
    expect(engine.isHeld(s.id)).toBe(false);
    expect(store.queue(s.id)).toEqual([]);
    const prompts = store.events(s.id, end.seq).filter((e) => e.kind === "user");
    expect(prompts.map((e) => e.data)).toMatchObject([{ kind: "review_fix", review_id: "r1", origin: "queued", owned: true }]);
    // (owned: the owner's own action, so the turn it starts holds their word; src/safety/unstarted.ts)
    expect(String(prompts[0]!.data.text)).toContain("finding 1");

    // Stopped with a prompt queued on a branch no longer shown: the fix is
    // accepted and waits behind it, and the owner still chooses where that goes.
    const before = await stopped();
    engine.send(s.id, "queued on the old branch", { mode: "queue" });
    store.updateSession(s.id, { head: end.id });
    const second = await fix(2);
    expect(second.status).toBe(200);
    expect(second.findings.find((f) => f.id === 2)!.state).toBe("fix_requested");
    expect(engine.isRunning(s.id)).toBe(false);
    expect(engine.isHeld(s.id)).toBe(true);
    expect(store.queue(s.id).map((q) => q.meta?.kind)).toEqual([undefined, "review_fix"]);
    expect(store.events(s.id, before.seq)).toEqual([]);
  } finally {
    await engine.interrupt(s.id, "owner");
    allHooks().length = hooks;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
