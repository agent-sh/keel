import { expect, test, type Page } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { specEnv } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: the next-look queue. What waits on the owner is ordered by what the
// wait costs, not by when it was asked: a coordinator's agent asks to run a
// command while the agent above it waits on its report and its large context
// sits in a prompt cache that lapses, and a plain question with nothing behind
// it waits beside it. The approval comes first, its row saying what the wait
// costs, at a desk and on a phone; the key that goes to what waits goes there
// first too. While the owner's keyboard or pointer is in the list nothing in it
// moves: what comes meanwhile joins at the end.
// The spec runs its own daemon on the scripted stand-in with a prompt cache
// that keeps 10 minutes (KEEL_SCRIPTED_CACHE_TTL_MS), so each wait's cache
// plan knows its cache's life and size.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const TTL = 10 * 60_000;

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const env = specEnv(state, { KEEL_SCRIPTED_CACHE_TTL_MS: String(TTL) }, join(state, "work"));
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], { env, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

const needRows = (page: Page) => page.locator('[data-testid="inbox-item"][data-part="need"]');
const words = (page: Page) => needRows(page).evaluateAll((els) => els.map((e) => e.querySelector('[data-testid="inbox-word"]')?.textContent));

test("what waits is ordered by what the wait costs, and each row says it", async ({ page }) => {
  test.setTimeout(150_000);
  const state = join(ROOT, `next-look-${Date.now()}`);
  for (const d of ["state", "work"]) mkdirSync(join(state, d), { recursive: true });
  const d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const alerts = async () => ((await call("/api/alerts")).alerts as any[]).filter((a) => a.open);
  try {
    // First, the cheap one: a question in a session of its own, with a small context and nothing behind it.
    const { session: q } = await call("/api/sessions", { model: "scripted:stand-in", title: "Pick a color" });
    await call(`/api/sessions/${q.id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    const colors = { name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color should I use?", options: [{ label: "Teal" }, { label: "Amber" }], multiSelect: false }] } };
    await call(`/api/sessions/${q.id}/messages`, { text: `script:calls ${JSON.stringify([colors])}` });
    await expect.poll(async () => (await alerts()).map((a) => a.kind), { timeout: 30_000 }).toEqual(["question"]);

    // The owner is in the list, on the keyboard (the question's row has focus), when the costlier one comes.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/?inbox=1`);
    await expect(needRows(page)).toHaveCount(1, { timeout: 20_000 });
    await needRows(page).first().locator("button").first().focus();
    await expect(page.getByTestId("inbox-list")).toHaveAttribute("data-held", "");

    // Then the expensive one: a coordinator's agent waits on an agent of its own, whose command asks,
    // with a context worth a cache.
    const { session: c } = await call("/api/sessions", { model: "scripted:claude-stand-in", title: "Ship the importer" });
    await call(`/api/sessions/${c.id}/permissions`, { mode: "ask", sandbox: "off" }, "PUT");
    const notes = "Notes the agent carries about the importer and its retries. ".repeat(2500);
    const inner = { name: "Agent", input: { description: "Run the migration", prompt: `${notes}\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: "echo migrated > migrated.txt" } }])}` } };
    const outer = { name: "Agent", input: { description: "Plan the importer", prompt: `Plan it\nscript:calls ${JSON.stringify([inner])}` } };
    await call(`/api/sessions/${c.id}/messages`, { text: `script:calls ${JSON.stringify([outer])}` });
    await expect.poll(async () => (await alerts()).map((a) => a.kind).sort(), { timeout: 60_000 }).toEqual(["approval", "question"]);

    // The daemon kept what each wait cost when it began: the approval's agents and cache, the question's small cache.
    const open = await alerts();
    const ask = open.find((a) => a.kind === "approval")!.data.wait;
    const asked = open.find((a) => a.kind === "question")!.data.wait;
    expect(ask.agents).toBe(3);
    expect(ask.tokens).toBeGreaterThan(20_000);
    expect(ask.until).toBeGreaterThan(Date.now());
    expect(asked.agents).toBe(0);
    expect(ask.key).toBeGreaterThan(asked.key);

    // Nothing moves under the owner: the approval joins at the end, and stays there when the pointer
    // comes into the list as well. Only when both have left does it take its place.
    await expect(needRows(page)).toHaveCount(2, { timeout: 20_000 });
    expect(await words(page)).toEqual(["Question", "Approval"]);
    const list = page.getByTestId("inbox-list");
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await expect(list).toHaveAttribute("data-held", "");
    expect(await words(page)).toEqual(["Question", "Approval"]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await words(page)).toEqual(["Question", "Approval"]);
    await page.mouse.move(0, 0);
    await expect(list).not.toHaveAttribute("data-held", "");

    // At a desk: the newer approval stands first, with its cost; the question after it.
    await expect.poll(() => words(page)).toEqual(["Approval", "Question"]);
    const cost = needRows(page).first().getByTestId("inbox-cost");
    await expect(cost).toHaveText(/^3 agents wait( \(\$[\d.]+\/min\))?; cache of \d+K tokens expires in (9|10) min: about \$0\.\d+ to rewrite$/);
    await expect(needRows(page).nth(1).getByTestId("inbox-cost")).toHaveText(/^Cache of \d+K? tokens expires in/);
    await page.mouse.move(0, 0);
    await shoot(page, "next-look-01-desk");

    // The key that goes to what waits follows the same order: the approval's page first, then the question's.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inbox-panel")).toHaveCount(0);
    const agentOf = async (id: string) => ((await call(`/api/sessions/${id}/agents`)).agents as any[])[0]?.session_id as string;
    const planner = await agentOf(c.id);
    const tree = [c.id, planner, await agentOf(planner)].map((id) => `/s/${id}`);
    await page.keyboard.press("Alt+a");
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).not.toBe("/");
    expect(tree).toContain(new URL(page.url()).pathname);

    // On a phone: the same order and the same line.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${d.url}/?inbox=1`);
    await expect(needRows(page)).toHaveCount(2, { timeout: 20_000 });
    expect(await words(page)).toEqual(["Approval", "Question"]);
    await expect(needRows(page).first().getByTestId("inbox-cost")).toBeVisible();
    await shoot(page, "next-look-02-phone");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
    rmSync(`${state}-ws`, { recursive: true, force: true });
  }
});
