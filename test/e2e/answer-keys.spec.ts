import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: answering what waits on the owner by keyboard. Each test names the rule it holds.
const MODEL = "scripted:stand-in";
// Every pane on screen: no focus mode (the config's default for the other specs).
test.use({ storageState: { cookies: [], origins: [] } });

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === MODEL), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
}
const folder = (name: string) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `${name}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  return ws;
};
const create = async (request: APIRequestContext, title: string, workspace: string) =>
  (await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json()).session.id as string;
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
// Stops every turn an earlier test left open: what waits on the owner is read across the daemon's sessions.
async function settle(request: APIRequestContext) {
  const { sessions } = (await (await request.get("/api/sessions")).json()) as { sessions: { id: string; phase: string }[] };
  for (const s of sessions) if (s.phase === "working") await request.post(`/api/sessions/${s.id}/interrupt`);
}
// A session that waits on an approval of one command.
async function asksToRun(request: APIRequestContext, title: string, ws: string, word: string) {
  const id = await create(request, title, ws);
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word} > ${word}.txt` } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length).toBe(1);
  return id;
}
const approvals = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/sessions/${id}/approvals?all`)).json()).approvals as { state: string; choice?: string }[];
const keysOn = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? document.activeElement?.tagName ?? "");

test("Esc twice on an approval gives the keyboard back to Allow once", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await asksToRun(request, "Esc and back", folder("esc"), "escback");
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("approval");
  const allow = card.getByTestId("allow-once");
  await expect(allow).toBeFocused();
  // Esc opens the reason, Esc again leaves it: the keyboard is on Allow once, not on the page.
  await page.keyboard.press("Escape");
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(allow).toBeFocused();
  expect(await keysOn(page)).toBe("allow-once");
  await shoot(page, "answer-keys-01-esc-back");
  // The Back button does the same.
  await page.keyboard.press("Escape");
  await card.getByRole("button", { name: "Back" }).click();
  await expect(allow).toBeFocused();
  // And Enter still allows, once the button has stood for its second.
  await expect(card).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  await expect(page.getByTestId("composer")).toBeFocused();
  await request.delete(`/api/sessions/${id}`);

  // A card whose command is not all on it takes no answer: leaving the reason puts the keyboard
  // on the list of requests, where the card's own rule keeps it, and Enter there answers nothing.
  const long = await create(request, "Esc and back, cut", folder("esc-cut"));
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  const lines = `${Array.from({ length: 40 }, (_, i) => `echo step ${i + 1}`).join("\n")}\necho last > last.txt`;
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "Bash", input: { command: lines } }]) } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${long}/approvals`)).json()).approvals.length).toBe(1);
  await page.goto(`/s/${long}`);
  await expect(card).toHaveAttribute("data-must-open", "true");
  const list = page.getByTestId("approvals");
  await expect(list).toBeFocused();
  await card.getByTestId("deny").click();
  await expect(card.getByTestId("deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  expect((await approvals(request, long))[0]).toMatchObject({ state: "pending" });
  await request.post(`/api/sessions/${long}/interrupt`);
  await request.delete(`/api/sessions/${long}`);
});

