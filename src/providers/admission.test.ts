import { expect, test } from "bun:test";
import { Admission, AGE_MS, holdFrom, LANE, laneOf, nothingLeft, order, type Lane } from "./admission.ts";
import { ProviderError } from "./http.ts";

const NOW = 1_800_000_000_000;

test("a 429 holds for the wait it asked for, else a refused plan's reset, else a spent window's, else one retry's backoff", () => {
  expect(holdFrom({ askedMs: 8_000 }, NOW)).toMatchObject({ until: NOW + 8_000, why: "the account answered 429 and asked to wait 8 s" });
  const anthropic = new Headers({ "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": new Date(NOW + 20_000).toISOString(),
    "anthropic-ratelimit-tokens-limit": "90000", "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": new Date(NOW + 50_000).toISOString() });
  // The earliest reset: a bucket's reset is when it is full again, and the request that goes first finds out the rest.
  expect(holdFrom({ headers: anthropic }, NOW).until).toBe(NOW + 20_000);
  // A subscription that refused: its reset is in epoch seconds.
  const plan = new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((NOW + 3_600_000) / 1000) });
  expect(holdFrom({ headers: plan }, NOW).until).toBe(NOW + 3_600_000);
  expect(holdFrom({ headers: new Headers({ "anthropic-ratelimit-unified-status": "allowed_warning", "anthropic-ratelimit-unified-reset": String((NOW + 3_600_000) / 1000) }) }, NOW).why).toContain("named no time");
  // A 429 that names no time: the backoff of one retry, doubling with the account's 429s in a row, to the cap.
  expect(holdFrom({}, NOW).until).toBe(NOW + 500);
  expect(holdFrom({ strikes: 2 }, NOW).until).toBe(NOW + 2_000);
  expect(holdFrom({ strikes: 20 }, NOW).until).toBe(NOW + 32_000);
  // A ChatGPT plan's percentage counts with a 429 that confirms it.
  const codex = new Headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String((NOW + 3_600_000) / 1000) });
  expect(holdFrom({ headers: codex }, NOW).until).toBe(NOW + 3_600_000);
});

test("an answer says nothing is left only from a window with its limit and nothing remaining", () => {
  const openai = (left: string) => new Headers({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": left, "x-ratelimit-reset-requests": "1.5s" });
  expect(nothingLeft(openai("0"), NOW)).toBe(true);
  expect(nothingLeft(openai("3"), NOW)).toBe(false);
  // A window whose reset already passed, a plan's percentage alone, no headers: nothing.
  const past = new Headers({ "anthropic-ratelimit-tokens-limit": "1000", "anthropic-ratelimit-tokens-remaining": "0", "anthropic-ratelimit-tokens-reset": new Date(NOW - 1).toISOString() });
  expect(nothingLeft(past, NOW)).toBe(false);
  expect(nothingLeft(new Headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String((NOW + 60_000) / 1000) }), NOW)).toBe(false);
  expect(nothingLeft(undefined, NOW)).toBe(false);
});

test("after an answer with nothing left the next request goes alone, and the rest after its answer", async () => {
  const adm = new Admission({ staggerMs: 1, spreadMs: 5, trialMs: 5_000 });
  const t = await adm.admit("acct", "m", undefined);
  adm.heard(t, new Headers({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "20s" }));
  adm.answered(t);
  // Not held for the window's reset.
  expect(adm.held("acct", "m")).toBeUndefined();
  const alone = await adm.admit("acct", "m", undefined);
  expect(alone.trial).toBe(true);
  let went = false;
  const next = adm.admit("acct", "m", undefined).then(() => { went = true; });
  await Bun.sleep(10);
  expect(went).toBe(false);
  adm.answered(alone);
  await next;
  expect(went).toBe(true);
});

test("the line: the owner's turn, a shown session, agents by depth, then what no turn waits on", () => {
  expect(laneOf({ inTurn: true, top: true, ownerTurn: true, shown: false, depth: 0 }).cls).toBe(LANE.owner);
  expect(laneOf({ inTurn: true, top: true, ownerTurn: false, shown: true, depth: 0 }).cls).toBe(LANE.shown);
  expect(laneOf({ inTurn: true, top: false, ownerTurn: false, shown: false, depth: 2 })).toEqual({ cls: LANE.agent, depth: 2 });
  expect(laneOf({ inTurn: false, top: true, ownerTurn: true, shown: true, depth: 0 }).cls).toBe(LANE.background);
  const w = (name: string, cls: number, depth: number, since: number, seq: number) => ({ name, cls, depth, since, seq });
  const line = [w("reader", 3, 0, 1, 1), w("deep agent", 2, 2, 2, 2), w("agent late", 2, 1, 9, 3), w("agent", 2, 1, 3, 4), w("shown", 1, 0, 8, 5), w("owner", 0, 0, 10, 6)];
  expect(line.sort(order(10)).map((x) => x.name)).toEqual(["owner", "shown", "agent", "agent late", "deep agent", "reader"]);
});

