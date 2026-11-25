import { expect, test, type APIRequestContext, type Locator, type Page } from "./isolate.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { exited, ownDaemon } from "./peer.ts";
import { openPanel, shoot, inHead, leaveHead } from "./shots.ts";

// Feature: one word per state on every surface. A coordinator with eight
// agents, one in each state, reads the same on the agents' rows under it, on
// their cards, in the list of background work and in each agent's own pane;
// its summary counts every agent, so the numbers add up; a notice names an
// agent by its title; Stop asks first and is not inside the row's open
// target; an agent that ends is marked until seen. The Inbox lists what needs
// the owner before anything that ended; each counter says what it counts;
// unread means not seen. The scripted stand-in sends the exact calls.
const STAND_IN = "scripted:stand-in";
const WS = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/state-words`;
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const row = (page: Page, id: string) => page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
const station = (page: Page, id: string) => page.locator(`section.k-station[data-station="${id}"]`);
const flat = (t: string) => t.replace(/\s+/g, " ").trim();

async function scripted(request: APIRequestContext) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  return models.some((m) => m.id === STAND_IN);
}
async function start(request: APIRequestContext, title: string, mode = "full-auto") {
  mkdirSync(WS, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: WS } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, sandbox: "off" } });
  return session.id as string;
}
const send = (request: APIRequestContext, id: string, text: string) => request.post(`/api/sessions/${id}/messages`, { data: { text } });
const idle = async (request: APIRequestContext, id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
const settle = (request: APIRequestContext, id: string) => expect.poll(() => idle(request, id), { timeout: 60_000 }).toBe(true);
const states = async (request: APIRequestContext) => ((await (await request.get("/api/state")).json()).states ?? {}) as Record<string, { watch: string; why?: string; asks?: number; agents?: number; parked?: number; text?: string }>;

// A command that goes on until its gate file is there, 99 s at most (one still running at 120 s
// is moved to the background). `work` is three of them, each its own call.
const gates = join(WS, `gates-${Date.now().toString(36)}`);
const gate = (name: string) => join(gates, name);
const release = (name: string) => writeFileSync(gate(name), "go\n");
const gateLoop = (name: string, n = 0) => ({ name: "Bash", input: { command: `i=0; until [ -f ${gate(name)} ] || [ $i -ge 330 ]; do i=$((i+1)); sleep 0.3; done; echo released ${n}` } });
const work = (name: string) => [0, 1, 2].map((n) => gateLoop(name, n));
const child = (title: string, body: string) => ({ name: "spawn_agent", input: { message: `${title}\n${body}`, isolation: "none" } });

// The eight agents of the coordinator, and the word each one's state has.
const LANES: { title: string; body: string; word: string }[] = [
  { title: "Port the parser to the new tokenizer", body: script(work("parser")), word: "Working" },
  { title: "Bench the cache under load", body: script(work("bench")), word: "Working" },
  { title: "Review pull request 212", body: script(work("review")), word: "Working" },
  { title: "Watch CI on main", body: script([{ name: "wait_for", input: { kind: "timer", seconds: 3600, note: "CI on main turns green" } }]), word: "Waiting" },
  { title: "Wait for the staging deploy", body: script([{ name: "wait_for", input: { kind: "file", path: gate("staging-marker"), note: "staging deploy marker" } }]), word: "Waiting" },
  { title: "Fetch the release notes from the tracker", body: "script:billing", word: "Failed" },
  { title: "Push the release branch", body: script([gateLoop("push-hold"), { name: "Bash", input: { command: "touch pushed-release.txt" } }]), word: "Needs you" },
  { title: "Summarize the open issues", body: "script:say Report: 14 open issues, 3 block the release.", word: "Done" },
];

test("eight agents read the same on every surface, and the summary adds up", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(420_000);
  mkdirSync(gates, { recursive: true });
  const coord = await start(request, "Coordinator: release train 2.4");
  const elsewhere = await start(request, "Standup notes for Thursday");
  await send(request, elsewhere, "script:say Three items for Thursday."); await settle(request, elsewhere);
  await send(request, coord, `Start the lanes. ${script(LANES.map((l) => child(l.title, l.body)))}`);
  type Agent = { id: string; session_id: string; title: string; status: string; created: number };
  const agents = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as Agent[];
  const by = async (title: string) => (await agents()).find((a) => a.title.startsWith(title))!;
  try {
    await expect.poll(async () => (await agents()).length, { timeout: 60_000 }).toBe(8);
    // The push agent asks for its next command.
    const push = await by("Push the release branch");
    await request.put(`/api/sessions/${push.session_id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
    release("push-hold");
    // Each agent is where the day needs it: three at work, two waiting, one failed, one that asks, one done.
    await expect.poll(async () => { const st = await states(request); return (await agents()).map((a) => `${a.status}${st[a.session_id]?.watch === "need" ? "+need" : ""}`).sort().join(" "); }, { timeout: 90_000 })
      .toBe("completed failed running running running running+need waiting waiting");
    await expect.poll(async () => !(await (await request.get(`/api/sessions/${coord}`)).json()).running && (await states(request))[coord]?.watch, { timeout: 60_000 }).toBe("need");

    await page.goto(`/s/${coord}`);
    const kids = row(page, coord).locator("xpath=..").getByTestId("session-children");
    const tree = (title: string) => kids.getByTestId("child-session").filter({ hasText: title });
    const card = (title: string) => station(page, coord).getByTestId("agent-call").filter({ hasText: title });
    // Eight agents started together are one line in the conversation, which opens to each agent's own line.
    const started = station(page, coord).locator('[data-testid="work-step"][data-family="agents"]').locator("button.k-line").first();
    const open = async () => { await expect(started).toContainText("Started 8 agents"); if ((await started.getAttribute("aria-expanded")) !== "true") await started.click(); };
    await open();

    // The session itself counts every agent by state (its dock's word Agents says them all), and names each live one over
    // the box by its dot and title: what works, waits, needs the owner or failed unseen; the done one is in the list it opens.
    // The sidebar says no number: its row has a chevron that opens the tree.
    const toggle = row(page, coord).getByTestId("children-toggle");
    const dock = page.getByTestId("dock-agents");
    const summary = { toHaveText: (text: string, o?: { timeout?: number }) => expect(dock).toHaveAttribute("aria-label", `Agents: ${text}`, o) };
    await summary.toHaveText("8 agents: 1 needs you, 1 failed, 3 working, 2 waiting, 1 done");
    await expect(dock).toHaveAttribute("title", "8 agents: 1 needs you, 1 failed, 3 working, 2 waiting, 1 done");
    const named = page.getByTestId("dock-agents-summary").getByTestId("dock-agent");
    // The live ones named over the box, by state (a failure stays named until the owner looked at it).
    const live = async () => (await named.evaluateAll((els) => els.map((e) => e.getAttribute("data-watch") ?? ""))).filter((w) => w !== "fail").sort();
    expect((await named.evaluateAll((els) => els.map((e) => e.getAttribute("data-watch")))).sort()).toEqual(["fail", "need", "wait", "wait", "work", "work", "work"]);
    for (const l of LANES.filter((x) => x.word !== "Done")) await expect(named.filter({ hasText: l.title }).locator(".k-mark"), `named: ${l.title}`).toBeVisible();
    await expect(named.filter({ hasText: "Summarize the open issues" })).toHaveCount(0);
    await expect(kids.getByTestId("children-total")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(kids.getByTestId("child-session")).toHaveCount(8);

    // One word for one agent: its row in the tree, its card, the list of background work.
    await (await inHead(page, "background-button")).click();
    for (const l of LANES) {
      await expect(tree(l.title).getByTestId("child-state"), `tree: ${l.title}`).toHaveText(l.word);
      await expect(tree(l.title).getByTestId("child-title")).toHaveText(l.title);
      // The row says its state to a hover and to a screen reader too, with its title.
      await expect(tree(l.title)).toHaveAccessibleName(new RegExp(`^${l.title}, ${l.word}`));
      await expect(tree(l.title)).toHaveAttribute("title", new RegExp(`^${l.title}: ${l.word}`));
      await expect(card(l.title).getByTestId("agent-call-state"), `card: ${l.title}`).toHaveText(new RegExp(`^${l.word}`));
      const bg = page.getByTestId("bg-agent").filter({ hasText: l.title });
      await expect(bg.getByTestId("bg-agent-state"), `background: ${l.title}`).toHaveText(new RegExp(`^${l.word}`));
    }
    // With what: the approval, the timer and the file, the failure's class in its one word.
    await expect(page.getByTestId("bg-agent").filter({ hasText: "Push the release branch" }).getByTestId("bg-agent-state")).toHaveText("Needs you: an approval");
    await expect(page.getByTestId("bg-agent").filter({ hasText: "Watch CI on main" }).getByTestId("bg-agent-state")).toHaveText("Waiting for a timer");
    await expect(page.getByTestId("bg-agent").filter({ hasText: "Wait for the staging deploy" }).getByTestId("bg-agent-state")).toHaveText("Waiting for a file");
    await expect(page.getByTestId("bg-agent").filter({ hasText: "Fetch the release notes" }).getByTestId("bg-agent-state")).toHaveText("Failed: billing");
    await expect(card("Fetch the release notes").getByTestId("agent-call-state")).toHaveText("Failed: billing");
    // No surface says the words the vocabulary retired.
    // (What an agent is doing now, "Running <command>", is its tool's own line, not a state word.)
    const worded = (l: Locator) => l.evaluateAll((els) => els.map((el) => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll('[data-testid="agent-now-text"]').forEach((n) => n.remove()); return c.textContent ?? ""; }));
    const said = [...(await worded(kids)), ...(await worded(page.getByTestId("background-popup"))), ...(await worded(station(page, coord).getByTestId("agent-call")))];
    for (const text of said) expect(flat(text)).not.toMatch(/\b(Running|running|Asks you|asks you|Finished)\b/);
    await shoot(page, "state-words-01-coordinator");
    await page.keyboard.press("Escape");
    await leaveHead(page);

    // And in each agent's own pane: the head says the same word.
    for (const l of LANES) {
      const a = await by(l.title);
      await tree(l.title).click();
      await expect(station(page, a.session_id).getByTestId("station-word"), `pane: ${l.title}`).toHaveText(new RegExp(`^${l.word}`));
    }
    await row(page, coord).click();

    // The owner allows the push: the agent goes on and ends. The parent then works, and the count
    // after its word is the agents that work: the summary's "working".
    const waiting = (await (await request.get(`/api/sessions/${push.session_id}/approvals`)).json()).approvals as { id: string; state?: string }[];
    expect((await request.post(`/api/sessions/${push.session_id}/approvals/${waiting[0]!.id}`, { data: { choice: "once" } })).ok()).toBe(true);
    await summary.toHaveText("8 agents: 1 failed, 3 working, 2 waiting, 2 done", { timeout: 60_000 });
    await expect.poll(live).toEqual(["wait", "wait", "work", "work", "work"]);
    await expect.poll(async () => !(await (await request.get(`/api/sessions/${coord}`)).json()).running && (await states(request))[coord]?.watch, { timeout: 60_000 }).toBe("work");
    // A notice about an agent names it by its title; its id stands at the end. A park starts no turn of the
    // parent (0b3664139): it rides the parent's next input, here the report of the agent that was allowed.
    const ci = await by("Watch CI on main");
    const park = station(page, coord).getByTestId("agent-park-notice").filter({ hasText: "Watch CI on main" }).first();
    await expect(park).toContainText("Waiting");
    // An agent's line in the conversation has one shape and two weights: its name, heavier, then its state word and
    // what follows, all of one lighter weight (a report and a park; an agent that asks has the same line in tree-approvals.spec.ts).
    const weights = (loc: import("@playwright/test").Locator) => loc.first().evaluate((el) => [...el.querySelectorAll<HTMLElement>("span")].filter((n) => n.children.length === 0 && n.textContent?.trim()).map((n) => [n.textContent!.trim(), getComputedStyle(n).fontWeight] as const));
    for (const [what, loc, name] of [["report", station(page, coord).getByTestId("agent-report"), /./], ["park", park, /Watch CI on main/]] as const) {
      const w = await weights(loc);
      expect(w[0]![0], `${what}: it starts with the name`).toMatch(name);
      expect(new Set(w.map(([, weight]) => weight)).size, `${what}: ${JSON.stringify(w)}`).toBeLessThanOrEqual(2);
      expect(w.filter(([, weight]) => weight !== "400").map(([t]) => t).join(" "), `${what}: only the name is heavier`).toMatch(name);
    }
    // At work is the normal case: its word is lighter than a failed agent's and not in its colour (nor in Needs you's).
    const word = (title: string) => tree(title).getByTestId("child-state").evaluate((el) => ({ weight: Number(getComputedStyle(el).fontWeight), color: getComputedStyle(el).color }));
    const working = await word("Port the parser"), asking = await word("Fetch the release notes");
    expect(working.weight, "Working is not bold").toBeLessThan(asking.weight);
    expect(working.color, "Working is not in the ink of what failed").not.toBe(asking.color);
    await park.click();
    await expect(park).toContainText("Watch CI on main waits for");
    await expect(park.getByTestId("agent-park-id")).toHaveText(`Agent ${ci.id}`);
    // The failure notice says the class in the word the rows use for it.
    await expect(station(page, coord).getByTestId("failure-entries").first()).toContainText("1 agent failed (billing)");

    // Three of its eight agents work: the head says its word alone, the line over the box names the three by their dots
    // and the total is the word Agents', and the pill says the five still out in the agents' line's words (three work, two wait).
    await expect(row(page, coord).getByTestId("row-state")).toHaveText("Working");
    await expect(station(page, coord).getByTestId("station-word")).toHaveText("Working");
    await expect(page.getByTestId("dock-agents")).toHaveAttribute("aria-label", /^Agents: 8 agents: .*3 working, 2 waiting/);
    await expect(page.getByTestId("dock-agent").and(page.locator('[data-watch="work"]'))).toHaveCount(3);
    // (The background list rests in the session menu since the bar holds one menu.)
    await expect(await inHead(page, "background-button")).toHaveText("3 working, 2 waiting");
    await leaveHead(page);

    // An agent that ends while neither it nor its parent is on screen is marked on its row until one of them is.
    await row(page, elsewhere).click();
    await expect(station(page, elsewhere)).toBeVisible();
    release("bench");
    await expect.poll(async () => (await by("Bench the cache")).status, { timeout: 60_000 }).toBe("completed");
    await expect(tree("Bench the cache").getByTestId("child-state")).toHaveText("Done");
    await expect(tree("Bench the cache")).toHaveAttribute("data-fresh", "true");
    await expect(tree("Bench the cache").getByTestId("child-fresh")).toBeVisible();
    await expect(tree("Summarize the open issues")).not.toHaveAttribute("data-fresh", "true");
    await shoot(page, "state-words-02-agent-ended");
    await row(page, coord).click();
    await expect(tree("Bench the cache")).not.toHaveAttribute("data-fresh", "true", { timeout: 15_000 });
    await summary.toHaveText("8 agents: 1 failed, 2 working, 2 waiting, 3 done", { timeout: 60_000 });

    // Stop is a control of its own over the row's end, not inside what opens it, named with its agent, and always asks first.
    const reviewRow = kids.getByTestId("child-row").filter({ hasText: "Review pull request 212" });
    expect(await reviewRow.getByTestId("child-session").getByTestId("child-stop").count()).toBe(0);
    // No row keeps room for it: the words of a live agent and of an ended one end at the same place.
    const right = async (title: string) => { const b = (await tree(title).getByTestId("child-state").boundingBox())!; return Math.round(b.x + b.width); };
    expect(await right("Review pull request 212")).toBe(await right("Summarize the open issues"));
    await reviewRow.hover();
    const url = page.url();
    await expect(reviewRow.getByTestId("child-stop")).toHaveAccessibleName("Stop agent: Review pull request 212");
    await reviewRow.getByTestId("child-stop").click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText('Stop "Review pull request 212"?');
    await expect(confirm).toContainText("It has worked for");
    // The keyboard is on Cancel: an Enter on its way stops nothing.
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await shoot(page, "state-words-03-stop-asks");
    await page.keyboard.press("Enter");
    await expect(confirm).toBeHidden();
    expect((await by("Review pull request 212")).status).toBe("running");
    expect(page.url()).toBe(url);
    await reviewRow.hover();
    await reviewRow.getByTestId("child-stop").click();
    await confirm.getByTestId("confirm-action").click();
    await expect.poll(async () => (await by("Review pull request 212")).status, { timeout: 30_000 }).toBe("stopped");
    await expect(tree("Review pull request 212").getByTestId("child-state")).toHaveText("Stopped");
    await open();
    await expect(card("Review pull request 212").getByTestId("agent-call-status")).toHaveText("Stopped · You stopped this agent");
    await summary.toHaveText("8 agents: 1 failed, 1 working, 2 waiting, 1 stopped, 3 done", { timeout: 60_000 });
    await expect.poll(live, "a stopped agent is not named over the box").toEqual(["wait", "wait", "work"]);
    // Its report says how it ended first, whole, in a pane of any width.
    await expect(station(page, coord).getByTestId("agent-report").filter({ hasText: "Review pull request 212" }).getByTestId("agent-report-state")).toHaveText("Stopped");
    // Whole means clear of the row's chevron and not narrower than its text, whatever the title's length.
    const reportsWhole = async (where: string) => {
      const rows = await station(page, coord).getByTestId("agent-report").evaluateAll((els) => els.map((el) => {
        const word = el.querySelector<HTMLElement>('[data-testid="agent-report-state"]')!, chevron = el.querySelector("svg.lucide-chevron-right")!, title = el.querySelector<HTMLElement>("span[title]")!;
        const w = word.getBoundingClientRect(), c = chevron.getBoundingClientRect(), t = title.getBoundingClientRect();
        return { word: word.textContent, clear: w.right <= c.left + 0.5 && w.left >= t.right - 0.5, whole: word.scrollWidth <= word.clientWidth + 1 && w.width > 20 };
      }));
      expect(rows.length, where).toBeGreaterThan(0);
      for (const r of rows) expect(r, where).toMatchObject({ clear: true, whole: true });
    };
    await reportsWhole("one pane");

    // Four panes: an agent's row may be too narrow for its title and its word. The title stays, the mark says the state, and the tooltip has both.
    const four = [coord, elsewhere, (await by("Port the parser")).session_id, (await by("Watch CI on main")).session_id];
    await page.evaluate((slots) => {
      localStorage.setItem("keel.focus", "false");
      localStorage.setItem("keel.panes", JSON.stringify({ count: 4, slots, sizes: {}, active: 0 }));
    }, four);
    await page.goto(`/s/${coord}`);
    await expect(page.locator("section.k-station[data-station]")).toHaveCount(4);
    await expect(kids.getByTestId("child-session").first()).toBeVisible();
    // The narrow list keeps the chevron; the session's own dock says every count.
    await expect(row(page, coord).getByTestId("children-toggle")).toBeVisible();
    await expect(dock).toHaveAttribute("aria-label", "Agents: 8 agents: 1 failed, 1 working, 2 waiting, 1 stopped, 3 done");
    for (const title of ["Fetch the release notes from the tracker", "Watch CI on main"]) {
      const box = (await tree(title).getByTestId("child-title").boundingBox())!;
      expect(box.width, `${title}: its title has room`).toBeGreaterThan(40);
      await expect(tree(title)).toHaveAttribute("title", new RegExp(`^${title}: `));
    }
    await reportsWhole("four panes");
    await shoot(page, "state-words-10-four-panes");
    await page.evaluate(() => { localStorage.setItem("keel.focus", "true"); localStorage.removeItem("keel.panes"); });
    // A smaller desk, and the largest text size: the session's line of counts keeps its counts whole.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/s/${coord}`);
    await expect(kids.getByTestId("child-session").first()).toBeVisible();
    await shoot(page, "state-words-12-1440");
    await page.evaluate(() => localStorage.setItem("keel.textScale", "1.5"));
    await page.reload();
    await expect(kids.getByTestId("child-session").first()).toBeVisible();
    // (The session's own line holds every name it shows, whole, at the largest text.)
    const box = (await page.getByTestId("dock-agents-line").boundingBox())!;
    for (const part of await named.all()) { const b = (await part.boundingBox())!; if (b.y < box.y + box.height) expect(b.x + b.width, "a name is whole at the largest text").toBeLessThanOrEqual(box.x + box.width); }
    await shoot(page, "state-words-13-text-size-1-5");
    await page.evaluate(() => localStorage.removeItem("keel.textScale"));

    // A phone: the same words in the list of background work.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${coord}`);
    // (The page opens at the newest: the agents' reports, which is what is read here; the spawn cards far above
    // are drawn only when scrolled to, since the transcript draws what is near the view.)
    await expect(station(page, coord).getByTestId("agent-report").last()).toBeVisible();
    await reportsWhole("a phone");
    await shoot(page, "state-words-04-phone");
    {
      await (await inHead(page, "background-button")).click();
      await expect(page.getByTestId("bg-agent").filter({ hasText: "Fetch the release notes" }).getByTestId("bg-agent-state")).toHaveText("Failed: billing");
      await shoot(page, "state-words-04-phone-background");
    }
  } finally {
    for (const g of ["parser", "bench", "review", "push-hold"]) if (!existsSync(gate(g))) release(g);
    await request.post(`/api/sessions/${coord}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});

test("the inbox lists what needs you first, each counter says what it counts, and unread means not seen", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(240_000);
  await request.post("/api/alerts/read", { data: {} });
  const approval = async (title: string, file: string) => {
    const id = await start(request, title, "ask");
    await send(request, id, script([{ name: "Bash", input: { command: `touch ${file}` } }]));
    await expect.poll(async () => (await states(request))[id]?.watch, { timeout: 30_000 }).toBe("need");
    return id;
  };
  const finish = async (title: string, said: string) => { const id = await start(request, title); await send(request, id, `script:say ${said}`); await settle(request, id); return id; };
  const waits = async (title: string, mode: string, call: { name: string; input: unknown }) => {
    const id = await start(request, title, mode);
    await send(request, id, script([call]));
    await expect.poll(async () => (await states(request))[id]?.watch, { timeout: 30_000 }).toBe("need");
    return id;
  };
  // In the order they happened: an approval, two finishes, an approval, a finish.
  const certs = await approval("Rotate the staging certificates", "renewed.txt");
  const notes = await finish("Standup notes for Thursday", "Three items: the importer landed.");
  const changelog = await finish("Draft the 2.4 changelog", "Draft done: 31 entries in four groups.");
  const canary = await approval("Watch the canary deploy", "promoted.txt");
  const webhooks = await finish("Refactor the billing webhooks", "The handlers share one verifier now.");

  await page.goto("/");
  const unread = async () => (await (await request.get("/api/alerts?with_unread")).json()).unread as { total: number; sessions: Record<string, number> };
  expect((await unread()).total).toBe(5);

  // The bell counts what waits on the owner (the two approvals), shows the finishes as a dot, and says what is unread.
  const bell = page.getByTestId("inbox-button");
  await expect(page.getByTestId("inbox-count")).toHaveText("2");
  await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-news", "true");
  await expect(bell).toHaveAccessibleName(/5 unread: new since you last looked/);
  await expect(bell).toHaveAttribute("title", /5 unread: new since you last looked/);
  // The tab's title and the home headline count what waits on the owner: the same number.
  const asks = Object.entries(await states(request)).filter(([id]) => [certs, canary].includes(id)).reduce((n, [, st]) => n + (st.asks ?? 1), 0);
  expect(asks).toBe(2);
  const need = page.getByTestId("home-count-need");
  const n = Number((await need.innerText()).match(/\d+/)![0]);
  expect(n).toBeGreaterThanOrEqual(2);
  await expect(page).toHaveTitle(new RegExp(`^\\(${n}\\) `));
  await expect(need).toHaveAttribute("title", new RegExp(`^${n} needs? you\\. ${n} things wait on you: approvals, questions, plans and secrets`));
  // The bug counts Keel's own errors.
  await expect(page.getByTestId("errors-button")).toHaveAccessibleName(/errors? in Keel/);

  // The Inbox: what needs the owner first, then what else is new. Nothing that waits is below a finish.
  await bell.click();
  await page.getByTestId("inbox-unread-filter").check();
  const items = page.getByTestId("inbox-item");
  await expect(items).toHaveCount(5);
  await expect(page.getByTestId("inbox-part")).toHaveText([/^Needs you, 2$/, /^New since you looked, 3$/]);
  expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-part")))).toEqual(["need", "need", "new", "new", "new"]);
  expect(await items.evaluateAll((els) => els.map((e) => e.querySelector('[data-testid="inbox-word"]')?.textContent))).toEqual(["Approval", "Approval", "Done", "Done", "Done"]);
  // What waits is in the order it was asked: the oldest request first.
  expect(await items.evaluateAll((els) => els.slice(0, 2).map((e) => e.querySelector('[data-testid="inbox-place"]')?.textContent))).toEqual(["Rotate the staging certificates", "Watch the canary deploy"]);
  await shoot(page, "state-words-05-inbox");
  await page.keyboard.press("Escape");

  // An approval that was looked at and not answered still waits: it stays under Needs you, read.
  await row(page, certs).click();
  await expect(station(page, certs).getByTestId("approval").first()).toBeVisible();
  await expect.poll(async () => (await unread()).sessions[certs] ?? 0, { timeout: 15_000 }).toBe(0);
  // A plan and a secret to give wait on the owner too: each is in the Inbox under its own word.
  const plan = await waits("Plan the retry policy", "plan", { name: "present_plan", input: { title: "Retry policy", plan: "## Retry policy\n\n1. Read the importer.\n2. Change the policy." } });
  const secret = await waits("Call the staging API", "full-auto", { name: "request_secret", input: { name: "STATE_WORDS_TOKEN", purpose: "a spec" } });
  const windowAsk = await waits("Pick a deploy window", "full-auto", { name: "AskUserQuestion", input: { questions: [{ header: "Window", question: "Which window should the deploy take?", options: [{ label: "Tonight" }, { label: "Tomorrow" }], multiSelect: false }] } });
  await page.goto("/");
  await expect(page).toHaveTitle(/^\(\d+\) /);
  const things = Number((await page.title()).match(/^\((\d+)\)/)![1]);
  expect(things).toBeGreaterThanOrEqual(5);
  // One count of what waits: the tab's title, the home headline and the Inbox's count say the same number.
  await expect(page.getByTestId("home-count-need")).toHaveText(new RegExp(`^${things} need you$`));
  await expect(page.getByTestId("inbox-count")).toHaveText(String(things));
  await bell.click();
  await page.getByRole("radio", { name: "All" }).click();
  const needs = page.locator('[data-testid="inbox-item"][data-part="need"]');
  await expect(needs).toHaveCount(5);
  expect(await needs.evaluateAll((els) => els.map((e) => `${e.querySelector('[data-testid="inbox-word"]')?.textContent} ${e.querySelector('[data-testid="inbox-place"]')?.textContent} ${e.hasAttribute("data-unread") ? "unread" : "read"} ${e.querySelector('[data-testid="inbox-opens"]')?.textContent}`)))
    .toEqual(["Approval Rotate the staging certificates read Review", "Approval Watch the canary deploy unread Review", "Plan Plan the retry policy unread Review", "Secret Call the staging API unread Open", "Question Pick a deploy window unread Answer"]);
  // The word has a column of its own: every title after it starts at one place.
  const starts = await needs.evaluateAll((els) => els.map((e) => Math.round(e.querySelector('[data-testid="inbox-place"]')!.getBoundingClientRect().x)));
  expect(new Set(starts).size, `titles start at ${starts.join(", ")}`).toBe(1);
  // Nothing that waits is below anything that ended.
  const order = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-part")));
  expect(order.lastIndexOf("need")).toBeLessThan(order.findIndex((x) => x !== "need"));
  await shoot(page, "state-words-05b-inbox-needs");
  await page.keyboard.press("Escape");
  // Answered, it leaves the part: the plan is turned down, the secret request let go.
  const before = (await unread()).total;
  for (const id of [plan, secret, windowAsk]) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } });
  await bell.click();
  await expect(needs).toHaveCount(2, { timeout: 15_000 });
  // A question whose turn was stopped waits on nobody: it is read, the bell does not count it, and its row offers no answer.
  const asked = async () => ((await (await request.get("/api/alerts?with_unread")).json()).alerts as any[]).find((a) => a.kind === "question" && a.session_id === windowAsk);
  await expect.poll(async () => (await asked())?.read, { timeout: 15_000 }).toBe(true);
  expect((await unread()).total).toBeLessThan(before);
  const stoppedAsk = items.filter({ hasText: "Pick a deploy window" }).filter({ has: page.getByTestId("inbox-word").getByText("Question") });
  await expect(stoppedAsk).toHaveCount(1);
  await expect(stoppedAsk).not.toHaveAttribute("data-unread", "true");
  await expect(stoppedAsk.getByTestId("inbox-opens")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A session that ended and was never opened here: the card beside its row says what it ended with.
  await page.getByTestId("session-list").hover();
  await row(page, webhooks).hover();
  await expect(page.getByTestId("rail-card")).toContainText("The handlers share one verifier now.", { timeout: 10_000 });
  await shoot(page, "state-words-07-hover-ended");

  // Two panes: the changelog is worked in, the notes are shown beside it. A pane is read when the owner is at it
  // (it holds the keyboard and they did something in the page within the last minute, or their pointer, a wheel
  // or a touch was in it within the last half minute), not because it is on screen.
  const at = async (id: string) => { const b = (await station(page, id).boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2 + 3); };
  await page.evaluate(([a, b]) => {
    localStorage.setItem("keel.focus", "false");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: [a, b], sizes: {}, active: 0 }));
  }, [changelog, notes]);
  await page.goto(`/s/${changelog}`);
  await expect(station(page, notes)).toBeVisible();
  await at(changelog);
  await expect(row(page, changelog)).not.toHaveAttribute("data-unread", "true", { timeout: 15_000 });
  // The pane beside it is on screen, and nobody is at it: its row stays marked until the owner goes there.
  await page.waitForTimeout(1500);
  await expect(row(page, notes)).toHaveAttribute("data-unread", "true");
  await at(notes);
  await expect(row(page, notes)).not.toHaveAttribute("data-unread", "true", { timeout: 15_000 });
  // One that is not on screen stays unread.
  await expect(row(page, webhooks)).toHaveAttribute("data-unread", "true");
  // A reply arrives in the pane the owner is at: its row is not marked.
  await at(notes);
  await send(request, notes, "script:say One more item: the docs sweep started.");
  await expect(station(page, notes).getByTestId("transcript")).toContainText("One more item: the docs sweep started.", { timeout: 30_000 });
  await settle(request, notes);
  await page.waitForTimeout(2500);
  await expect(row(page, notes)).not.toHaveAttribute("data-unread", "true");
  expect((await unread()).sessions[notes] ?? 0).toBe(0);
  // The same reply in a session that is not on screen marks it.
  await send(request, webhooks, "script:say Verified again.");
  await settle(request, webhooks);
  await expect.poll(async () => (await unread()).sessions[webhooks] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);

  // The owner marks the session they are in unread, to come back to it: the page showing it does not read it back.
  await page.getByTestId("session-menu").first().click();
  await page.getByTestId("menu-unread").click();
  await expect(row(page, changelog)).toHaveAttribute("data-unread", "true");
  await page.waitForTimeout(2500);
  await expect(row(page, changelog)).toHaveAttribute("data-unread", "true");
  await shoot(page, "state-words-08-two-panes-marked-unread");
  // A reload is not going to the session: the mark is still there after it.
  await page.reload();
  await expect(row(page, changelog)).toHaveAttribute("data-unread", "true", { timeout: 15_000 });
  await page.waitForTimeout(2500);
  await expect(row(page, changelog)).toHaveAttribute("data-unread", "true");
  // Opening it again reads it.
  await row(page, webhooks).click();
  await expect(row(page, webhooks)).not.toHaveAttribute("data-unread", "true", { timeout: 15_000 });
  await row(page, changelog).click();
  await expect(row(page, changelog)).not.toHaveAttribute("data-unread", "true", { timeout: 15_000 });

  // And one action clears every unread mark.
  await page.waitForTimeout(1500); // the page says where it is within a second: the session just left is not on screen
  await send(request, webhooks, "script:say Verified a third time.");
  await settle(request, webhooks);
  await expect(row(page, webhooks)).toHaveAttribute("data-unread", "true", { timeout: 15_000 });
  await bell.click();
  await page.getByTestId("mark-all-read").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("session-list").locator('[data-testid="session-row"][data-unread="true"]')).toHaveCount(0);
  // (The two approvals are read and still wait: the bell still counts them, and has no dot.)
  await expect(page.getByTestId("inbox-count")).toHaveText("2");
  await expect(page.getByTestId("inbox-button")).not.toHaveAttribute("data-news", "true");
  await expect(bell).toHaveAccessibleName(/Nothing new since you last looked/);

  // A phone: the same parts. The two approvals were read by "clear all" and still wait: they are first.
  await send(request, webhooks, "script:say Verified a fourth time.");
  await settle(request, webhooks);
  await expect.poll(async () => (await unread()).total, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?inbox");
  await expect(page.getByTestId("inbox-part")).toHaveText([/^Needs you, 2$/, /^New since you looked, 1$/, /^Earlier, \d+$/]);
  await shoot(page, "state-words-06-inbox-phone");
});

test("a command left in the background is work, and a held message says when it is taken", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  // Its turn ended and a command it started still runs: the session works. It does not wait.
  const bg = await start(request, "Run the long migration");
  await send(request, bg, script([{ name: "Bash", input: { command: "sleep 240", run_in_background: true, description: "the long migration" } }]));
  await settle(request, bg);
  await expect.poll(async () => (await states(request))[bg]?.watch, { timeout: 30_000 }).toBe("work");
  // A turn that runs a command: a message sent to it is held, and says until when.
  const busy = await start(request, "Port the importer");
  await send(request, busy, script([{ name: "Bash", input: { command: "sleep 60; echo ported" } }]));
  await expect.poll(async () => (await states(request))[busy]?.why, { timeout: 30_000 }).toBe("tool");
  try {
    await page.goto(`/s/${busy}`);
    await expect(row(page, bg)).toHaveAttribute("data-watch", "work");
    await expect(row(page, bg).getByTestId("row-state")).toHaveText("Working");
    await expect(row(page, bg).getByTestId("row-why")).toHaveText(/^Command in background: the long migration/);
    // The words are in sentence case on the row, as in a pane's head.
    expect(await row(page, bg).getByTestId("row-state").evaluate((e) => getComputedStyle(e).textTransform)).toBe("none");
    await expect(station(page, busy).getByTestId("station-word")).toHaveText("Working");

    await page.getByTestId("composer").fill("Also keep the old importer behind a switch.");
    await page.keyboard.press("Enter");
    const item = page.getByTestId("queue-item");
    await expect(item.getByTestId("queue-word")).toHaveText("Queued");
    await expect(item.getByTestId("queue-when")).toHaveText("held until its current step ends");
    await shoot(page, "state-words-09-held-message");
    // Stopped, the same message waits for the owner: it says so.
    await request.post(`/api/sessions/${busy}/interrupt`, { data: { by: "owner" } });
    await expect(item.getByTestId("queue-when")).toHaveText("held until it is resumed", { timeout: 30_000 });
  } finally {
    for (const id of [bg, busy]) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});

// A daemon of the spec's own with a command hook: what leaves the machine is read from the hook's log.
test("a failure in a pane scrolled off the window is unread and notified; one in front of the owner waits until they leave", async ({ page }) => {
  test.setTimeout(240_000);
  const state = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state", `state-words-${Date.now().toString(36)}`);
  const log = join(state, "notify.log");
  const d = await ownDaemon(state, 0, { KEEL_NOTIFY_COMMAND: resolve("test/e2e/fixtures/notify-log.sh"), KEEL_NOTIFY_LOG: log });
  const api = async (path: string, o: { method?: string; data?: unknown } = {}) => {
    const r = await fetch(`${d.url}${path}`, { method: o.method ?? (o.data ? "POST" : "GET"), headers: o.data ? { "content-type": "application/json" } : {}, body: o.data ? JSON.stringify(o.data) : undefined });
    return r.json() as Promise<any>;
  };
  try {
    const ws = join(state, "ws");
    mkdirSync(ws, { recursive: true });
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const { session } = await api("/api/sessions", { data: { model: STAND_IN, title: `Pane ${i}`, workspace: ws } });
      await api(`/api/sessions/${session.id}/permissions`, { method: "PUT", data: { mode: "full-auto", sandbox: "off" } });
      ids.push(session.id);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(d.url);
    await page.evaluate((slots) => {
      localStorage.setItem("keel.focus", "false");
      localStorage.setItem("keel.panes", JSON.stringify({ count: 6, slots, sizes: {}, active: 0 }));
    }, ids);
    await page.goto(`${d.url}/s/${ids[0]}`);
    const pane = (i: number) => page.locator(`section.k-station[data-station="${ids[i]}"]`);
    await expect(page.locator("section.k-station[data-station]")).toHaveCount(6);
    // The sixth pane is placed and scrolled off the window; the first is in view.
    expect((await pane(5).boundingBox())!.x).toBeGreaterThan(1440);
    const first = (await pane(0).boundingBox())!;
    expect(first.x + first.width).toBeLessThanOrEqual(1440);
    // The owner is at the desk: they type in the first pane.
    const typing = async () => { await pane(0).getByTestId("composer").click(); await page.keyboard.type("x"); await page.keyboard.press("Backspace"); };
    await typing();
    await page.waitForTimeout(1500); // the page has said where its owner is
    const alertOf = async (id: string) => ((await api("/api/alerts?with_unread")).alerts as any[]).find((a) => a.session_id === id && ["failed", "limit"].includes(a.kind));
    const notified = (id: string) => existsSync(log) && readFileSync(log, "utf8").split("\n").filter(Boolean).some((l) => JSON.parse(l).session_id === id);
    const seen = async (id: string) => { const s = (await api(`/api/sessions/${id}`)).session; return !!s.settings.failed_ms && s.settings.fail_seen_ms === s.settings.failed_ms; };

    // A session fails in the pane that is off the window: nobody saw it.
    await api(`/api/sessions/${ids[5]}/messages`, { data: { text: "script:billing" } });
    await expect.poll(async () => (await alertOf(ids[5]!))?.read, { timeout: 30_000 }).toBe(false);
    // Its notification goes out at once, it is unread on the list and the bell, and its failure is still news.
    await expect.poll(() => notified(ids[5]!), { timeout: 15_000 }).toBe(true);
    await expect(row(page, ids[5]!)).toHaveAttribute("data-unread", "true");
    await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-news", "true");
    await typing();
    await page.waitForTimeout(2500);
    expect(await seen(ids[5]!)).toBe(false);
    await expect(row(page, ids[5]!)).toHaveAttribute("data-unread", "true");

    // A session fails in the pane in front of the owner while they work in it. A failure is not read by
    // being in view; it has been seen, and its notification is held back while they are there.
    await api(`/api/sessions/${ids[0]}/messages`, { data: { text: "script:billing" } });
    await expect.poll(async () => (await alertOf(ids[0]!))?.read, { timeout: 30_000 }).toBe(false);
    expect((await alertOf(ids[0]!)).data.withheld).toEqual(["command"]);
    await page.mouse.move(700, 500);
    await expect.poll(() => seen(ids[0]!), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(4000);
    expect(notified(ids[0]!)).toBe(false);
    await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-news", "true");
    await expect(page.getByTestId("inbox-count")).toHaveCount(0);
    await shoot(page, "state-words-11-six-panes-1440");
    // They leave the sessions (the page goes to Settings) and it still waits unread: now it is sent.
    await page.goto(`${d.url}/settings/general`);
    await expect.poll(() => notified(ids[0]!), { timeout: 20_000 }).toBe(true);
    expect((await alertOf(ids[0]!)).data.withheld).toBeUndefined();
  } finally {
    d.proc.kill();
    await exited(d.proc);
  }
});

// One status a session, the same count everywhere: a command left running and an agent that keeps one
// going are working, never "in background" as a count of their own and never Waiting; what waits is
// counted by root sessions; a turn that ended while its command runs is not Done.
test("one status a session: every surface counts working and waiting alike, and a turn that left a command running is not Done", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1920, height: 1040 });
  // A command that runs until its gate file is there (240 s at most), started in the background.
  const held = (name: string) => ({ name: "Bash", input: { command: `i=0; until [ -f ${gate(name)} ] || [ $i -ge 800 ]; do i=$((i+1)); sleep 0.3; done; echo ${name}`, run_in_background: true, description: `the ${name} run` } });
  mkdirSync(gates, { recursive: true });
  const own = await start(request, "One status: its own command runs on");
  const lead = await start(request, "One status: its agent keeps a command going");
  const quiet = await start(request, "One status: its agent waits on a timer");
  const made = [own, lead, quiet];
  try {
    await send(request, own, script([held("own")]));
    await send(request, lead, script([child("Keep the reindex going", script([held("agent")]))]));
    await send(request, quiet, script([child("Check back in an hour", script([{ name: "wait_for", input: { kind: "timer", seconds: 3600, note: "check back" } }]))]));
    for (const id of made) await settle(request, id);
    // The daemon's one status: the agent parked on its own command works, so its parent works with all its agents.
    await expect.poll(async () => { const s = await states(request); return [s[own]?.watch, s[own]?.why, s[lead]?.watch, s[lead]?.agents, s[lead]?.parked ?? 0, s[quiet]?.watch]; }, { timeout: 60_000 })
      .toEqual(["work", "command", "work", 1, 0, "wait"]);

    await page.goto("/");
    // The home says the daemon's numbers, counted by root session.
    const counted = async () => {
      const s = await states(request);
      const roots = ((await (await request.get("/api/sessions")).json()).sessions as { id: string; parent_id?: string | null; archived?: boolean; settings?: { helper?: boolean } }[])
        .filter((x) => !x.parent_id && !x.archived && !x.settings?.helper);
      const n = (w: string[]) => roots.filter((x) => w.includes(s[x.id]?.watch ?? "")).length;
      const home = async (w: string) => Number(await page.getByTestId(`home-count-${w}`).getAttribute("data-count").catch(() => "0")) || 0;
      return { api: [n(["work"]), n(["wait", "resume"])], home: [await home("work"), await home("wait")] };
    };
    await expect.poll(async () => { const c = await counted(); return c.home.join() === c.api.join() && c.api[0]! >= 2 && c.api[1]! >= 1; }, { timeout: 30_000 }).toBe(true);
    // No count of its own for a command in the background.
    await expect(page.getByTestId("home-watch")).not.toContainText("in background");

    // The parent of the agent that keeps a command going: its row, its head, its pill, its tree line and its board say working.
    await page.goto(`/s/${lead}`);
    await expect(row(page, lead).getByTestId("row-state")).toHaveText("Working");
    await expect(station(page, lead).getByTestId("station-word")).toHaveText("Working");
    // (The background list rests in the session menu since the bar holds one menu.)
    await expect(await inHead(page, "background-button")).toHaveText("1 working");
    await leaveHead(page);
    await expect(page.getByTestId("dock-agents")).toHaveAttribute("aria-label", /^Agents: 1 agent: 1 working/);
    await expect(page.getByTestId("dock-agent")).toHaveAttribute("data-watch", "work");
    await openPanel(page, "board");
    await expect(page.getByTestId("board-row").getByTestId("board-state")).toHaveText("working");
    await expect(page.getByTestId("board-summary")).toContainText("1 working");
    // The parent of the agent on a timer waits, as its agent does.
    await expect(row(page, quiet).getByTestId("row-state")).toHaveText("Waiting");

    // The turn that left its command running: the Inbox says the turn ended and what still runs, the home counts no Done,
    // and the alert a desktop notification is made of says the same.
    const alerts = (await (await request.get("/api/alerts")).json()).alerts as { kind: string; session_id: string; body: string; data?: { live?: { commands: number } } }[];
    const ended = alerts.find((a) => a.session_id === own && a.kind === "finished");
    expect(ended?.data?.live).toEqual({ commands: 1 });
    expect(ended?.body).toMatch(/^Turn ended, 1 command still runs\./);
    await page.goto("/");
    await page.getByTestId("inbox-button").click();
    const item = page.getByTestId("inbox-item").filter({ hasText: "One status: its own command runs on" });
    await expect(item.getByTestId("inbox-word")).toHaveText("Turn ended");
    await expect(item.getByTestId("inbox-line")).toHaveText(/^1 command still runs\./);
    await shoot(page, "state-words-10-one-status-inbox");
    await page.keyboard.press("Escape");
    const done = alerts.filter((a) => a.kind === "finished" && !a.data?.live).map((a) => a.session_id);
    expect(done).not.toContain(own);

    // On a phone the pane's head says the same word.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/s/${lead}`);
    await expect(page.locator(".k-station[data-helm]").getByTestId("station-word")).toHaveText("Working");
  } finally {
    for (const name of ["own", "agent"]) release(name);
    for (const id of made) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});

