import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: the work board. A coordinator starts three agents that commit on branches of their own:
// alpha runs the repository's named check and lands through the landing queue onto a main that moved
// (so main holds its patch, not its commit) and the after-land step runs on it; beta is reviewed by an
// agent started with `reviews: <its branch>` that refuses its head with keel__verdict, and main gets a
// commit with beta's subject but not its change; gamma is still working. A second reviewer, with a
// worktree of its own, names alpha's branch in its task only and approves its head with keel__verdict.
// At the end gamma starts a child that approves gamma's own branch: that is not gamma's review. Then a
// reviewer of the coordinator writes only "LAND: yes" (words only, never approved), another gives a
// structured yes and then a structured no on gamma's head (refused: its own newest), a third approves
// it (disputed: independent reviewers disagree), and the branch moves on: the verdicts read stale.
// The board (the API, the coordinator's keel__work_board and the Board panel) says of each what git,
// the check ledger, the landing queue and the agents table say: alpha landed as patches and live,
// approved; beta not landed, refused with the reviewer's line; gamma working, not landed, no review.
test("the work board keeps each agent's branch, checks, review, landed and live from facts", async ({ page, request }) => {
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `board-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(repo, "check.sh"), "echo checking; grep -q 'line 1' notes.md\n");
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { notes: "sh check.sh" }, land: { checks: ["notes"], after: "printf '%s\\n' \"$KEEL_LANDED\" >> ../after.log" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const gate = join(top, "gamma-may-end");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const commit = (sed: string, msg: string) => `sed -i '${sed}' notes.md && git -c user.name=k -c user.email=k@k commit -qam '${msg}'`;
  const bash = (command: string, timeout?: number) => ({ name: "Bash", input: { command, ...(timeout ? { timeout } : {}) } });

  // The coordinator's three agents. Alpha runs the named check on its commit; gamma keeps working until the spec lets it end.
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const lane = (title: string, steps: unknown[]) => ({ name: "spawn_agent", input: { message: `${title}\n${calls(steps)}` } });
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start three agents.", `script:batch ${JSON.stringify([
    lane("Lane alpha", [bash(commit("s/^line 1$/line 1 ALPHA/", "Lane alpha")), bash("sh check.sh")]),
    lane("Lane beta", [bash(commit("s/^line 12$/line 12 BETA/", "Lane beta"))]),
    lane("Lane gamma", [bash(`${commit("s/^line 6$/line 6 GAMMA/", "Lane gamma")} && while [ ! -e '${gate}' ]; do sleep 0.2; done`, 600_000)]),
  ])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(2);
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const alpha = await by("Lane alpha"), beta = await by("Lane beta");
  let gamma = await by("Lane gamma");
  await expect.poll(async () => { gamma = await by("Lane gamma"); return gamma.branch ? git(repo, "log", "-1", "--format=%s", gamma.branch).trim() : ""; }, { timeout: 60_000 }).toBe("Lane gamma");
  expect(gamma.status).toBe("running");
  await idle(coord);

  // main moves twice: a commit of its own, and one with beta's subject but another change (the board must not take it for beta's).
  writeFileSync(join(repo, "other.md"), "other\n");
  git(repo, "add", "other.md");
  git(repo, "commit", "-qm", "Other work on main");
  writeFileSync(join(repo, "other.md"), "other\nLane beta\n");
  git(repo, "commit", "-qam", "Lane beta");

  // Two reviewers, each with a structured verdict: one started with `reviews` that refuses beta's head, one
  // with a worktree of its own whose task names alpha's branch and approves alpha's head.
  const betaTip = git(repo, "rev-parse", beta.branch).trim();
  const alphaHead = git(repo, "rev-parse", alpha.branch).trim();
  const refusal = "P1-1: the parser accepts bad input; line 12 must keep its number.";
  const verdict = (commit: string, land: "yes" | "no", why: string) => ({ name: "keel__verdict", input: { commit, land, why } });
  await send(coord, ask("Start two reviewers.", `script:batch ${JSON.stringify([
    { name: "spawn_agent", input: { message: `Review it.\n${calls([verdict(betaTip.slice(0, 9), "no", refusal)])}`, agent_type: "explorer", reviews: beta.branch } },
    { name: "spawn_agent", input: { message: `Review the branch ${alpha.branch}.\n${calls([verdict(alphaHead, "yes", "Checked the diff; nothing blocks it.")])}` } },
  ])}`));
  await expect.poll(async () => (await agentsOf()).filter((a) => a.reviews?.length && a.status === "completed").length, { timeout: 60_000 }).toBe(2);
  const refuser = (await agentsOf()).find((a) => a.reviews?.includes(beta.branch))!;
  const approver = (await agentsOf()).find((a) => a.reviews?.includes(alpha.branch))!;
  expect(approver.branch).toBeTruthy();
  await idle(coord);

  // Alpha lands through the queue onto the moved main: rebased, so main holds its patch under another commit.
  await send(coord, calls([{ name: "keel__landing_queue", input: { action: "queue", branches: [alpha.branch] } }]));
  const entry = async () => ((await (await request.get(`/api/sessions/${coord}/landing`)).json()).entries as any[]).find((e) => e.branch === alpha.branch);
  await expect.poll(async () => (await entry())?.state, { timeout: 90_000 }).toBe("landed");
  const main = git(repo, "rev-parse", "main").trim();
  const alphaTip = git(repo, "rev-parse", alpha.branch).trim();
  expect(main).not.toBe(alphaTip);
  expect(() => git(repo, "merge-base", "--is-ancestor", alphaTip, main)).toThrow();
  await expect.poll(() => existsSync(join(top, "after.log")) && readFileSync(join(top, "after.log"), "utf8"), { timeout: 30_000 }).toBe(`${main}\n`);
  await idle(coord);

  // The board, as the page and the API read it.
  const board = async () => (await (await request.get(`/api/sessions/${coord}/board?fresh=1`)).json()) as any;
  const rowOf = (b: any, id: string) => b.rows.find((r: any) => r.id === id);
  await expect.poll(async () => rowOf(await board(), alpha.id)?.live?.state, { timeout: 30_000 }).toBe("yes");
  const b = await board();
  expect(b.total).toBe(5);
  const a = rowOf(b, alpha.id), be = rowOf(b, beta.id), g = rowOf(b, gamma.id), rv = rowOf(b, refuser.id);
  expect(a).toMatchObject({ state: "completed", branch: alpha.branch, head: alphaTip, landed: { state: "yes", how: "patch" }, live: { state: "yes", at: main, how: "after step passed" } });
  expect(a.checks).toEqual({ state: "known", passed: ["notes"], failed: [], notRun: [] });
  expect(a.review).toMatchObject({ by: approver.id, how: "task", verdict: "approved", source: "verdict", line: "Checked the diff; nothing blocks it.", current: true });
  expect(be).toMatchObject({ state: "completed", head: betaTip, landed: { state: "no", missing: 1 }, live: null });
  expect(be.checks).toEqual({ state: "known", passed: [], failed: [], notRun: ["notes"] });
  expect(be.review).toMatchObject({ by: refuser.id, how: "named", verdict: "refused", source: "verdict", line: refusal, tip: betaTip, of: betaTip, current: true });
  expect(g).toMatchObject({ state: "running", landed: { state: "no", missing: 1 }, review: null, worktree: "here" });
  expect(rv).toMatchObject({ branch: null, reviews: [beta.branch], landed: null });
  expect(rowOf(b, approver.id).reviews).toEqual([alpha.branch]);

  // The coordinator reads the same rows in a few hundred tokens, with no model request behind them.
  await send(coord, calls([{ name: "keel__work_board", input: {} }]));
  const told = async () => { const d = await (await request.get(`/api/sessions/${coord}`)).json(); return String(JSON.stringify(d.events.filter((e: any) => e.kind === "tool_result").at(-1)?.data ?? {})); };
  const text = await told();
  expect(text).toContain(`${gamma.id} working \\"Lane gamma\\"`);
  expect(text).toContain(`review refused by ${refuser.id}`);
  expect(text).toContain(`Landed (and live where a deploy is known): ${alpha.id}.`);
  expect(text).toContain(`Done, branch removed: ${approver.id}.`);
  expect(text.length).toBeLessThan(2400);

  // The Board panel, at the desktop size and the phone's, in both themes.
  await page.goto(`/s/${coord}`);
  await openPanel(page, "board");
  const panel = page.getByTestId("work-board");
  const card = (id: string) => panel.locator(`[data-testid="board-row"][data-agent="${id}"]`);
  await expect(card(alpha.id).getByTestId("board-landed")).toHaveAttribute("data-state", "yes");
  await expect(card(alpha.id).getByTestId("board-live")).toHaveAttribute("data-state", "yes");
  await expect(card(alpha.id).getByTestId("board-review")).toHaveAttribute("data-state", "approved");
  await expect(card(beta.id).getByTestId("board-landed")).toHaveAttribute("data-state", "no");
  await expect(card(beta.id).getByTestId("board-review")).toHaveAttribute("data-state", "refused");
  await expect(card(beta.id).getByTestId("board-verdict")).toContainText(refusal);
  await expect(card(beta.id).getByTestId("board-reviewer")).toContainText(`Reviewer ${refuser.title} wrote:`);
  await expect(card(gamma.id).getByTestId("board-live")).toHaveAttribute("data-state", "n/a");
  // The reviewer with a worktree of its own kept no commit: its branch went at its end, and nothing of it waits to land.
  await expect(card(approver.id).getByTestId("board-gone")).toBeVisible();
  await expect(card(gamma.id)).toHaveAttribute("data-state", "running");
  await expect(card(gamma.id).getByTestId("board-review")).toHaveAttribute("data-state", "none");
  await page.mouse.move(0, 0);
  await shoot(page, "work-board-01-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card(beta.id)).toBeVisible();
  await shoot(page, "work-board-02-phone");
  await page.setViewportSize({ width: 1920, height: 1040 });

  // Gamma ends when the spec lets it, then starts a child that approves gamma's own head: the board does not take it for a review.
  writeFileSync(gate, "");
  await expect.poll(async () => (await by("Lane gamma")).status, { timeout: 60_000 }).toBe("completed");
  await idle(gamma.session_id);
  const gammaHead = git(repo, "rev-parse", gamma.branch).trim();
  await send(gamma.session_id, calls([{ name: "spawn_agent", input: { message: `Review my work.\n${calls([verdict(gammaHead, "yes", "Mine looks fine.")])}`, agent_type: "explorer", reviews: gamma.branch } }]));
  const own = async () => ((await (await request.get(`/api/sessions/${gamma.session_id}/agents`)).json()).agents as any[]).find((x) => x.reviews?.includes(gamma.branch));
  await expect.poll(async () => (await own())?.status, { timeout: 60_000 }).toBe("completed");
  const after = await board();
  expect(after.total).toBe(6);
  expect(rowOf(after, gamma.id).review).toBeNull();

  // A reviewer of the coordinator writes only "LAND: yes": its words, quoted, never approved.
  await send(coord, ask("Review gamma in words.", `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: "Review it.\nscript:say Read the diff.\\n\\nLAND: yes", agent_type: "explorer", reviews: gamma.branch } }])}`));
  await expect.poll(async () => rowOf(await board(), gamma.id).review?.verdict, { timeout: 30_000 }).toBe("words");
  expect(rowOf(await board(), gamma.id).review).toMatchObject({ source: "words", line: "LAND: yes", current: true });
  await send(coord, calls([{ name: "keel__work_board", input: { agent: gamma.id } }]));
  expect(await told()).toContain("review words only (no structured verdict");
  await page.reload();
  await openPanel(page, "board");
  await expect(card(gamma.id).getByTestId("board-review")).toHaveAttribute("data-state", "words");
  await expect(card(gamma.id).getByTestId("board-verdict")).toContainText("LAND: yes");
  await page.mouse.move(0, 0);
  await shoot(page, "work-board-03-words");

  // Another gives a structured yes, then a structured no, on gamma's head: refused, the newest.
  await send(coord, ask("Review gamma.", `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: `Review it.\n${calls([verdict(gammaHead, "yes", "First pass looks fine."), verdict(gammaHead, "no", "Second pass: line 6 lost its number.")])}`, agent_type: "explorer", reviews: gamma.branch } }])}`));
  await expect.poll(async () => rowOf(await board(), gamma.id).review?.verdict, { timeout: 30_000 }).toBe("refused");
  expect(rowOf(await board(), gamma.id).review).toMatchObject({ source: "verdict", line: "Second pass: line 6 lost its number.", current: true });

  // A third reviewer approves the same head: the reviewers disagree, so the row says disputed, with both quoted.
  await send(coord, ask("Review gamma again.", `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: `Review it.\n${calls([verdict(gammaHead, "yes", "Line 6 reads right to me.")])}`, agent_type: "explorer", reviews: gamma.branch } }])}`));
  await expect.poll(async () => rowOf(await board(), gamma.id).review?.verdict, { timeout: 30_000 }).toBe("disputed");
  expect(rowOf(await board(), gamma.id).review).toMatchObject({ line: "Second pass: line 6 lost its number.", against: { line: "Line 6 reads right to me." } });
  await page.reload();
  await openPanel(page, "board");
  await expect(card(gamma.id).getByTestId("board-review")).toHaveAttribute("data-state", "disputed");
  await expect(card(gamma.id).getByTestId("board-verdict")).toContainText("Second pass: line 6 lost its number.");
  await expect(card(gamma.id).getByTestId("board-verdict-against")).toContainText("Line 6 reads right to me.");
  await page.mouse.move(0, 0);
  await shoot(page, "work-board-04-disputed");

  // Gamma's branch moves: the verdict is of a head that is no longer the branch's, stale, never refused or approved.
  const wt = (await by("Lane gamma")).worktree as string;
  git(wt, "commit", "-q", "--allow-empty", "-m", "Lane gamma, more");
  await expect.poll(async () => rowOf(await board(), gamma.id).review?.verdict, { timeout: 15_000 }).toBe("stale");
  expect(rowOf(await board(), gamma.id).review).toMatchObject({ current: false, of: gammaHead });
  await page.reload();
  await openPanel(page, "board");
  await expect(card(gamma.id).getByTestId("board-review")).toHaveAttribute("data-state", "stale");
});