const colors = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal", description: "Calm and cool" }, { label: "Amber", description: "Warm" }, { label: "Slate" }], multiSelect: false }] } };
const twoParts = { name: "AskUserQuestion", input: { questions: [
  { header: "Checks", question: "Which checks should run?", options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }], multiSelect: true },
  { header: "Branch", question: "Which branch is the base?", options: [{ label: "main" }, { label: "release" }], multiSelect: false },
] } };
const PLAN = "## Retry policy\n\n1. Read the importer.\n2. Change the retry policy.\n3. Run the tests.";
const pending = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}/questions`)).json()).pending as string[];
// What the owner answered, as the daemon stored it with the question's result.
const answersOf = async (request: APIRequestContext, id: string) => {
  const { events } = await (await request.get(`/api/sessions/${id}`)).json();
  const shown = events.findLast((e: any) => e.kind === "tool_result" && e.data.shown)?.data.shown as Record<string, { answers: Record<string, { picked: string[]; other?: string }> }> | undefined;
  return shown ? Object.values(shown)[0]!.answers : undefined;
};
// What the owner sent as messages (not the scripts that set a test up).
const said = async (request: APIRequestContext, id: string) => {
  const { events } = await (await request.get(`/api/sessions/${id}`)).json();
  return (events as any[]).filter((e) => e.kind === "user" && typeof e.data.text === "string" && !e.data.text.startsWith("script:")).map((e) => e.data.text as string);
};

// The three kinds of card that wait above the message box, and how each is asked for and read.
type Kind = "approval" | "question" | "plan";
const KINDS: Kind[] = ["approval", "question", "plan"];
async function ask(request: APIRequestContext, id: string, kind: Kind, word = "w") {
  if (kind === "approval") {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "Bash", input: { command: `echo ${word} > ${word}.txt` } }]) } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals.length).toBe(1);
  } else if (kind === "question") {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([colors]) } });
    await expect.poll(() => pending(request, id)).toHaveLength(1);
  } else {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "plan" } });
    await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "present_plan", input: { plan: PLAN } }]) } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length, { timeout: 30_000 }).toBe(1);
  }
}
// Whether the card still waits, whoever looks.
const waits = async (request: APIRequestContext, id: string, kind: Kind) =>
  kind === "approval" ? (await approvals(request, id)).every((a) => a.state === "pending")
  : kind === "question" ? (await pending(request, id)).length > 0
  : (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length > 0;
const drop = async (request: APIRequestContext, ...ids: string[]) => { for (const id of ids) { await request.post(`/api/sessions/${id}/interrupt`); await request.delete(`/api/sessions/${id}`); } };
const CARD: Record<Kind, string> = { approval: "approvals", question: "question", plan: "plan-card" };
const pane = (page: Page, id: string) => page.locator(`section.k-station[data-station="${id}"]`);
const cardIn = (page: Page, id: string, kind: Kind) => pane(page, id).getByTestId("composer-asks").getByTestId(CARD[kind]);

// The page keeps time itself, so a slow machine cannot blur a case: when a card was drawn above a
// message box (`dom`), when the keyboard arrived on a card (`keys`), a moment the test names (`mark`),
// and for every key press how long after each of them it came and where the keyboard was.
const SETTLE = 1000;
const DELAYS = [50, 300, 800, 1200];
async function watchKeys(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__k = { dom: null, keys: null, mark: null, presses: [], answers: [] };
    const drawn = () => { if (w.__k.dom == null && document.querySelector('[data-testid="composer-asks"] [data-ask-card]')) w.__k.dom = performance.now(); };
    addEventListener("DOMContentLoaded", () => new MutationObserver(drawn).observe(document.body, { childList: true, subtree: true }));
    addEventListener("focusin", (e) => { if (w.__k.keys == null && (e.target as HTMLElement).closest?.("[data-ask-card]")) w.__k.keys = performance.now(); }, true);
    const since = (t: number | null) => (t == null ? null : Math.round(performance.now() - t));
    addEventListener("keydown", (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      w.__k.presses.push({ key: e.key, repeat: e.repeat, dom: since(w.__k.dom), keys: since(w.__k.keys), mark: since(w.__k.mark), on: a?.dataset?.testid ?? a?.tagName ?? "" });
    }, true);
    // Every answer this page sends, with how long after each moment it left.
    const send = w.fetch.bind(w);
    w.fetch = (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if ((init?.method ?? "GET") === "POST" && /\/api\/sessions\/[^/]+\/(approvals|questions|plan|secrets)(\/|$)/.test(url)) w.__k.answers.push({ path: new URL(url, location.href).pathname, dom: since(w.__k.dom), keys: since(w.__k.keys), mark: since(w.__k.mark) });
      return send(input, init);
    };
  });
}
const reset = (page: Page) => page.evaluate(() => { const k = (window as any).__k; k.dom = k.keys = k.mark = null; k.presses = []; k.answers = []; if (document.querySelector('[data-testid="composer-asks"] [data-ask-card]')) k.dom = performance.now(); });
const mark = (page: Page) => page.evaluate(() => { (window as any).__k.mark = performance.now(); });
type From = "dom" | "keys" | "mark";
// Waits in the page until `ms` after the moment named; false when that moment never came.
const since = (page: Page, from: From, ms: number) => page.evaluate(([from, ms]) => new Promise<boolean>((done) => {
  const k = (window as any).__k, start = performance.now();
  const look = () => { const t = k[from as string]; if (t != null && performance.now() - t >= (ms as number)) done(true); else if (performance.now() - start > 9000) done(false); else setTimeout(look, 1); };
  look();
}), [from, ms] as const);
type Press = { key: string; repeat: boolean; dom: number | null; keys: number | null; mark: number | null; on: string };
const presses = (page: Page) => page.evaluate(() => (window as any).__k.presses as Press[]);
type Sent = { path: string; dom: number | null; keys: number | null; mark: number | null };
const answersSent = (page: Page) => page.evaluate(() => (window as any).__k.answers as Sent[]);
// What a hand can do with each card from the keyboard: the plain key, then the deliberate way to
// its answer and the key again. Where the card does not hold the keyboard, the plain keys only.
const TRY: Record<Kind, string[]> = { approval: ["Enter", "ArrowDown", "Enter", "Space"], question: ["2", "Enter", "ArrowDown", "Enter"], plan: ["Enter", "Tab", "Enter", "Space"] };
const PLAIN: Record<Kind, string[]> = { approval: ["Enter", "Space"], question: ["2", "Enter"], plan: ["Enter", "Space"] };

// Sets the panes up (the first is the helm) and opens the page on the first session.
async function open(page: Page, ids: string[]) {
  // From a page of this origin that runs none of the app: an open page would write its own panes back.
  await page.goto("/api/daemon");
  await page.evaluate((slots) => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.panes", JSON.stringify({ count: slots.length, slots, sizes: {}, active: 0 })); }, ids);
  await page.goto(`/s/${ids[0]}`);
  for (const id of ids) await expect(pane(page, id)).toBeVisible();
  await expect(pane(page, ids[0]!).getByTestId("composer")).toBeFocused();
}
// The deliberate way to an answer, once the keyboard has been on the card for the settle time: it answers.
async function answerOnPurpose(page: Page, request: APIRequestContext, id: string, kind: Kind) {
  const card = cardIn(page, id, kind);
  await expect(card).toHaveAttribute("data-keys", "ready");
  if (kind === "approval") {
    await expect(card.getByTestId("allow-once")).toBeFocused();
    await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
    await page.keyboard.press("Enter");
  } else if (kind === "question") {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(card.getByRole("radio", { name: "Amber" })).toBeFocused();
    await page.keyboard.press("Enter");
  } else {
    await expect(card.getByTestId("plan-text")).toBeFocused();
    await page.keyboard.press("Enter"); // on the text: nothing
    await page.keyboard.press("Tab");
    await expect(card.getByTestId("plan-approve")).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect.poll(() => waits(request, id, kind)).toBe(false);
  if (kind === "question") expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Amber"] } });
}

// Every way the keyboard gets to a card, in one pane and in four. `arrive` brings the page to the
// moment the keyboard is on the target's card, or would have been on main (`from` names the clock).
// `takes`: the card holds the keyboard afterwards; where it does not, what is typed is the message box's.
type Way = { name: string; panes: 1 | 4; kinds: Kind[]; from: From; takes: boolean; arrive: (page: Page, request: APIRequestContext, kind: Kind, ws: string, tag: string) => Promise<{ target: string; all: string[] }> };
const fill = async (request: APIRequestContext, ws: string, tag: string, n: number) => { const ids: string[] = []; for (let i = 0; i < n; i++) ids.push(await create(request, `Beside ${i} ${tag}`, ws)); return ids; };
const WAYS: Way[] = [
  { name: "the card appears in the session worked in", panes: 1, kinds: KINDS, from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const target = await create(request, `Appears ${tag}`, ws);
    await open(page, [target]);
    await reset(page);
    await ask(request, target, kind);
    return { target, all: [target] };
  } },
  { name: "the page loads on a session that asks (a link, a restart)", panes: 1, kinds: KINDS, from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const target = await create(request, `Loads ${tag}`, ws);
    await ask(request, target, kind);
    await page.goto(`/s/${target}`);
    return { target, all: [target] };
  } },
  { name: "the key that goes to what waits", panes: 1, kinds: ["approval", "question"], from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const quiet = await create(request, `Quiet ${tag}`, ws);
    const target = await create(request, `Waits ${tag}`, ws);
    await ask(request, target, kind);
    await open(page, [quiet]);
    await reset(page);
    await page.keyboard.press("Alt+a");
    await expect(page).toHaveURL(new RegExp(`/s/${target}$`));
    return { target, all: [quiet, target] };
  } },
  { name: "a step of the answering sequence", panes: 1, kinds: ["approval", "question"], from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const quiet = await create(request, `Quiet ${tag}`, ws);
    const first = await create(request, `First ${tag}`, ws);
    await ask(request, first, "approval", "first");
    const target = await create(request, `Next ${tag}`, ws);
    await ask(request, target, kind);
    await open(page, [quiet]);
    await page.keyboard.press("Alt+a");
    await expect(page).toHaveURL(new RegExp(`/s/${first}$`));
    await expect(cardIn(page, first, "approval").getByTestId("allow-once")).toBeFocused();
    await expect(cardIn(page, first, "approval").getByTestId("approval")).toHaveAttribute("data-live", "true");
    await reset(page);
    await page.evaluate(() => { (window as any).__k.dom = null; });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/${target}$`));
    return { target, all: [quiet, first, target] };
  } },
  { name: "the card appears in the pane worked in", panes: 4, kinds: KINDS, from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const target = await create(request, `Appears ${tag}`, ws);
    const rest = await fill(request, ws, tag, 3);
    await open(page, [target, ...rest]);
    await reset(page);
    await ask(request, target, kind);
    return { target, all: [target, ...rest] };
  } },
  { name: "the card appears in the pane beside", panes: 4, kinds: KINDS, from: "dom", takes: false, arrive: async (page, request, kind, ws, tag) => {
    const helm = await create(request, `Worked in ${tag}`, ws);
    const target = await create(request, `Beside ${tag}`, ws);
    const rest = await fill(request, ws, tag, 2);
    await open(page, [helm, target, ...rest]);
    await reset(page);
    await ask(request, target, kind);
    await expect(cardIn(page, target, kind)).toBeVisible();
    return { target, all: [helm, target, ...rest] };
  } },
  { name: "the key that goes to what waits, to a pane on screen", panes: 4, kinds: KINDS, from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const helm = await create(request, `Worked in ${tag}`, ws);
    const target = await create(request, `Waits ${tag}`, ws);
    await ask(request, target, kind);
    const rest = await fill(request, ws, tag, 2);
    await open(page, [helm, target, ...rest]);
    await expect(cardIn(page, target, kind)).toBeVisible();
    await page.waitForTimeout(SETTLE + 200); // the card has stood on screen: only the keyboard's arrival is new
    await reset(page);
    await page.keyboard.press("Alt+a");
    await expect(pane(page, target)).toHaveAttribute("data-helm", "true");
    return { target, all: [helm, target, ...rest] };
  } },
  { name: "Next pane, onto a pane that asks", panes: 4, kinds: KINDS, from: "mark", takes: false, arrive: async (page, request, kind, ws, tag) => {
    const helm = await create(request, `Worked in ${tag}`, ws);
    const target = await create(request, `Next pane ${tag}`, ws);
    await ask(request, target, kind);
    const rest = await fill(request, ws, tag, 2);
    await open(page, [helm, target, ...rest]);
    await expect(cardIn(page, target, kind)).toBeVisible();
    await page.waitForTimeout(SETTLE + 200);
    await reset(page);
    await page.keyboard.press("Alt+]");
    await mark(page);
    await expect(pane(page, target)).toHaveAttribute("data-helm", "true");
    return { target, all: [helm, target, ...rest] };
  } },
  { name: "a step of the answering sequence, both panes on screen", panes: 4, kinds: ["approval", "question"], from: "keys", takes: true, arrive: async (page, request, kind, ws, tag) => {
    const helm = await create(request, `Worked in ${tag}`, ws);
    const first = await create(request, `First ${tag}`, ws);
    await ask(request, first, "approval", "first");
    const target = await create(request, `Next ${tag}`, ws);
    await ask(request, target, kind);
    const last = await create(request, `Beside ${tag}`, ws);
    await open(page, [helm, first, target, last]);
    await expect(cardIn(page, target, kind)).toBeVisible();
    await page.keyboard.press("Alt+a");
    await expect(pane(page, first)).toHaveAttribute("data-helm", "true");
    await expect(cardIn(page, first, "approval").getByTestId("allow-once")).toBeFocused();
    await expect(cardIn(page, first, "approval").getByTestId("approval")).toHaveAttribute("data-live", "true");
    await reset(page);
    await page.keyboard.press("Enter");
    await expect(pane(page, target)).toHaveAttribute("data-helm", "true");
    return { target, all: [helm, first, target, last] };
  } },
];