// (Places in the line are times: kept near the clock, so none of them has waited long.)
const T0 = Date.now();
const lane = (cls: number, since: number, log: string[], name: string): Lane => ({ cls, depth: 0, since: T0 + since, held: (h) => log.push(`${name} held${h.until ? "" : " behind"}`), going: () => log.push(`${name} goes`) });
const rate = (ms?: number) => new ProviderError("rate", "HTTP 429: rate limited", 429, ms);

test("a 429 holds the account: the requests meanwhile wait, the owner's goes first and alone, the rest after its answer", async () => {
  const adm = new Admission({ staggerMs: 1, spreadMs: 5, trialMs: 5_000 });
  const first = await adm.admit("acct", "m", lane(LANE.agent, 1, [], "first"));
  expect(first.trial).toBe(false);
  adm.failed(first, rate(60));
  expect(adm.held("acct", "m")?.why).toContain("asked to wait");
  const log: string[] = [];
  const order: string[] = [];
  const go = (name: string, cls: number, since: number) => adm.admit("acct", "m", lane(cls, since, log, name)).then((t) => { order.push(name); return t; });
  const agent = go("agent", LANE.agent, 2);
  const reader = go("reader", LANE.background, 3);
  const owner = go("owner", LANE.owner, 4);
  expect(log).toEqual(["agent held", "reader held", "owner held"]);
  const trial = await owner;
  expect(trial.trial).toBe(true);
  // The rest wait for the one that went first.
  await Bun.sleep(20);
  expect(order).toEqual(["owner"]);
  adm.answered(trial);
  await Promise.all([agent, reader]);
  expect(order).toEqual(["owner", "agent", "reader"]);
  expect(adm.state()).toEqual([]);
});

test("the request that goes first answered 429 again: the account holds again and it keeps its place", async () => {
  const adm = new Admission({ staggerMs: 1, spreadMs: 5, trialMs: 5_000 });
  const t = await adm.admit("acct", "m", undefined);
  adm.failed(t, rate(20));
  const owner = await adm.admit("acct", "m", lane(LANE.owner, 1, [], "owner"));
  expect(owner.trial).toBe(true);
  const agent = adm.admit("acct", "m", lane(LANE.agent, 2, [], "agent"));
  adm.failed(owner, rate(20));
  const order: string[] = [];
  const again = adm.admit("acct", "m", lane(LANE.owner, 1, [], "owner")).then((x) => { order.push("owner"); return x; });
  void agent.then(() => order.push("agent"));
  const t2 = await again;
  expect(order).toEqual(["owner"]);
  adm.answered(t2);
  await agent;
  expect(order).toEqual(["owner", "agent"]);
});

test("nothing is held without the account's word, a hold longer than a turn waits is refused unsent, and a stop leaves the line", async () => {
  const adm = new Admission({ maxWaitMs: () => 1_000 });
  // A failure that is not a rate limit holds nothing.
  const t = await adm.admit("acct", "m", undefined);
  adm.failed(t, new ProviderError("server", "HTTP 500", 500));
  expect((await adm.admit("acct", "m", undefined)).trial).toBe(false);
  // A 429 asking for longer than a turn waits: the next request is refused at once with that wait.
  const u = await adm.admit("acct", "m", undefined);
  adm.failed(u, rate(60_000));
  const refused = await adm.admit("acct", "m", undefined).catch((e) => e);
  expect(refused).toMatchObject({ kind: "rate", status: 429, held: true });
  expect(refused.retryAfterMs).toBeGreaterThan(59_000);
  // A stopped request leaves the line.
  const other = new Admission();
  const v = await other.admit("b", "m", undefined);
  other.failed(v, rate(5_000));
  const ac = new AbortController();
  const waiting = other.admit("b", "m", undefined, ac.signal).catch((e) => e.name);
  ac.abort();
  expect(await waiting).toBe("AbortError");
  expect(other.state()).toMatchObject([{ account: "b", model: "m", waiting: 0 }]);
});

