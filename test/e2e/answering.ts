// What answer-keys.spec.ts is built from: sessions that ask (an approval, a
// question, a plan, a secret), the page's own clock for when a card was drawn
// and when the keyboard arrived, and the ways the keyboard gets to a card. The
// full matrix of ways, kinds and delays that reviews run is built from the
// same parts, outside the suite.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";

export const MODEL = "scripted:stand-in";
export async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
}
export const folder = (name: string) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};
export const create = async (request: APIRequestContext, title: string, workspace: string) =>
  (await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json()).session.id as string;
export const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
// Stops every turn an earlier test left open: what waits on the owner is read across the daemon's sessions.
export async function settle(request: APIRequestContext) {
  const { sessions } = (await (await request.get("/api/sessions")).json()) as { sessions: { id: string; phase: string }[] };
  for (const s of sessions) if (s.phase === "working") await request.post(`/api/sessions/${s.id}/interrupt`, { data: { by: "owner" } });
}
export const drop = async (request: APIRequestContext, ...ids: string[]) => { for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }); await request.delete(`/api/sessions/${id}`); } };
// The session's turn is over: it can be asked again.
export const idle = (request: APIRequestContext, id: string) =>
  expect.poll(async () => ((await (await request.get("/api/sessions")).json()).sessions as { id: string; phase: string }[]).find((s) => s.id === id)?.phase, { timeout: 30_000 }).not.toBe("working");