for (const way of WAYS) for (const kind of way.kinds) {
  test(`no key answers ${kind === "approval" ? "an approval" : `a ${kind}`} as the keyboard arrives: ${way.name} (${way.panes === 1 ? "one pane" : "four panes"})`, async ({ page, request }) => {
    await scripted(request);
    await settle(request);
    await watchKeys(page);
    const ws = folder("arrive");
    for (const ms of DELAYS) {
      const { target, all } = await way.arrive(page, request, kind, ws, `${kind} ${ms}`);
      expect(await since(page, way.from, ms), `the keyboard never arrived (${way.name}, ${kind})`).toBe(true);
      if (ms < SETTLE || !way.takes) {
        for (const k of way.takes ? TRY[kind] : PLAIN[kind]) await page.keyboard.press(k);
        await page.waitForTimeout(500);
        const log = await presses(page), sent = await answersSent(page);
        // No answer to it left the page within the settle time of the arrival, whatever was pressed.
        expect(sent.filter((a) => a.path.includes(target) && (a[way.from] ?? 0) < SETTLE), `answered early by ${JSON.stringify(log)}`).toEqual([]);
        // Where every press came inside the settle time, or the card never held the keyboard, it still waits.
        // (A machine too slow to press in time proves only the line above, and says so.)
        if (!way.takes || log.every((p) => (p[way.from] ?? 0) < SETTLE)) expect(await waits(request, target, kind), `answered by ${JSON.stringify(log)}`).toBe(true);
        else console.log(`slow at ${ms} ms (${way.name}, ${kind}): pressed at ${JSON.stringify(log.map((p) => p[way.from]))}`);
        if (!way.takes && kind === "question") await expect(cardIn(page, target, kind).locator('[aria-checked="true"]')).toHaveCount(0);
      } else {
        // After the settle time the deliberate way answers, in every layout.
        await answerOnPurpose(page, request, target, kind);
      }
      await drop(request, ...all);
    }
  });
}

