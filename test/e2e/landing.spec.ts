import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, scriptBash, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: the landing queue. A coordinator starts two agents that commit on
// branches of their own, and queues both with keel__landing_queue. Keel builds
// each on main plus the entries ahead of it in a worktree of its own and runs
// the repository's named check there: the first passes, the second fails only
// on top of the first and leaves the queue, told to the coordinator under that
// agent. main fast-forwards to the commit the check passed on, is pushed to
// origin, and the repository's after-land step runs once; the coordinator is
// told what landed. Another session may not land those branches: not with the
// tool, and not by calling the daemon's API from its shell. A third branch
// conflicts with main once the first landed: the panel offers no Land for it,
// and queued by the owner it leaves, its session told to rebase. The main
// checkout ends clean on the landed commit, and the queue's worktrees are gone.
test("a queue lands what passed on the exact tree, and a branch that fails or conflicts leaves told", async ({ page, request, baseURL }) => {
  test.setTimeout(240_000);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `landing-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  // The check passes on either change alone and fails on both together.
  writeFileSync(join(repo, "check.sh"), "echo checking; ! (grep -q ALPHA notes.md && grep -q BETA notes.md) || { echo 'ALPHA and BETA together'; exit 1; }\n");
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"], push: "origin", after: "printf '%s\\n' \"$KEEL_LANDED\" >> ../after.log" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(top, "init", "-q", "--bare", "origin.git");
  git(repo, "remote", "add", "origin", join(top, "origin.git"));
  git(repo, "push", "-q", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD").trim();

  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;

  // The coordinator's two agents, each committing on its own branch.
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  // The after step runs in the owner's checkout after a landing: it is held until he trusts it in the Trust panel.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${coord}`);
  await openPanel(page, "trust");
  const step = page.getByTestId("land-after-step");
  await expect(step).toHaveAttribute("data-state", "new");
  await expect(step).toContainText("KEEL_LANDED");
  await shoot(page, "landing-00-after-step-held");
  await step.getByTestId("trust-land-after").click();
  await expect(step).toHaveAttribute("data-state", "pinned");
  const lane = (title: string, sed: string) => ({ name: "spawn_agent", input: { message: `${title}\n${scriptBash(commit(sed, title))}` } });
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start two agents.", `script:batch ${JSON.stringify([lane("Lane alpha", "s/^line 1$/line 1 ALPHA/"), lane("Lane beta", "s/^line 12$/line 12 BETA/")])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(2);
  await idle(coord);
  const branchOf = async (title: string) => (await agentsOf()).find((a) => a.title === title)!.branch as string;
  const alpha = await branchOf("Lane alpha"), beta = await branchOf("Lane beta");
  expect(git(repo, "log", "-1", "--format=%s", alpha).trim()).toBe("Lane alpha");

  // A third, top-level session: it may not land the coordinator's agents' branches.
  const g = await (await request.post("/api/worktrees", { data: { workspace: repo, model: HAIKU, title: "Lane gamma", text: ask("Commit.", scriptBash(commit("s/^line 1$/line 1 gamma/", "gamma"))) } })).json();
  const gamma = { id: g.session.id as string, branch: g.worktree.branch as string };
  await idle(gamma.id);
  await send(gamma.id, calls([{ name: "keel__landing_queue", input: { action: "queue", branches: [alpha] } }]));
  const lastResult = async (id: string) => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return JSON.stringify(d.events.filter((e: any) => e.kind === "tool_result").at(-1)?.data ?? {}); };
  expect(await lastResult(gamma.id)).toContain("another session holds it");
  // Its shell, outside a sandbox, reaches the daemon's API: the owner's route refuses it.
  await request.put(`/api/sessions/${gamma.id}/permissions`, { data: { sandbox: "off" } });
  const url = `${baseURL}/api/sessions/${gamma.id}/landing`;
  await send(gamma.id, ask("Call the API.", scriptBash(`curl -s -o /dev/null -w 'status=%{http_code}' -X POST -H 'content-type: application/json' -d '{"branches":["${alpha}"]}' ${url}`)));
  expect(await lastResult(gamma.id)).toContain("status=403");
  const view = async (id: string) => (await request.get(`/api/sessions/${id}/landing`)).json();
  expect((await view(coord)).entries).toEqual([]);

  // The coordinator queues its agents' branches: alpha, then beta.
  await send(coord, ask(`Queue ${alpha} and ${beta} to land with keel__landing_queue, then end your turn.`, calls([{ name: "keel__landing_queue", input: { action: "queue", branches: [alpha, beta] } }])));
  const stateOf = async (branch: string) => (await view(coord)).entries.find((e: any) => e.branch === branch)?.state;
  await expect.poll(() => stateOf(beta), { timeout: 90_000 }).toBe("left");
  await expect.poll(() => stateOf(alpha), { timeout: 30_000 }).toBe("landed");
  const entries = (await view(coord)).entries;
  const a = entries.find((e: any) => e.branch === alpha);
  const b = entries.find((e: any) => e.branch === beta);
  // Alpha held main: it lands as itself, a fast-forward. main and origin are on it, and its tree passed the check.
  const main = git(repo, "rev-parse", "main").trim();
  expect(main).toBe(a.landed);
  expect(main).toBe(git(repo, "rev-parse", alpha).trim());
  expect(git(join(top, "origin.git"), "rev-parse", "main").trim()).toBe(main);
  const runs = (await (await request.get(`/api/checks?tree=${git(repo, "rev-parse", "main^{tree}").trim()}`)).json()).runs;
  expect(runs.some((r: any) => r.name === "notes" && (r.result === "pass" || r.result === "answered"))).toBe(true);
  expect(b.why).toContain(`notes failed on it built on main at ${base.slice(0, 9)} with ${alpha} ahead of it`);
  expect(b.why).toContain("ALPHA and BETA together");
  // The after-land step ran once, for the one batch.
  await expect.poll(() => existsSync(join(top, "after.log")) && readFileSync(join(top, "after.log"), "utf8"), { timeout: 30_000 }).toBe(`${main}\n`);

  // The coordinator is told why beta left (a failure under that agent) and what landed.
  const said = async (id: string, kind: string, words: string) => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return d.events.filter((e: any) => e.kind === "user" && JSON.stringify(e.data).includes(`"kind":"${kind}"`) && String(e.data.text).includes(words)).length;
  };
  await expect.poll(() => said(coord, "failures", `${beta} left the landing queue of main: notes failed`), { timeout: 60_000 }).toBe(1);
  await expect.poll(() => said(coord, "landing", `Landed on main: ${alpha}`), { timeout: 60_000 }).toBe(1);
  await idle(coord);

  // The Branches panel shows the queue: what landed and what left, in both themes.
  await page.goto(`/s/${coord}`);
  // The turn the outcome started is folded into one line of the conversation: it is opened first.
  const run = page.getByTestId("lens-run").last();
  await expect(run).toBeVisible({ timeout: 30_000 });
  if ((await run.getAttribute("data-open")) === null) await run.getByTestId("lens-run-toggle").click();
  await expect(page.getByTestId("landing-notice")).toBeVisible();
  await openPanel(page, "branches");
  const panel = page.getByTestId("branches-panel");
  await expect(panel.locator(`[data-testid="landing-entry"][data-branch="${alpha}"]`)).toHaveAttribute("data-state", "landed");
  await expect(panel.locator(`[data-testid="landing-entry"][data-branch="${beta}"]`)).toHaveAttribute("data-state", "left");
  await expect(panel.getByTestId("landing-rules")).toContainText("checks notes · pushed to origin");
  await shoot(page, "landing-01-landed-and-left");

  // Gamma changes the line alpha changed: it conflicts with main now. The panel offers no Land for it;
  // queued by the owner all the same, it leaves told to rebase.
  await panel.getByTestId("overlap-refresh").click();
  const gammaRow = panel.locator(`[data-testid="overlap-branch"][data-branch="${gamma.branch}"]`);
  await expect(gammaRow.getByTestId("land-rebase-first")).toBeVisible();
  await expect(gammaRow.getByTestId("land-queue")).toHaveCount(0);
  expect((await request.post(`/api/sessions/${coord}/landing`, { data: { branches: [gamma.branch] } })).status()).toBe(200);
  await expect(panel.locator(`[data-testid="landing-entry"][data-branch="${gamma.branch}"]`)).toHaveAttribute("data-state", "left", { timeout: 60_000 });
  await expect(panel.locator(`[data-testid="landing-entry"][data-branch="${gamma.branch}"]`).getByTestId("landing-why")).toContainText("conflicts with main");
  await page.mouse.move(0, 0);
  await shoot(page, "landing-02-conflict");
  await expect.poll(() => said(gamma.id, "failures", `${gamma.branch} left the landing queue of main: it conflicts with main at ${main.slice(0, 9)} in notes.md: rebase it onto main`), { timeout: 60_000 }).toBe(1);

  // main did not move for the branches that left; the main checkout is clean on it; the queue's worktrees are gone.
  expect(git(repo, "rev-parse", "main").trim()).toBe(main);
  expect(git(repo, "rev-parse", "HEAD").trim()).toBe(main);
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes("/landing/"))).toEqual([]);
  expect(readFileSync(join(top, "after.log"), "utf8")).toBe(`${main}\n`);
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