// A turn that ended while its command ran said "Turn ended, 1 command still runs". When that command ends and
// no turn follows (the owner stops it from its pane), the session is done: the row becomes the finish, saying
// what ended, and the home counts it as done since the owner looked.
test("a command stopped after its turn ended turns the session's 'still runs' alert into its finish", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(120_000);
  const held = { name: "Bash", input: { command: `i=0; until [ -f ${gate("stopped")} ] || [ $i -ge 800 ]; do i=$((i+1)); sleep 0.3; done; echo stopped`, run_in_background: true, description: "the stopped run" } };
  mkdirSync(gates, { recursive: true });
  const id = await start(request, "One status: its command is stopped by the owner");
  type A = { kind: string; session_id: string; body: string; read: boolean; data?: { live?: { commands: number } } };
  const finish = async () => ((await (await request.get("/api/alerts")).json()).alerts as A[]).find((a) => a.session_id === id && a.kind === "finished");
  try {
    await send(request, id, script([held]));
    await settle(request, id);
    await expect.poll(async () => (await finish())?.data?.live ?? null, { timeout: 30_000 }).toEqual({ commands: 1 });
    // The home does not count it as done while its command runs.
    await page.goto("/");
    const doneN = async () => Number((await page.getByTestId("home-count-finished").textContent({ timeout: 1000 }).catch(() => "0"))?.match(/\d+/)?.[0] ?? 0);
    await expect(page.getByTestId("home-watch")).toBeVisible();
    const before = await doneN();
    const job = ((await (await request.get(`/api/sessions/${id}/jobs`)).json()).jobs as { id: string; running?: boolean }[])[0]!;
    expect((await request.post(`/api/sessions/${id}/jobs/${job.id}/stop`)).ok()).toBe(true);
    // The row is the finish now: no command runs, and it says which one ended and how.
    await expect.poll(async () => { const a = await finish(); return a ? [!!a.data?.live, a.read, a.body.split(". ")[0]] : null; }, { timeout: 30_000 })
      .toEqual([false, false, 'The command "the stopped run" was stopped by the owner']);
    expect((await states(request))[id]?.watch).not.toBe("work");
    // The home counts it with the sessions done since the owner looked.
    await expect.poll(doneN, { timeout: 15_000 }).toBe(before + 1);
    await shoot(page, "state-words-11-stopped-command-done");
  } finally {
    release("stopped");
    await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});