// What the owner types as a card arrives is theirs: it lands in the message box, whole and in order.
for (const kind of KINDS) {
  test(`typing through ${kind === "approval" ? "an approval" : `a ${kind}`} that arrives lands in the message box, whole`, async ({ page, request }) => {
    await scripted(request);
    await settle(request);
    await watchKeys(page);
    const ws = folder("typing");
    const words = kind === "question" ? "2 more things" : "no wait";
    const box = (id: string) => pane(page, id).getByTestId("composer");
    // The card took the keyboard from the empty box a moment ago; the words come right after.
    for (const ms of [100, 1100]) {
      const id = await create(request, `Typing ${kind} ${ms}`, ws);
      await open(page, [id]);
      await reset(page);
      await ask(request, id, kind);
      expect(await since(page, "keys", ms)).toBe(true);
      await page.keyboard.type(words, { delay: 20 });
      await expect(box(id)).toHaveValue(words);
      await expect(box(id)).toBeFocused();
      expect(await waits(request, id, kind)).toBe(true);
      if (kind === "question") {
        await expect(cardIn(page, id, kind).locator('[aria-checked="true"]')).toHaveCount(0);
        // Their Enter sends the words as a message (it waits its turn: the question holds the turn); the question keeps waiting, unanswered.
        await page.keyboard.press("Enter");
        await expect(box(id)).toHaveValue("");
        await expect(pane(page, id).getByTestId("queue-item")).toContainText(words);
        expect(await waits(request, id, kind)).toBe(true);
        expect(await answersOf(request, id)).toBeUndefined();
      }
      expect(await answersSent(page)).toEqual([]);
      await drop(request, id);
    }
    // Words already on their way when the card is drawn: none is lost to it.
    const id = await create(request, `Typing on ${kind}`, ws);
    await open(page, [id]);
    await reset(page);
    const long = "keep typing 2 while it arrives, no wait";
    const typed = page.keyboard.type(long, { delay: 35 });
    await ask(request, id, kind);
    await typed;
    await expect(box(id)).toHaveValue(long);
    expect(await waits(request, id, kind)).toBe(true);
    expect(await answersSent(page)).toEqual([]);
    await drop(request, id);
  });

  test(`a held Enter answers no ${kind}`, async ({ page, request }) => {
    await scripted(request);
    await settle(request);
    await watchKeys(page);
    const id = await create(request, `Held ${kind}`, folder("held"));
    await open(page, [id]);
    await reset(page);
    // Enter goes down in the empty box before the card is there and stays down past the settle time.
    await page.keyboard.down("Enter");
    await ask(request, id, kind);
    const until = Date.now() + 2600;
    while (Date.now() < until) { await page.keyboard.down("Enter"); await page.waitForTimeout(30); }
    await page.keyboard.up("Enter");
    await page.waitForTimeout(400);
    const log = await presses(page);
    // The key was still held after the card had stood for the settle time (and, for an approval, its Allow had the keyboard).
    expect(log.some((p) => p.repeat && (p.dom ?? 0) > SETTLE + 500)).toBe(true);
    expect(await answersSent(page)).toEqual([]);
    expect(await waits(request, id, kind)).toBe(true);
    await drop(request, id);
  });
}

