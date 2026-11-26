import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, SCRIPTED, openPanel, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: Your asks. The owner asks a coordinator for three changes in three messages; each turn starts one
// agent that commits on a branch of its own. Alpha lands through the landing queue and the after-land step runs
// on it; beta's head is refused by a reviewer; gamma still works. A fourth message asks for something the session
// only answers in words. The list holds his words, each with its state read from the agents, the review, the
// landing and what runs: Running, In review, Working, Replied. It opens from the session's menu and the dock.
test("your asks: each of the owner's asks with its state from the agents, the review, the base and what runs", async ({ page, request }) => {
  test.skip(!SCRIPTED, "needs the scripted stand-in: the agents' calls are scripted");
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `asks-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + `\nrun ${Date.now()}\n`);
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, "check.sh"), "grep -q 'line 1' notes.md\n");
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"], after: "printf '%s\\n' \"$KEEL_LANDED\" >> ../after.log" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const gate = join(top, "gamma-may-end");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const bash = (command: string, timeout?: number) => ({ name: "Bash", input: { command, ...(timeout ? { timeout } : {}) } });
  const lane = (title: string, steps: unknown[]) => `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: `${title}\n${calls(steps)}` } }])}`;
  // The owner's words first; the stand-in's script in a paragraph of its own.
  const said = (words: string, script: string) => `${words}\n\n${script}`;

  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title);
  await send(coord, said("Make the first line of the notes say ALPHA.", lane("Lane alpha", [bash(commit("s/^line 1$/line 1 ALPHA/", "Lane alpha")), bash("sh check.sh")])));
  await send(coord, said("Make the last line of the notes say BETA.", lane("Lane beta", [bash(commit("s/^line 12$/line 12 BETA/", "Lane beta"))])));
  await send(coord, said("Mark line six as GAMMA and keep at it until I look.", lane("Lane gamma", [
    bash(commit("s/^line 6$/line 6 GAMMA/", "Lane gamma")),
    bash(`while [ ! -e '${gate}' ]; do sleep 0.2; done`, 600_000),
  ])));
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(2);
  const alpha = await by("Lane alpha"), beta = await by("Lane beta");
  await expect.poll(async () => { const g = await by("Lane gamma"); return g?.branch ? git(repo, "log", "-1", "--format=%s", g.branch).trim() : ""; }, { timeout: 60_000 }).toBe("Lane gamma");

  // A reviewer refuses beta's head; alpha lands through the queue and the after-land step runs on it.
  const betaTip = git(repo, "rev-parse", beta.branch).trim();
  await send(coord, said("Have someone review the BETA branch before it lands.", `script:batch ${JSON.stringify([
    { name: "spawn_agent", input: { message: `Review it.\n${calls([{ name: "keel__verdict", input: { commit: betaTip, land: "no", why: "line 12 must keep its number" } }])}`, agent_type: "explorer", reviews: beta.branch } },
  ])}`));
  await expect.poll(async () => (await agentsOf()).find((a) => a.reviews?.includes(beta.branch))?.status, { timeout: 60_000 }).toBe("completed");
  await send(coord, said("Land the ALPHA branch now.", calls([{ name: "keel__landing_queue", input: { action: "queue", branches: [alpha.branch] } }])));
  const entry = async () => ((await (await request.get(`/api/sessions/${coord}/landing`)).json()).entries as any[]).find((e) => e.branch === alpha.branch);
  await expect.poll(async () => (await entry())?.state, { timeout: 90_000 }).toBe("landed");
  await expect.poll(() => existsSync(join(top, "after.log")) && readFileSync(join(top, "after.log"), "utf8").trim().length > 0, { timeout: 30_000 }).toBe(true);
  // An ask the session answers in words only.
  await send(coord, "What colour should the release notes use?");

  // The API: each ask is the owner's message, tied to the agent its turn started.
  const asks = (await (await request.get(`/api/sessions/${coord}/asks`)).json()).asks as any[];
  const ofWords = (w: string) => asks.find((a) => a.text.startsWith(w));
  expect(asks.map((a) => a.text.split("\n")[0])).toEqual([
    "What colour should the release notes use?",
    "Land the ALPHA branch now.",
    "Have someone review the BETA branch before it lands.",
    "Mark line six as GAMMA and keep at it until I look.",
    "Make the last line of the notes say BETA.",
    "Make the first line of the notes say ALPHA.",
  ]);
  expect(ofWords("Make the first line").links).toEqual([{ agent: alpha.id, by: "turn" }]);
  expect(ofWords("What colour").links).toEqual([]);
  // The board says alpha runs (the after-land step's commit holds it) before the page reads it.
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${coord}/board?fresh=1`)).json()).rows as any[]).find((r) => r.id === alpha.id)?.live?.state, { timeout: 30_000 }).toBe("yes");

  // The page: the dock's line opens the list, and so does the session's menu. Open asks first; the settled ones behind a press.
  await page.goto(`/s/${coord}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.getByTestId("dock-asks").click();
  const panel = page.getByTestId("asks-panel");
  await expect(panel).toBeVisible();
  await openPanel(page, "board");
  await expect(panel).toHaveCount(0);
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-asks").click();
  await expect(panel).toBeVisible();
  const rows = panel.getByTestId("ask-row");
  const state = (w: string) => rows.filter({ hasText: w });
  await expect(state("GAMMA and keep")).toHaveAttribute("data-state", "working");
  await expect(state("say BETA")).toHaveAttribute("data-state", "in review");
  await expect(state("What colour")).toHaveAttribute("data-state", "replied");
  await expect(state("Land the ALPHA")).toHaveAttribute("data-state", "replied");
  await expect(state("say ALPHA")).toHaveCount(0);
  await shoot(page, "asks-01-open");
  await panel.getByTestId("asks-all").click();
  await expect(state("say ALPHA")).toHaveAttribute("data-state", "running");
  await expect(state("review the BETA")).toHaveAttribute("data-state", "reported");
  // Opened: when and why, and the agent with its own state; the owner's words are never restated.
  await state("say ALPHA").getByTestId("ask-toggle").click();
  await expect(state("say ALPHA").getByTestId("ask-agent")).toHaveText(/Lane alpha/);
  await expect(state("say ALPHA").getByTestId("ask-agent")).toHaveAttribute("data-state", "running");
  await state("say BETA").getByTestId("ask-toggle").click();
  await expect(state("say BETA").getByTestId("ask-agent")).toHaveAttribute("data-state", "in review");
  await shoot(page, "asks-02-all-opened");
  // The owner's window: 1320x860 at the small text size.
  await page.setViewportSize({ width: 1320, height: 860 });
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "0.9"));
  await expect(state("say BETA").getByTestId("ask-agent")).toBeVisible();
  await shoot(page, "asks-04-1320x860-small");
  await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1"));
  await page.setViewportSize({ width: 1920, height: 1040 });

  // Gamma ends; its ask is no longer working.
  writeFileSync(gate, "");
  await expect(state("GAMMA and keep")).toHaveAttribute("data-state", "to land", { timeout: 60_000 });
});

// A phone has the list in the session's menu.
test.describe("your asks on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the session's menu opens your asks", async ({ page, request }) => {
    test.skip(!SCRIPTED, "needs the scripted stand-in: its answer is scripted");
    const s = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Phone asks" } })).json()).session.id as string;
    await request.post(`/api/sessions/${s}/messages`, { data: { text: "Make the release notes shorter please." } });
    await expect.poll(async () => ((await (await request.get(`/api/sessions/${s}/asks`)).json()).asks as any[]).map((a) => a.ended), { timeout: 60_000 }).toEqual([true]);
    await page.goto(`/s/${s}`);
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-asks").click();
    await expect(page.getByTestId("ask-row")).toHaveAttribute("data-state", "replied");
    await shoot(page, "asks-03-phone");
  });
});