// Feature: a queued branch that conflicts with the base goes to its own agent. The coordinator's
// agent delta changed the line main changed since; queued, it conflicts, and Keel continues delta
// with a rebase task naming the branch, main's tip, the commit the rebase stops at, the file and
// main's lines there. Delta rebases, keeps both sides and runs the check; the entry is checked again
// on the exact tree and lands. Epsilon's agent was archived before its branch was queued: a fresh
// agent of the coordinator takes the branch over in a worktree of its own and does not settle it;
// after two tries it goes to the coordinator, told under that agent.
test("a conflict with the base goes to the branch's own agent, which rebases it; two failed tries go to the coordinator", async ({ page, request }) => {
  test.setTimeout(240_000);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `landing-rebase-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(repo, "check.sh"), "! grep -q '^<<<<<<<' notes.md\n");
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"] } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  // Delta, sent a rebase task, rebases onto main keeping both sides of line 5, and runs the check.
  const settle = "git rebase main || { sed -i -e '/^<<<<<<< /,/^>>>>>>> /c\\\\line 5 MAIN DELTA' notes.md && git add notes.md && GIT_EDITOR=true git -c user.name=k -c user.email=k@k rebase --continue; }; sh check.sh && echo settled";
  const delta = { name: "spawn_agent", input: { message: `Lane delta\n${scriptBash(commit("s/^line 5$/line 5 DELTA/", "Lane delta"))}\nscript:then-calls ${JSON.stringify([{ name: "Bash", input: { command: settle }, after_ms: 10_000 }])}` } };
  const eps = { name: "spawn_agent", input: { message: `Lane epsilon\n${scriptBash(commit("s/^line 9$/line 9 EPS/", "Lane epsilon"))}` } };
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start two agents.", `script:batch ${JSON.stringify([delta, eps])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(2);
  await idle(coord);
  const of = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const d = await of("Lane delta"), e = await of("Lane epsilon");
  // main changes lines 5 and 9 since: both branches conflict with it. Epsilon's agent is archived.
  writeFileSync(join(repo, "notes.md"), readFileSync(join(repo, "notes.md"), "utf8").replace("line 5\n", "line 5 MAIN\n").replace("line 9\n", "line 9 MAIN\n"));
  git(repo, "commit", "-qam", "main changes lines 5 and 9");
  const main0 = git(repo, "rev-parse", "main").trim();
  expect((await request.patch(`/api/sessions/${e.session_id}`, { data: { archived: true } })).ok()).toBe(true);

  await page.goto(`/s/${coord}`);
  await openPanel(page, "branches");
  const panel = page.getByTestId("branches-panel");
  await send(coord, ask(`Queue ${d.branch} and ${e.branch} with keel__landing_queue, then end your turn.`, `script:calls ${JSON.stringify([{ name: "keel__landing_queue", input: { action: "queue", branches: [d.branch, e.branch] } }])}`));
  const view = async () => (await request.get(`/api/sessions/${coord}/landing`)).json();
  const entryOf = async (branch: string) => (await view()).entries.find((x: any) => x.branch === branch);

  // Delta's entry waits on its agent (it takes a while to rebase); the panel says so.
  const deltaRow = panel.locator(`[data-testid="landing-entry"][data-branch="${d.branch}"]`);
  await expect(deltaRow).toHaveAttribute("data-state", "resolving", { timeout: 60_000 });
  await expect(deltaRow.getByTestId("landing-why")).toContainText("its agent rebases it onto main (try 1 of 2)");
  await page.mouse.move(0, 0);
  await shoot(page, "landing-03-agent-rebases");

  // The task delta was sent names the branch, main's tip, the commit the rebase stops at, the file and main's lines.
  const userTexts = async (sid: string) => ((await (await request.get(`/api/sessions/${sid}`)).json()).events as any[]).filter((x) => x.kind === "user").map((x) => String(x.data.text ?? ""));
  const task = (await userTexts(d.session_id)).find((t) => t.startsWith("[harness] Landing queue:"))!;
  expect(task).toContain(`your branch ${d.branch} conflicts with main`);
  expect(task).toContain(`main is now at ${main0.slice(0, 9)} (main changes lines 5 and 9)`);
  expect(task).toMatch(/stops at [0-9a-f]{9} \(Lane delta\)/);
  expect(task).toContain("notes.md: main's lines 5");

  // Delta settled it: checked again on the tree that lands, and landed.
  await expect.poll(async () => (await entryOf(d.branch))?.state, { timeout: 90_000 }).toBe("landed");
  const main1 = git(repo, "rev-parse", "main").trim();
  expect(git(repo, "log", "--format=%s", "-3", "main").trim().split("\n")).toEqual(["Lane delta", "main changes lines 5 and 9", "init"]);
  expect(readFileSync(join(repo, "notes.md"), "utf8")).toContain("line 5 MAIN DELTA\n");
  expect((await entryOf(d.branch)).landed).toBe(main1);

  // Epsilon: a fresh agent took it over, did not settle it, and after two tries it left, told to the coordinator.
  await expect.poll(async () => (await entryOf(e.branch))?.state, { timeout: 120_000 }).toBe("left");
  const left = await entryOf(e.branch);
  expect(left.why).toContain("it conflicts with main");
  expect(left.why).toContain("its agent did not move the branch, after 2 tries");
  const fresh = (await agentsOf()).find((a) => a.title === `Rebase ${e.branch}`);
  expect(fresh).toBeTruthy();
  expect((await userTexts(fresh.session_id)).join("\n")).toContain(`The agent that made ${e.branch} is gone: you take over its branch`);
  const told = async (words: string) => (await userTexts(coord)).filter((t) => t.includes(words)).length;
  await expect.poll(() => told(`${e.branch} left the landing queue of main: it conflicts with main`), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => told(`Landed on main: ${d.branch}`), { timeout: 60_000 }).toBeGreaterThan(0);
  await idle(coord);

  await expect(panel.locator(`[data-testid="landing-entry"][data-branch="${e.branch}"]`)).toHaveAttribute("data-state", "left", { timeout: 30_000 });
  await expect(deltaRow).toHaveAttribute("data-state", "landed");
  await page.mouse.move(0, 0);
  await shoot(page, "landing-04-rebased-and-handed-up");
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && l.includes("/landing/"))).toEqual([]);
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

// Feature: a worktree whose agent ended with files it never committed. The Branches panel does not say
// that no session holds a branch: it says how many worktrees have no commit yet, and for each its agent,
// its uncommitted files and that its agent ended.
test("the Branches panel names a worktree with no commit yet instead of saying no session holds a branch", async ({ page, request }) => {
  test.setTimeout(180_000);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `landing-bare-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "line 1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const builder = { name: "spawn_agent", input: { message: `Builder\n${scriptBash("echo one > one.txt && echo two > two.txt")}` } };
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start a builder.", `script:calls ${JSON.stringify([builder])}`) } });
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[]).filter((a) => a.status === "completed").length, { timeout: 90_000 }).toBe(1);
  await page.goto(`/s/${coord}`);
  await openPanel(page, "branches");
  const panel = page.getByTestId("branches-panel");
  await expect(panel.getByTestId("overlap-unheld-head")).toContainText("1 worktree with no commit yet");
  const row = panel.getByTestId("overlap-unheld-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Builder");
  await expect(row).toContainText("2 uncommitted files");
  await expect(row).toContainText("agent ended");
  await expect(panel).not.toContainText("No session holds a branch");
  await shoot(page, "landing-05-no-commit-yet");
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

// Feature: one place to land every ready branch. The Branches panel lists the branches whose agents
// ended and that wait to land, each with Land, and "Land all ready" queues them in order, each after
// the one before it landed, and stops at the first that does not land. Here the second fails its
// check once the first is on main, so the third is never asked for.
test("the Branches panel lands every ready branch in order and stops at the first that fails", async ({ page, request }) => {
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `landing-ready-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  // Passes on each change alone; fails once the first and the second are both on the tree.
  writeFileSync(join(repo, "check.sh"), "! (grep -q ALPHA notes.md && grep -q BETA notes.md) || { echo 'ALPHA and BETA together'; exit 1; }\n");
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"] } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const lane = (title: string, sed: string) => ({ name: "spawn_agent", input: { message: `${title}\n${scriptBash(commit(sed, title))}` } });
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Ready coordinator" } })).json()).session.id as string;
  try {
    await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start three agents.", `script:batch ${JSON.stringify([lane("Lane alpha", "s/^line 1$/line 1 ALPHA/"), lane("Lane beta", "s/^line 6$/line 6 BETA/"), lane("Lane gamma", "s/^line 12$/line 12 GAMMA/")])}`) } });
    const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
    await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(3);
    await idle(coord);
    const branchOf = async (title: string) => (await agentsOf()).find((a) => a.title === title)!.branch as string;
    const alpha = await branchOf("Lane alpha"), beta = await branchOf("Lane beta"), gamma = await branchOf("Lane gamma");

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${coord}`);
    await openPanel(page, "branches");
    const panel = page.getByTestId("branches-panel");
    const section = panel.getByTestId("ready-section");
    await expect(section.getByTestId("ready-row")).toHaveCount(3, { timeout: 30_000 });
    for (const b of [alpha, beta, gamma]) await expect(section.locator(`[data-testid="ready-row"][data-branch="${b}"]`).getByTestId("ready-land")).toBeEnabled();
    await expect(section.getByTestId("ready-land-all")).toHaveText(/Land all ready · 3/);
    // Listed once: the same branches are not repeated as ended ones further down.
    await expect(panel.getByTestId("overlap-unheld-row")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await shoot(page, "landing-04-ready");

    await section.getByTestId("ready-land-all").click();
    // Alpha lands; beta is checked on top of it and leaves; gamma is never asked for.
    await expect(section.getByTestId("ready-result")).toContainText(`Stopped at ${beta.replace(/^keel\//, "")}`, { timeout: 120_000 });
    await expect(section.getByTestId("ready-result")).toContainText(`Landed 1: ${alpha.replace(/^keel\//, "")}`);
    const view = (await (await request.get(`/api/sessions/${coord}/landing`)).json()).entries as { branch: string; state: string; tip: string; owner_tip: string | null; owner_via: string | null }[];
    expect(view.find((e) => e.branch === alpha)?.state).toBe("landed");
    // The page said which head it showed: the landing is kept as the owner's own, of that commit, from this session.
    const landed = view.find((e) => e.branch === alpha)!;
    expect([landed.owner_tip, landed.owner_via]).toEqual([landed.tip, coord]);
    expect(view.find((e) => e.branch === beta)?.state).toBe("left");
    expect(view.some((e) => e.branch === gamma)).toBe(false);
    expect(git(repo, "log", "--format=%s", "-2", "main").trim().split("\n")).toEqual(["Lane alpha", "init"]);
    // What is left to land is still listed, with its own Land: gamma.
    await expect(section.locator(`[data-testid="ready-row"][data-branch="${gamma}"]`).getByTestId("ready-land")).toBeEnabled();
    await page.mouse.move(0, 0);
    await shoot(page, "landing-05-ready-stopped");
  } finally {
    await request.post(`/api/sessions/${coord}/interrupt`, { data: { by: "owner" } }).catch(() => {});
    await request.delete(`/api/sessions/${coord}`).catch(() => {});
  }
});