test("a card never takes the keyboard from another pane, and what is typed there stays there", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("beside");
  for (const kind of ["plan", "question"] as Kind[]) {
    const helm = await create(request, `Worked in ${kind}`, ws);
    const beside = await create(request, `Beside ${kind}`, ws);
    await open(page, [helm, beside]);
    await reset(page);
    await ask(request, beside, kind);
    await expect(cardIn(page, beside, kind)).toBeVisible();
    await page.waitForTimeout(SETTLE + 300);
    // The keyboard is still in the box of the pane worked in, and the words and their Enter are that session's.
    await expect(pane(page, helm).getByTestId("composer")).toBeFocused();
    await page.keyboard.type("2 more things", { delay: 20 });
    await page.keyboard.press("Enter");
    await expect.poll(() => said(request, helm)).toEqual(["2 more things"]);
    expect(await said(request, beside)).toEqual([]);
    expect(await waits(request, beside, kind)).toBe(true);
    expect(await answersSent(page)).toEqual([]);
    await drop(request, helm, beside);
  }
});

test("nothing answers and no command key acts under a dialog", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("overlay");
  const quiet = await create(request, "Nothing waits here", ws);
  const asks = await asksToRun(request, "Waits under a dialog", ws, "under");
  await open(page, [quiet]);
  const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${asks}"]`);
  await expect(row).toHaveAttribute("data-watch", "need");
  const sheet = page.getByTestId("shortcuts");
  const dialogs = () => page.locator('[role="dialog"]').count();

  // The shortcut sheet is open: the keys that go somewhere go nowhere, and no second dialog opens over it.
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
  for (const key of ["Alt+a", "Alt+b", "Alt+r", "Alt+l"]) await page.keyboard.press(key);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(new RegExp(`/s/${quiet}$`));
  expect(await dialogs()).toBe(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="session-row"], [data-ask-card]'))).toBe(false);
  await shoot(page, "answer-keys-10-keys-under-sheet");
  // The sheet's own key still closes it.
  await page.keyboard.press("Control+/");
  await expect(sheet).toHaveCount(0);
  // The palette the same.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press("Alt+a");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(new RegExp(`/s/${quiet}$`));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);

  // On the card, its Allow ready: a dialog opens over it. The Allow no longer stands live, and a press
  // that reaches it anyway (focus put there by code, then a key's click) answers nothing.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${asks}$`));
  const card = cardIn(page, asks, "approval");
  await expect(card.getByTestId("allow-once")).toBeFocused();
  await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  await page.keyboard.press("Control+/");
  await expect(sheet).toBeVisible();
  await expect(card.getByTestId("approval")).not.toHaveAttribute("data-live", "true");
  await page.waitForTimeout(SETTLE + 300);
  await card.getByTestId("allow-once").evaluate((el: HTMLElement) => { el.focus(); el.click(); });
  await page.waitForTimeout(400);
  expect(await answersSent(page)).toEqual([]);
  expect(await waits(request, asks, "approval")).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await drop(request, quiet, asks);
});