// The home headline counts every state in words at the desk's widths: with a session in each state, each
// count is its figure and its word ("1 waiting"), and says in its tooltip which session a press opens.
// What is new is not a count of its own there: the rows' white dots and the Inbox say it.
test("the home headline says each state's count in words", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "requires the scripted provider");
  test.setTimeout(120_000);
  mkdirSync(gates, { recursive: true });
  const need = await start(request, "Line: an approval waits", "ask");
  const failed = await start(request, "Line: its credit ran out");
  const busy = await start(request, "Line: its command runs on");
  const timer = await start(request, "Line: it checks back in an hour");
  const told = await start(request, "Line: it said what it found");
  const made = [need, failed, busy, timer, told];
  try {
    await send(request, need, script([{ name: "Bash", input: { command: "touch line-approved.txt" } }]));
    await send(request, failed, "script:billing");
    await send(request, busy, script([{ name: "Bash", input: { command: `i=0; until [ -f ${gate("line")} ] || [ $i -ge 400 ]; do i=$((i+1)); sleep 0.3; done`, run_in_background: true, description: "the line run" } }]));
    await send(request, timer, script([{ name: "wait_for", input: { kind: "timer", seconds: 3600, note: "check back" } }]));
    await send(request, told, "script:say Found three stale caches.");
    await expect.poll(async () => { const s = await states(request); return made.map((id) => s[id]?.watch); }, { timeout: 60_000 }).toEqual(["need", "fail", "work", "wait", "done"]);
    for (const [width, height] of [[1400, 900], [1920, 1040]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      const words: [string, RegExp][] = [["need", /^\d+ needs? you$/], ["fail", /^\d+ failed$/], ["work", /^\d+ working$/], ["wait", /^\d+ waiting$/]];
      for (const [k, said] of words) {
        const count = page.getByTestId(`home-count-${k}`);
        await expect(count, `the ${k} count at ${width}`).toBeInViewport({ ratio: 1 });
        await expect(count).toHaveText(said);
        await expect(count).toHaveAttribute("title", /Open .+/);
      }
      await expect(page.getByTestId("home-count-wait")).toHaveAccessibleName(/^\d+ waiting\. Open /);
      await expect(row(page, told)).toHaveAttribute("data-news", "true");
      await expect(page.getByTestId("inbox-button")).toHaveAttribute("data-news", "true");
    }
    await shoot(page, "state-words-12-home-every-state");
  } finally {
    release("line");
    for (const id of made) await request.post(`/api/sessions/${id}/interrupt`, { data: { by: "owner" } }).catch(() => {});
  }
});