export const colors = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal", description: "Calm and cool" }, { label: "Amber", description: "Warm" }, { label: "Slate" }], multiSelect: false }] } };
export const PLAN = "## Retry policy\n\n1. Read the importer.\n2. Change the retry policy.\n3. Run the tests.";
export const approvals = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { state: string; choice?: string }[];
export const pending = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending as string[];
export const secretsAsked = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/sessions/${id}/secrets`)).json()).requests?.length ?? 0) as number;
// What the owner answered, as the daemon stored it with the question's result.
export const answersOf = async (request: APIRequestContext, id: string) => {
  const { events } = await (await request.get(`/api/sessions/${id}`)).json();
  const shown = events.findLast((e: any) => e.kind === "tool_result" && e.data.shown)?.data.shown as Record<string, { answers: Record<string, { picked: string[]; other?: string }> }> | undefined;
  return shown ? Object.values(shown)[0]!.answers : undefined;
};
// What the owner sent as messages (not the scripts that set a test up).
export const said = async (request: APIRequestContext, id: string) => {
  const { events } = await (await request.get(`/api/sessions/${id}`)).json();
  return (events as any[]).filter((e) => e.kind === "user" && typeof e.data.text === "string" && !e.data.text.startsWith("script:")).map((e) => e.data.text as string);
};

// The kinds of card that wait above the message box, and how each is asked for and read.
export type Kind = "approval" | "question" | "plan" | "secret";
export const KINDS: Kind[] = ["approval", "question", "plan"];
export async function ask(request: APIRequestContext, id: string, kind: Kind, word = "w") {
  if (kind === "approval") {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word} > ${word}.txt` } }]) } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length, { timeout: 30_000 }).toBe(1);
  } else if (kind === "question") {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([colors]) } });
    await expect.poll(() => pending(request, id), { timeout: 30_000 }).toHaveLength(1);
  } else if (kind === "plan") {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "plan" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "present_plan", input: { plan: PLAN } }]) } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length, { timeout: 30_000 }).toBe(1);
  } else {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "request_secret", input: { name: "DEPLOY_KEY", purpose: "deploy check" } }]) } });
    await expect.poll(() => secretsAsked(request, id), { timeout: 30_000 }).toBe(1);
  }
}
// Whether the card still waits, whoever looks.
export const waits = async (request: APIRequestContext, id: string, kind: Kind) =>
  kind === "approval" ? (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length > 0
  : kind === "question" ? (await pending(request, id)).length > 0
  : kind === "plan" ? (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length > 0
  : (await secretsAsked(request, id)) > 0;
const CARD: Record<Kind, string> = { approval: "approvals", question: "question", plan: "plan-card", secret: "secret-request" };
export const pane = (page: Page, id: string) => page.locator(`section.k-station[data-station="${id}"]`);
export const cardIn = (page: Page, id: string, kind: Kind) => pane(page, id).getByTestId("composer-asks").getByTestId(CARD[kind]);
export const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);

// The page keeps time itself, so a slow machine cannot blur a case: when a card was drawn above a
// message box (`dom`), when the keyboard arrived on a card (`keys`), a moment the test names (`mark`),
// and for every key press how long after each of them it came and where the keyboard was. It also
// keeps every answer and every message the page sent.
export const SETTLE = 1000;
export async function watchKeys(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__k = { dom: null, keys: null, mark: null, presses: [], answers: [], sends: [] };
    const drawn = () => { if (w.__k.dom == null && document.querySelector('[data-testid="composer-asks"] [data-ask-card]')) w.__k.dom = performance.now(); };
    addEventListener("DOMContentLoaded", () => new MutationObserver(drawn).observe(document.body, { childList: true, subtree: true }));
    addEventListener("focusin", (e) => { if (w.__k.keys == null && (e.target as HTMLElement).closest?.("[data-ask-card]")) w.__k.keys = performance.now(); }, true);
    const since = (t: number | null) => (t == null ? null : Math.round(performance.now() - t));
    addEventListener("keydown", (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      w.__k.presses.push({ key: e.key, repeat: e.repeat, at: Math.round(performance.now()), dom: since(w.__k.dom), keys: since(w.__k.keys), mark: since(w.__k.mark), on: a?.dataset?.testid ?? a?.tagName ?? "" });
    }, true);
    const send = w.fetch.bind(w);
    w.fetch = (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const path = new URL(url, location.href).pathname;
      if ((init?.method ?? "GET") === "POST" && /\/api\/sessions\/[^/]+\/(approvals|questions|plan|secrets)(\/|$)/.test(path)) w.__k.answers.push({ path, dom: since(w.__k.dom), keys: since(w.__k.keys), mark: since(w.__k.mark) });
      if ((init?.method ?? "GET") === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(path)) w.__k.sends.push({ path, body: String(init?.body ?? "").slice(0, 200) });
      return send(input, init);
    };
  });
}
export const reset = (page: Page) => page.evaluate(() => { const k = (window as any).__k; k.dom = k.keys = k.mark = null; k.presses = []; k.answers = []; k.sends = []; if (document.querySelector('[data-testid="composer-asks"] [data-ask-card]')) k.dom = performance.now(); });
// Forgets when the keyboard last arrived (and when a card was drawn): the next arrival is the one timed.
export const rearm = (page: Page) => page.evaluate(() => { const k = (window as any).__k; k.dom = k.keys = k.mark = null; k.presses = []; });
export const mark = (page: Page) => page.evaluate(() => { (window as any).__k.mark = performance.now(); });
export type From = "dom" | "keys" | "mark";
// Waits in the page until `ms` after the moment named; false when that moment never came.
export const since = (page: Page, from: From, ms: number) => page.evaluate(([from, ms]) => new Promise<boolean>((done) => {
  const k = (window as any).__k, start = performance.now();
  const look = () => { const t = k[from as string]; if (t != null && performance.now() - t >= (ms as number)) done(true); else if (performance.now() - start > 9000) done(false); else setTimeout(look, 1); };
  look();
}), [from, ms] as const);
export type Press = { key: string; repeat: boolean; at: number; dom: number | null; keys: number | null; mark: number | null; on: string };
export const presses = (page: Page) => page.evaluate(() => (window as any).__k.presses as Press[]);
export type Sent = { path: string; dom: number | null; keys: number | null; mark: number | null };
export const answersSent = (page: Page) => page.evaluate(() => (window as any).__k.answers as Sent[]);
export const messagesSent = (page: Page) => page.evaluate(() => (window as any).__k.sends as { path: string; body: string }[]);

// Sets the panes up (the first is the helm) and opens the page on the first session. `drafts`: what
// the message boxes of sessions hold, unsent, from an earlier visit.
export async function open(page: Page, ids: string[], drafts: Record<string, string> = {}) {
  // From a page of this origin that runs none of the app: an open page would write its own panes back.
  await page.goto("/api/daemon");
  await page.evaluate(([slots, drafts]) => {
    localStorage.setItem("keel.focus", "false");
    localStorage.setItem("keel.panes", JSON.stringify({ count: slots.length, slots, sizes: {}, active: 0 }));
    for (const [id, text] of Object.entries(drafts)) localStorage.setItem(`keel.draft.${id}`, text);
  }, [ids, drafts] as const);
  await page.goto(`/s/${ids[0]}`);
  for (const id of ids) await expect(pane(page, id)).toBeVisible();
  await expect(pane(page, ids[0]!).getByTestId("composer")).toBeFocused();
}