test("a 429 holds its model's line, not the account's other models; a limit of the plan holds them all", async () => {
  const adm = new Admission({ staggerMs: 1, spreadMs: 5, trialMs: 5_000 });
  const t = await adm.admit("acct", "big", undefined);
  adm.heard(t, new Headers({ "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "0", "anthropic-ratelimit-requests-reset": new Date(Date.now() + 20_000).toISOString() }));
  adm.failed(t, rate(20_000));
  expect(adm.held("acct", "big")?.scope).toBe("model");
  // A reader on a cheaper model of the same account goes at once.
  expect(adm.held("acct", "small")).toBeUndefined();
  expect((await adm.admit("acct", "small", lane(LANE.background, 1, [], "reader"))).trial).toBe(false);
  // Nothing left in one model's window serialises that model only.
  const s = await adm.admit("acct", "small", undefined);
  adm.heard(s, new Headers({ "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "20s" }));
  adm.answered(s);
  expect((await adm.admit("acct", "other", undefined)).trial).toBe(false);
  // A subscription that refused holds every model of the account.
  const p = await adm.admit("acct", "other", undefined);
  adm.heard(p, new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.ceil((Date.now() + 30_000) / 1000)) }));
  adm.failed(p, rate());
  expect(adm.held("acct", "small")?.scope).toBe("account");
  expect(adm.held("acct", "never-asked")?.why).toContain("plan's limit");
  // A ChatGPT plan's window used up, with its 429, is the account's too.
  const codex = new Admission();
  const c = await codex.admit("chatgpt", "a", undefined);
  codex.heard(c, new Headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(Math.ceil((Date.now() + 30_000) / 1000)) }));
  codex.failed(c, rate());
  expect(codex.held("chatgpt", "b")?.scope).toBe("account");
});

test("a hold days long refuses requests but lets one ask the account every probeMs, and its answer clears the hold", async () => {
  let now = NOW;
  const adm = new Admission({ now: () => now, maxWaitMs: () => 300_000, probeMs: 300_000, trialMs: 5_000, staggerMs: 1, spreadMs: 5 });
  const t = await adm.admit("acct", "m", undefined);
  adm.heard(t, new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((NOW + 3 * 86_400_000) / 1000) }));
  adm.failed(t, rate());
  expect((await adm.admit("acct", "m", undefined).catch((e) => e)).held).toBe(true);
  now += 299_000;
  expect((await adm.admit("acct", "m", undefined).catch((e) => e)).held).toBe(true);
  now += 1_000;
  // Five minutes on: one request asks the account; the next is refused while it does.
  const probe = await adm.admit("acct", "m", undefined);
  expect(probe).toMatchObject({ trial: true });
  expect((await adm.admit("acct", "m", undefined).catch((e) => e)).held).toBe(true);
  // Refused again: held by its new word, and the next ask is five minutes from now.
  adm.heard(probe, new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((NOW + 3 * 86_400_000) / 1000) }));
  adm.failed(probe, rate());
  now += 1_000;
  expect((await adm.admit("acct", "m", undefined).catch((e) => e)).held).toBe(true);
  now += 300_000;
  const again = await adm.admit("acct", "m", undefined);
  expect(again.trial).toBe(true);
  // Answered: the hold is gone, for the account's other models too.
  adm.answered(again);
  expect(adm.held("acct", "m")).toBeUndefined();
  expect(adm.held("acct", "other")).toBeUndefined();
  expect((await adm.admit("acct", "other", undefined)).trial).toBe(false);
});

test("a callback that throws keeps neither the request nor the line from moving", async () => {
  const told: unknown[] = [];
  const adm = new Admission({ staggerMs: 1, spreadMs: 5, trialMs: 5_000, report: (e) => told.push(e) });
  const t = await adm.admit("acct", "m", undefined);
  adm.failed(t, rate(20));
  const bad: Lane = { cls: LANE.owner, depth: 0, since: Date.now(), held: () => { throw new Error("held broke"); }, going: () => { throw new Error("going broke"); } };
  const first = await adm.admit("acct", "m", bad);
  expect(first.trial).toBe(true);
  adm.answered(first);
  expect((await adm.admit("acct", "m", undefined)).trial).toBe(false);
  expect(told.map((e) => (e as Error).message)).toEqual(["held broke", "going broke"]);
});

test("a request that waited a whole window goes before owner turns that asked after it", async () => {
  const w = (name: string, cls: number, since: number, seq: number) => ({ name, cls, depth: 1, since, seq });
  const now = NOW;
  const line = [w("owner", LANE.owner, now - 1_000, 1), w("old agent", LANE.agent, now - AGE_MS, 2), w("young agent", LANE.agent, now - 5_000, 3)];
  expect(line.sort(order(now)).map((x) => x.name)).toEqual(["old agent", "owner", "young agent"]);
  // In the line itself: an agent that asked a minute ago (a retry keeps its place) goes first when the hold ends.
  const adm = new Admission({ staggerMs: 1, spreadMs: 5, trialMs: 5_000 });
  const t = await adm.admit("acct", "m", undefined);
  adm.failed(t, rate(30));
  const went: string[] = [];
  const owner = adm.admit("acct", "m", { cls: LANE.owner, depth: 0, since: Date.now() }).then((x) => { went.push("owner"); return x; });
  const agent = adm.admit("acct", "m", { cls: LANE.agent, depth: 1, since: Date.now() - AGE_MS }).then((x) => { went.push("agent"); return x; });
  const first = await Promise.race([agent, owner]);
  expect(went).toEqual(["agent"]);
  adm.answered(first);
  await owner;
  expect(went).toEqual(["agent", "owner"]);
});