test("the sequence moves on only after the owner's own answer from this page", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("elsewhere");
  const quiet = await create(request, "Nothing waits here", ws);
  const a = await asksToRun(request, "Answered elsewhere", ws, "elsewhere");
  const b = await asksToRun(request, "Still waits", ws, "still");
  await open(page, [quiet]);
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${a}$`));
  await expect(cardIn(page, a, "approval").getByTestId("allow-once")).toBeFocused();
  await expect(page.getByTestId("waiting-elsewhere")).toHaveAttribute("data-on", "true");
  // The first request is answered from another device: the page stays where it is, and the sequence is over.
  const open1 = (await (await request.get(`/api/sessions/${a}/approvals`)).json()).approvals[0].id as string;
  expect((await request.post(`/api/sessions/${a}/approvals/${open1}`, { data: { choice: "once" } })).ok()).toBe(true);
  await expect(cardIn(page, a, "approval")).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page).toHaveURL(new RegExp(`/s/${a}$`));
  await expect(pane(page, a).getByTestId("composer")).toBeFocused();
  // Enter now is the empty box's: the request that still waits in the other session is not answered.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(SETTLE + 300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(await waits(request, b, "approval")).toBe(true);
  expect(await answersSent(page)).toEqual([]);
  await drop(request, quiet, a, b);
});

test("a question docks above the message box and is answered from the keyboard", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Pick a color", folder("question"));
  // A long conversation first: the question must not scroll away with it.
  await request.post(`/api/sessions/${id}/messages`, { data: { text: "script:fill" } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
  await ask(request, id, "question");

  await page.goto(`/s/${id}`);
  const card = page.getByTestId("composer-asks").getByTestId("question");
  await expect(card).toHaveAttribute("data-state", "open");
  // Docked: in the region above the message box, where approvals wait, and one line in the conversation.
  await expect(page.getByTestId("transcript").getByTestId("question")).toHaveCount(0);
  await expect(page.getByTestId("transcript").getByTestId("question-asked")).toContainText("Which color should I use?");
  // It takes the keyboard as it opens: on the card, not on an answer. It says what the keys do once they act.
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await expect(card.getByTestId("question-hint")).toHaveText("Up and Down choose, Enter sends");
  await shoot(page, "answer-keys-02-question-docked");
  // At any scroll position of the conversation the card stays whole in view.
  const whole = () => card.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 0; });
  for (const top of [0, 3000, 1e9]) {
    await page.evaluate((y) => { document.querySelector<HTMLElement>(".k-reading")!.scrollTop = y; }, top);
    await page.waitForTimeout(150);
    expect(await whole()).toBe(true);
  }
  await page.evaluate(() => { document.querySelector<HTMLElement>(".k-reading")!.scrollTop = 0; });
  await shoot(page, "answer-keys-03-question-scrolled-up");

  // Enter with nothing chosen says why it does nothing. Down goes to the first option, and Enter there answers with it.
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-nudge")).toHaveText("Choose an answer or type one first");
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("radio", { name: "Teal" })).toBeFocused();
  // The keyboard is the owner's on the card now: the numbers are lit, and the hint names them.
  await expect(card).toHaveAttribute("data-own", "true");
  await expect(card.getByTestId("question-hint")).toHaveText("Press 1 to 3 to answer, or Up and Down then Enter");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("transcript").getByTestId("question")).toHaveAttribute("data-state", "answered");
  expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Teal"] } });
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  await expect(page.getByTestId("composer")).toHaveValue("");
  await drop(request, id);
});

test("a question with several parts: numbers choose in the part the keyboard is in, Enter sends what is shown", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const id = await create(request, "Checks and base", folder("question-parts"));
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([twoParts, colors]) } });
  await expect.poll(() => pending(request, id)).toHaveLength(1);
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("composer-asks").getByTestId("question");
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  // Enter with nothing chosen says why it does nothing.
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("question-nudge")).toHaveText("Choose an answer for each question first");
  // Down puts the keyboard on the first part: two numbers there are two of its checks.
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("checkbox", { name: "Lint" })).toBeFocused();
  await page.keyboard.press("1");
  await page.keyboard.press("2");
  await expect(card.getByRole("checkbox", { name: "Lint" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("checkbox", { name: "Types" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("radio", { name: "release" })).toHaveAttribute("aria-checked", "false");
  // Down walks on through the options and the own-answer field into the next part.
  for (const stop of ["Types", "Tests"]) { await page.keyboard.press("ArrowDown"); await expect(card.getByRole("checkbox", { name: stop })).toBeFocused(); }
  await page.keyboard.press("ArrowDown");
  await expect(card.getByTestId("question-other").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(card.getByRole("radio", { name: "main" })).toBeFocused();
  // The keyboard is on "main", the number picks "release": Enter sends what the card shows chosen.
  await page.keyboard.press("2");
  await expect(card.getByRole("radio", { name: "release" })).toHaveAttribute("aria-checked", "true");
  await shoot(page, "answer-keys-04-question-parts");
  await page.keyboard.press("Enter");
  await expect.poll(async () => await answersOf(request, id)).toEqual({ "0": { picked: ["Lint", "Types"] }, "1": { picked: ["release"] } });

  // The next question takes the keyboard by itself: words typed now are a message, not its answer.
  await expect.poll(() => pending(request, id)).toHaveLength(1);
  await expect(card).toBeFocused();
  await page.keyboard.type("a dark teal");
  await expect(page.getByTestId("composer")).toHaveValue("a dark teal");
  await page.getByTestId("composer").fill("");
  // The owner's own answer goes into the card's field, and Enter there sends it.
  await card.getByTestId("question-other").click();
  await page.keyboard.type("a dark teal");
  await page.keyboard.press("Enter");
  await expect.poll(() => pending(request, id)).toHaveLength(0);
  expect(await answersOf(request, id)).toEqual({ "0": { picked: [], other: "a dark teal" } });
  await expect(page.getByTestId("composer")).toBeFocused();
  await drop(request, id);
});

test("a number answers only with an option that is in view, and a long question keeps its Answer in reach", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const long = { name: "AskUserQuestion", input: { questions: [{ header: "Order", question: "Which order should the steps run in?", options: Array.from({ length: 11 }, (_, i) => ({ label: `Order ${i + 1}`, description: "One of many ways to order the steps of this long migration" })), multiSelect: false }] } };
  const id = await create(request, "A long question", folder("question-long"));
  await request.post(`/api/sessions/${id}/messages`, { data: { text: calls([long]) } });
  await expect.poll(() => pending(request, id)).toHaveLength(1);
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto(`/s/${id}`);
  const card = page.getByTestId("composer-asks").getByTestId("question");
  await expect(card).toBeFocused();
  // The card is taller than the room above the message box: its Answer row stays at the lower edge, in view.
  const tray = page.getByTestId("composer-tray");
  expect(await card.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(await tray.evaluate((el) => el.clientHeight));
  const seen = (testid: string, nth = 0) => card.getByTestId(testid).nth(nth).evaluate((el) => {
    const r = el.getBoundingClientRect(), t = el.closest('[data-testid="composer-tray"]')!.getBoundingClientRect();
    return r.top >= t.top - 0.5 && r.bottom <= Math.min(innerHeight, t.bottom) + 0.5;
  });
  expect(await seen("question-submit")).toBe(true);
  expect(await seen("question-option", 8)).toBe(false);
  await shoot(page, "answer-keys-11-long-question");
  // The owner's own press on the card makes the numbers its own. 9 is out of view: chosen and shown, not sent.
  await card.getByText("Which order should the steps run in?").click();
  await expect(card).toHaveAttribute("data-own", "true");
  await page.keyboard.press("9");
  await expect(card.getByRole("radio", { name: /^Order 9/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => seen("question-option", 8)).toBe(true);
  await page.waitForTimeout(400);
  expect(await pending(request, id)).toHaveLength(1);
  // Now that it can be read, the number answers with it.
  await page.keyboard.press("9");
  await expect.poll(() => pending(request, id)).toHaveLength(0);
  expect(await answersOf(request, id)).toEqual({ "0": { picked: ["Order 9"] } });
  await drop(request, id);
});

test("a plan is approved by a key on Approve, once it was read to its end", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("plan");
  const open1 = async (id: string) => (await (await request.get(`/api/sessions/${id}/plan`)).json()).open.length as number;
  // A plan that fits its box: the keyboard comes to its text, Tab goes to Approve, Enter approves.
  const short = await create(request, "Plan the retry policy", ws);
  await ask(request, short, "plan");
  await page.goto(`/s/${short}`);
  const card = page.getByTestId("plan-card");
  await expect(card.getByTestId("plan-text")).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await expect(card.getByTestId("plan-hint")).toHaveText("Tab goes to Approve");
  await shoot(page, "answer-keys-05-plan-keys");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(await open1(short)).toBe(1);
  await page.keyboard.press("Tab");
  await expect(card.getByTestId("plan-approve")).toBeFocused();
  await expect(card.getByTestId("plan-hint")).toHaveText("Enter approves the plan");
  await page.keyboard.press("Enter");
  await expect.poll(() => open1(short)).toBe(0);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${short}/permissions`)).json()).perm.mode).toBe("auto-edits");
  await expect(page.getByTestId("composer")).toBeFocused();

  // A plan longer than its box: a key on Approve does nothing until the text was scrolled to its end.
  const long = await create(request, "Plan the migration", ws);
  await request.put(`/api/sessions/${long}/permissions`, { data: { mode: "plan" } });
  const steps = Array.from({ length: 60 }, (_, i) => `${i + 1}. Step ${i + 1} of the migration, in its own line.`).join("\n");
  await request.post(`/api/sessions/${long}/messages`, { data: { text: calls([{ name: "present_plan", input: { plan: `## Migration\n\n${steps}` } }]) } });
  await expect.poll(() => open1(long), { timeout: 30_000 }).toBe(1);
  await page.goto(`/s/${long}`);
  await expect(card.getByTestId("plan-text")).toBeFocused();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await expect(card).not.toHaveAttribute("data-read", "true");
  await expect(card.getByTestId("plan-hint")).toHaveText("Read to the end, then Tab goes to Approve");
  await page.keyboard.press("Tab");
  await expect(card.getByTestId("plan-approve")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("plan-hint")).toHaveText("Read the plan to its end first");
  await shoot(page, "answer-keys-12-plan-unread");
  await page.waitForTimeout(300);
  expect(await open1(long)).toBe(1);
  // Up is back on the text; End reads it to its end (the plan's own scroll, not the conversation's).
  await page.keyboard.press("ArrowUp");
  await expect(card.getByTestId("plan-text")).toBeFocused();
  await page.keyboard.press("End");
  await expect(card).toHaveAttribute("data-read", "true");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect.poll(() => open1(long)).toBe(0);
  await drop(request, short, long);
});