// What a hand does with each card right after the keyboard arrived: the plain key, then the
// deliberate way to its answer and the key again. All of it is refused within the settle time.
export const EARLY: Record<Exclude<Kind, "secret">, string[]> = { approval: ["Enter", "ArrowDown", "Enter"], question: ["Enter", "ArrowDown", "Enter"], plan: ["Enter", "Tab", "Enter"] };
// The same hand once the keyboard has been on the card for the settle time: it answers. After
// EARLY the keyboard is one step into the card (on Allow once, on the first option, on Approve).
// `own`: the owner brought the keyboard (the key that goes to what waits): a number answers a question.
export async function answerOnPurpose(page: Page, request: APIRequestContext, id: string, kind: Exclude<Kind, "secret">, own: boolean) {
  const card = cardIn(page, id, kind);
  await expect(card).toHaveAttribute("data-keys", "ready");
  if (kind === "approval") {
    await expect(card.getByTestId("allow-once")).toBeFocused();
    await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
    await page.keyboard.press("Enter");
  } else if (kind === "question") {
    await expect(card.getByRole("radio", { name: "Teal" })).toBeFocused();
    if (own) {
      // The numbers are the card's now, and drawn.
      await expect(card.getByTestId("question-digit")).toHaveCount(3);
      await page.keyboard.press("2");
    } else {
      await expect(card.getByTestId("question-digit")).toHaveCount(0);
      await page.keyboard.press("ArrowDown");
      await expect(card.getByRole("radio", { name: "Amber" })).toBeFocused();
      await page.keyboard.press("Enter");
    }
  } else {
    await expect(card.getByTestId("plan-approve")).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect.poll(() => waits(request, id, kind)).toBe(false);
  if (kind === "question") expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Amber"] } });
}

// One arrival of the keyboard on a card, read at the two delays that decide: 300 ms after it every
// key is refused, 1,200 ms after it the deliberate way answers. `from` names the clock the arrival
// is read on.
export async function arrives(page: Page, request: APIRequestContext, o: { way: string; kind: Exclude<Kind, "secret">; target: string; from: From; own: boolean }) {
  expect(await since(page, o.from, 300), `the keyboard never arrived (${o.way}, ${o.kind})`).toBe(true);
  for (const k of EARLY[o.kind]) await page.keyboard.press(k);
  const log = await presses(page), sent = await answersSent(page);
  // No answer to it left the page within the settle time of the arrival, whatever was pressed.
  expect(sent.filter((a) => a.path.includes(o.target) && (a[o.from] ?? 0) < SETTLE), `${o.way}: answered early by ${JSON.stringify(log)}`).toEqual([]);
  // Where every press came inside the settle time, it still waits. (A machine too slow to press in
  // time proves only the line above, and says so.)
  if (log.every((p) => (p[o.from] ?? 0) < SETTLE)) expect(await waits(request, o.target, o.kind), `${o.way}: answered by ${JSON.stringify(log)}`).toBe(true);
  else console.log(`slow at 300 ms (${o.way}, ${o.kind}): pressed at ${JSON.stringify(log.map((p) => p[o.from]))}`);
  expect(await since(page, o.from, 1200)).toBe(true);
  await answerOnPurpose(page, request, o.target, o.kind, o.own);
}

// A session that waits on an approval of one command.
export async function asksToRun(request: APIRequestContext, title: string, ws: string, word: string) {
  const id = await create(request, title, ws);
  await ask(request, id, "approval", word);
  return id;
}

// A step of the answering sequence onto a session whose message box holds an unsent draft, with
// Enter pressed again shortly after the answering Enter (not a repeat). The pane the sequence moves
// to must not have the keyboard in its message box, not for a frame: the second Enter sent the
// draft as a message in five runs of eight. In four panes (the helm moves, no pane opens), then in
// one pane `runs` times at each of 50, 100, 150 and 200 ms.
export async function secondEnter(page: Page, request: APIRequestContext, runs: number) {
  const ws = folder("second-enter");
  const DRAFT = "deploy it now";
  const allowOf = (id: string) => cardIn(page, id, "approval").getByTestId("allow-once");
  const ready = async (id: string) => { await expect(allowOf(id)).toBeFocused(); await expect(cardIn(page, id, "approval").getByTestId("approval")).toHaveAttribute("data-live", "true"); };
  // Enter answers, and Enter again `d` ms later (not a repeat): the second lands while the sequence moves on.
  const twice = async (d: number) => {
    const one = page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, d));
    await Promise.all([one, page.keyboard.press("Enter")]);
  };
  const gaps = async () => { const e = (await presses(page)).filter((p) => p.key === "Enter" && !p.repeat); return e.length > 1 ? e.at(-1)!.at - e.at(-2)!.at : -1; };

  // Four panes, each session on screen: the helm moves, no pane opens.
  const panes: string[] = [];
  for (let i = 0; i < 4; i++) panes.push(await asksToRun(request, `On screen ${i}`, ws, `screen${i}`));
  await open(page, panes, Object.fromEntries(panes.map((id) => [id, DRAFT])));
  for (const id of panes) await expect(cardIn(page, id, "approval")).toBeVisible();
  await page.keyboard.press("Alt+a");
  // (The first pane is the helm and holds a draft: its card took nothing by itself, and the key goes to it.)
  await ready(panes[0]!);
  for (const [i, d] of [50, 100, 200].entries()) {
    await rearm(page);
    await twice(d);
    await expect(pane(page, panes[i + 1]!)).toHaveAttribute("data-helm", "true");
    await ready(panes[i + 1]!);
    await expect(pane(page, panes[i + 1]!).getByTestId("composer")).toHaveValue(DRAFT);
    expect(await messagesSent(page), `four panes, second Enter ${await gaps()} ms after the first`).toEqual([]);
  }
  for (const id of panes.slice(0, 3)) await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect((await approvals(request, panes[3]!))[0]).toMatchObject({ state: "pending" });
  await drop(request, ...panes);

  // One pane: each step opens the next session's pane. `runs` at each delay.
  const DELAYS = [50, 100, 150, 200], RUNS = runs;
  const quiet = await create(request, "Nothing waits here", ws);
  const chain: string[] = [];
  for (let i = 0; i <= DELAYS.length * RUNS; i++) chain.push(await asksToRun(request, `Step ${i}`, ws, `step${i}`));
  await open(page, [quiet], Object.fromEntries(chain.slice(1).map((id) => [id, DRAFT])));
  await expect(row(page, chain[0]!)).toHaveAttribute("data-watch", "need");
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${chain[0]}$`));
  await ready(chain[0]!);
  const seen: Record<number, number[]> = {};
  for (let i = 0; i < DELAYS.length * RUNS; i++) {
    const d = DELAYS[i % DELAYS.length]!, next = chain[i + 1]!;
    await rearm(page);
    await twice(d);
    await expect(page).toHaveURL(new RegExp(`/s/${next}$`));
    // The next request has the keyboard, unanswered, and the draft is still a draft.
    await ready(next);
    await expect(page.getByTestId("composer")).toHaveValue(DRAFT);
    (seen[d] ??= []).push(await gaps());
    expect(await messagesSent(page), `one pane, run ${i}: second Enter ${seen[d]!.at(-1)} ms after the first`).toEqual([]);
  }
  console.log(`second Enter, ms after the first, by delay asked: ${JSON.stringify(seen)}`);
  for (const id of chain.slice(0, -1)) expect((await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect((await approvals(request, chain.at(-1)!))[0]).toMatchObject({ state: "pending" });
  for (const id of chain.slice(1)) expect(await said(request, id)).toEqual([]);

  // The second line: a message box the keyboard was moved to by code sends nothing on Enter within
  // the settle time. The last request is answered from another device; the sequence ends, the
  // keyboard goes to the box, and the Enter that was meant for the card sends no draft.
  const lastId = (await (await request.get(`/api/sessions/${chain.at(-1)}/approvals`)).json()).approvals[0].id as string;
  await rearm(page);
  expect((await request.post(`/api/sessions/${chain.at(-1)}/approvals/${lastId}`, { data: { choice: "once" } })).ok()).toBe(true);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-notice")).toHaveText("Not yet: the keyboard has only just arrived");
  await expect(page.getByTestId("composer")).toHaveValue(DRAFT);
  expect(await messagesSent(page)).toEqual([]);
  // Once the owner types in it, the box is theirs: Enter sends.
  await page.keyboard.type("!");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await said(request, chain.at(-1)!)).join()).toContain(DRAFT);
  await drop(request, quiet, ...chain);
}