test("a secret request takes no typed word as its value", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  await watchKeys(page);
  const ws = folder("secret");
  const requests = async (id: string) => (await (await request.get(`/api/sessions/${id}/secrets`)).json()).requests.length as number;
  const wants = (id: string) => request.post(`/api/sessions/${id}/messages`, { data: { text: calls([{ name: "request_secret", input: { name: "DEPLOY_KEY", purpose: "deploy check" } }]) } });
  // The box holds half a message as the card appears: the card takes nothing, and the rest of the message is the box's.
  const draft = await create(request, "Secret while typing", ws);
  await open(page, [draft]);
  await page.keyboard.type("half a ");
  await wants(draft);
  await expect.poll(() => requests(draft)).toBe(1);
  const card = page.getByTestId("secret-request");
  await expect(card).toBeVisible();
  await page.waitForTimeout(300);
  await page.keyboard.type("message 2");
  await expect(pane(page, draft).getByTestId("composer")).toHaveValue("half a message 2");
  await expect(card.getByTestId("secret-value")).toHaveValue("");
  // The box is empty as the card appears: the card takes the keyboard on itself, not in its field, and words go to the box.
  const empty = await create(request, "Secret from an empty box", ws);
  await open(page, [empty]);
  await reset(page);
  await wants(empty);
  await expect.poll(() => requests(empty)).toBe(1);
  await expect(card).toBeFocused();
  await page.keyboard.type("message 2");
  await expect(pane(page, empty).getByTestId("composer")).toHaveValue("message 2");
  await page.keyboard.press("Enter");
  // (The message waits its turn: the request holds the turn.)
  await expect(pane(page, empty).getByTestId("queue-item")).toContainText("message 2");
  await expect(card.getByTestId("secret-value")).toHaveValue("");
  expect(await requests(empty)).toBe(1);
  expect(await answersSent(page)).toEqual([]);
  // The field is one Tab from the card; the value typed there is given with Enter.
  await card.focus();
  await expect(card).toHaveAttribute("data-keys", "ready");
  await page.keyboard.press("Tab");
  await expect(card.getByTestId("secret-value")).toBeFocused();
  await page.keyboard.type("s3cret-value");
  await page.keyboard.press("Enter");
  await expect.poll(() => requests(empty)).toBe(0);
  await drop(request, draft, empty);
});

test("what waits across sessions is answered in sequence, one key each", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence");
  const quiet = await create(request, "Nothing waits here", ws);
  // Three approvals and a question, each in a session of its own, in the order they began to wait.
  const a = await asksToRun(request, "Build the docs", ws, "docs");
  const b = await asksToRun(request, "Clean the cache", ws, "cache");
  const c = await asksToRun(request, "Tag the release", ws, "tag");
  const q = await create(request, "Pick a color", ws);
  await ask(request, q, "question");

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  const row = (id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  for (const id of [a, b, c, q]) await expect(row(id)).toHaveAttribute("data-watch", "need");
  // Only the keyboard is used from here: every press is counted, and the pointer never moves.
  let presses = 0;
  const press = async (key: string) => { presses++; await page.keyboard.press(key); };
  const at = (id: string) => expect(page).toHaveURL(new RegExp(`/s/${id}$`));
  // The keyboard comes to the card; once it has been there for the settle time, its Allow has it and acts.
  const ready = async (id: string) => {
    await at(id);
    const card = cardIn(page, id, "approval");
    await expect(card.getByTestId("allow-once")).toBeFocused();
    await expect(card.getByTestId("approval")).toHaveAttribute("data-live", "true");
  };

  // One key starts the sequence on the one that has waited longest.
  await press("Alt+a");
  await ready(a);
  // Each Enter answers, and the next one opens by itself with the keyboard on it.
  await press("Enter");
  await ready(b);
  // The card says that it is a sequence and how many more wait.
  await expect(page.getByTestId("waiting-elsewhere")).toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("waiting-elsewhere")).toContainText("2 more sessions wait for you");
  await shoot(page, "answer-keys-06-sequence");
  await press("Enter");
  await ready(c);
  await expect(page.getByTestId("waiting-elsewhere")).toContainText("1 more session waits for you");
  await press("Enter");
  await at(q);
  const question = cardIn(page, q, "question");
  await expect(question).toBeFocused();
  await expect(question).toHaveAttribute("data-keys", "ready");
  await expect(question.getByTestId("question-hint")).toHaveText("Press 1 to 3 to answer, or Up and Down then Enter");
  await expect(page.getByTestId("waiting-elsewhere")).toHaveCount(0);
  await shoot(page, "answer-keys-07-sequence-question");
  await press("2");

  // Everything is answered, in five presses, and the page says that nothing else waits.
  await expect(page.locator(".k-tip")).toHaveText("Nothing else waits for you.");
  expect(presses).toBe(5);
  for (const id of [a, b, c]) await expect.poll(async () => (await approvals(request, id))[0]).toMatchObject({ state: "allowed", choice: "once" });
  expect(await answersOf(request, q)).toEqual({ "0": { picked: ["Amber"] } });
  for (const id of [a, b, c, q]) await expect(row(id)).not.toHaveAttribute("data-watch", "need");
  await at(q);
  await expect(page.getByTestId("composer")).toBeFocused();
  await shoot(page, "answer-keys-08-sequence-done");
  await drop(request, quiet, a, b, c, q);
});

test("the sequence stays with the owner: several requests in one session, and it ends when they do something else", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("sequence-ends");
  const quiet = await create(request, "Nothing waits here", ws);
  // One session with two requests of different tools (each is answered on its own), and one more session.
  const two = await create(request, "Two requests", ws);
  await request.put(`/api/sessions/${two}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await request.post(`/api/sessions/${two}/messages`, { data: { text: `script:batch ${JSON.stringify([{ name: "Bash", input: { command: "echo one > one.txt" } }, { name: "Write", input: { file_path: `${ws}/two.txt`, content: "two" } }])}` } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${two}/approvals`)).json()).approvals.length).toBe(2);
  const other = await asksToRun(request, "One more", ws, "more");

  await page.goto(`/s/${quiet}`);
  await expect(page.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  const cards = page.getByTestId("approval");
  await expect(cards).toHaveCount(2);
  await expect(cards.first().getByTestId("allow-once")).toBeFocused();
  await expect(cards.first()).toHaveAttribute("data-live", "true");
  // The first is answered: the keyboard goes to the one left in this session, not to another session.
  await page.keyboard.press("Enter");
  await expect(cards).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  await expect(cards.getByTestId("allow-once")).toBeFocused();
  // The owner types into the message box instead: the sequence is over, and an answer moves nothing.
  await page.getByTestId("composer").focus();
  await page.keyboard.type("x");
  await expect(page.getByTestId("waiting-elsewhere")).not.toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("waiting-elsewhere")).toHaveText("1 more session waits for you.AltAgoes to the next.");
  await shoot(page, "answer-keys-09-waits-elsewhere");
  await page.getByTestId("composer").fill("");
  await expect(cards).toHaveAttribute("data-live", "true");
  await cards.getByTestId("allow-once").click();
  await expect(cards).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(new RegExp(`/s/${two}$`));
  // The key again takes up what is left.
  await page.keyboard.press("Alt+a");
  await expect(page).toHaveURL(new RegExp(`/s/${other}$`));
  await drop(request, quiet, two, other);
});
