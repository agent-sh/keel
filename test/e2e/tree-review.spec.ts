import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

// The checks of what a change added are soft: a run on a build without it names every one that fails.
const soft = expect.configure({ soft: true });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: one review for a tree. A coordinator's three agents each leave a branch: alpha changes line 3 of
// src/board/rules.ts and adds ui/src/components/BoardCard.tsx (which joins the src/board area by its name),
// and a reviewer approves its head; beta changes lines 3 and 4 of the same file (it would conflict with
// alpha); gamma changes src/landing/queue.ts and the README. The Work board's "Review the tree" shows the
// three branches as one diff by area, each hunk with its agent, branch, verdict and checks, alpha's and
// beta's hunks side by side under git's conflict note, and the landing order proposed from it (alpha and
// gamma first, beta after alpha). The owner sends beta back with a note (its agent gets it), lands
// src/board (alpha only: beta is held while its change there is the same) through the landing queue, drops the top level,
// and src/landing then cannot land: gamma also changes the dropped top level.
test("the tree review reads every agent's branch as one diff by area and lands, sends back or drops each area", async ({ page, request }) => {
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tree-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(join(repo, "src/board"), { recursive: true });
  mkdirSync(join(repo, "src/landing"), { recursive: true });
  mkdirSync(join(repo, ".keel"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/board/rules.ts"), Array.from({ length: 10 }, (_, i) => `export const rule${i + 1} = ${i + 1};`).join("\n") + "\n");
  writeFileSync(join(repo, "src/landing/queue.ts"), Array.from({ length: 6 }, (_, i) => `export const step${i + 1} = ${i + 1};`).join("\n") + "\n");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, "check.sh"), "echo checking; test -f src/board/rules.ts\n");
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { files: "sh check.sh" }, land: { checks: ["files"] } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const commit = (msg: string) => `git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`;

  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const lane = (title: string, command: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([bash(command)])}` } });
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start three agents.", `script:batch ${JSON.stringify([
    lane("Lane alpha", `sed -i 's/rule3 = 3/rule3 = 30/' src/board/rules.ts && mkdir -p ui/src/components && printf 'export const BoardCard = () => null;\\n' > ui/src/components/BoardCard.tsx && ${commit("Lane alpha")}`),
    lane("Lane beta", `sed -i 's/rule3 = 3/rule3 = 300/; s/rule4 = 4/rule4 = 400/' src/board/rules.ts && ${commit("Lane beta")}`),
    lane("Lane gamma", `sed -i 's/step2 = 2/step2 = 20/' src/landing/queue.ts && printf 'Landing steps.\\n' >> README.md && ${commit("Lane gamma")}`),
  ])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(3);
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const alpha = await by("Lane alpha"), beta = await by("Lane beta"), gamma = await by("Lane gamma");
  await idle(coord);
  // A reviewer approves alpha's head with a structured verdict.
  const alphaHead = git(repo, "rev-parse", alpha.branch).trim();
  await send(coord, ask("Review alpha.", `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Review it.\n${calls([{ name: "keel__verdict", input: { commit: alphaHead, land: "yes", why: "Reads right." } }])}`, agent_type: "explorer", reviews: alpha.branch } }])}`));
  await expect.poll(async () => (await agentsOf()).filter((a) => a.reviews?.length && a.status === "completed").length, { timeout: 60_000 }).toBe(1);
  await idle(coord);

  // The review as the API reads it: areas by path, the overlap with git's word on it, the order.
  const tree = async (fresh = true) => (await (await request.get(`/api/sessions/${coord}/tree-review${fresh ? "?fresh=1" : ""}`)).json()) as any;
  await expect.poll(async () => (await tree()).branches.find((b: any) => b.branch === alpha.branch)?.verdict, { timeout: 30_000 }).toBe("approved");
  const v = await tree();
  expect(v.branches.map((b: any) => b.branch).sort()).toEqual([alpha.branch, beta.branch, gamma.branch].sort());
  const areaOf = (key: string) => v.areas.find((a: any) => a.key === key);
  expect(areaOf("src/board").files.map((f: any) => f.path)).toEqual(["src/board/rules.ts", "ui/src/components/BoardCard.tsx"]);
  expect(areaOf("src/board").branches).toEqual([alpha.branch, beta.branch].sort());
  expect(areaOf("src/landing").branches).toEqual([gamma.branch]);
  expect(areaOf(".").files.map((f: any) => f.path)).toEqual(["README.md"]);
  expect(v.overlaps).toHaveLength(1);
  expect(v.overlaps[0]).toMatchObject({ path: "src/board/rules.ts", area: "src/board", conflict: true });
  expect(v.overlaps[0].note).toContain("Would conflict when landing");
  expect(v.order.steps.map((s: any) => s.branches)).toEqual([[alpha.branch, gamma.branch], [beta.branch]]);
  // Each head's diff is read once: a second read takes them all from before.
  const again = await tree();
  expect(again.stats).toMatchObject({ diffs: 0, kept: 3 });

  // The page: the board's button opens the review.
  await page.goto(`/s/${coord}`);
  await openPanel(page, "board");
  await page.getByTestId("board-review-tree").click();
  const dlg = page.getByTestId("tree-review");
  await expect(dlg.getByTestId("tree-summary")).toContainText("3 branches to land · 3 areas · 1 overlap (1 would conflict)");
  const area = (key: string) => dlg.locator(`[data-testid="tree-area"][data-area="${key}"]`);
  await expect(area("src/board").getByTestId("tree-area-overlaps")).toHaveText("1 conflict");
  await area("src/board").click();
  // The keys move between areas: j to the next, k back.
  const current = dlg.locator('[data-testid="tree-area"][aria-current="true"]');
  await expect(current).toHaveAttribute("data-area", "src/board");
  await page.keyboard.press("j");
  await expect.soft(current).not.toHaveAttribute("data-area", "src/board");
  await page.keyboard.press("k");
  await expect(current).toHaveAttribute("data-area", "src/board");
  const ov = dlg.getByTestId("tree-overlap");
  await expect(ov).toHaveAttribute("data-conflict", "true");
  await expect(ov.getByTestId("tree-overlap-note")).toContainText("is rebased onto it");
  // Side by side: alpha's hunk and beta's, each naming its agent, verdict and checks.
  const sideA = ov.locator(`[data-testid="tree-hunk"][data-branch="${alpha.branch}"]`), sideB = ov.locator(`[data-testid="tree-hunk"][data-branch="${beta.branch}"]`);
  await expect(sideA.getByTestId("tree-verdict")).toHaveText("approved");
  await expect(sideB.getByTestId("tree-verdict")).toHaveText("no review");
  await expect(sideA).toContainText("rule3 = 30;");
  await expect(sideB).toContainText("rule3 = 300;");
  const a = (await sideA.boundingBox())!, b = (await sideB.boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(b.x).toBeGreaterThan(a.x + a.width - 2);
  await expect(dlg.locator('[data-testid="tree-file"][data-path="ui/src/components/BoardCard.tsx"]')).toContainText("BoardCard");
  await expect(dlg.getByTestId("tree-step")).toHaveCount(2);
  await expect(dlg.getByTestId("tree-area-order")).toContainText(`${alpha.branch.replace(/^keel\//, "")}`);
  await page.mouse.move(0, 0);
  await shoot(page, "tree-review-01-overlap");

  // Send beta back with a note: its agent reads it.
  const note = "Keep rule3 as alpha has it; only change rule4.";
  await dlg.getByTestId("tree-back").click();
  const form = dlg.getByTestId("tree-back-form");
  // To beta alone: alpha's agent is not picked.
  const toBetaOnly = async () => { const a = form.getByRole("button", { name: alpha.title }); if ((await a.getAttribute("aria-pressed")) === "true") await a.click(); await expect(a).toHaveAttribute("aria-pressed", "false"); };
  await toBetaOnly();
  await form.getByTestId("tree-back-note").fill(note);
  await form.getByTestId("tree-back-send").click();
  await expect(dlg.getByTestId("tree-said")).toContainText(`Sent back to ${beta.id}`);
  await expect.poll(async () => JSON.stringify((await (await request.get(`/api/sessions/${beta.session_id}`)).json()).events), { timeout: 30_000 }).toContain(note);
  await expect(dlg.getByTestId("tree-decision")).toHaveAttribute("data-action", "back");
  // Cleared and sent back again with the same note: a new decision, delivered again.
  const notes = async () => ((await (await request.get(`/api/sessions/${beta.session_id}`)).json()).events as any[]).filter((e) => e.kind === "user" && JSON.stringify(e).includes(note)).length;
  await dlg.getByTestId("tree-undo").click();
  await expect(dlg.getByTestId("tree-decision")).toHaveCount(0);
  await dlg.getByTestId("tree-back").click();
  await toBetaOnly();
  await form.getByTestId("tree-back-note").fill(note);
  await form.getByTestId("tree-back-send").click();
  await expect(dlg.getByTestId("tree-said")).toContainText(`Sent back to ${beta.id}`);
  await soft.poll(notes, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await agentsOf()).find((x) => x.id === beta.id)?.status, { timeout: 60_000 }).toBe("completed");
  await expect(dlg.getByTestId("tree-decision")).toHaveAttribute("data-action", "back");
  await expect(dlg.getByTestId("tree-held")).toContainText("held: you sent it back in src/board");
  await expect(dlg.getByTestId("tree-area-order")).toContainText("Lands as one entry");

  // Land src/board: alpha is queued, beta is not (sent back, not moved since); alpha lands.
  await dlg.getByTestId("tree-land").click();
  await expect(dlg.getByTestId("tree-said")).toContainText(`Queued in this order: ${alpha.branch}`);
  await expect(dlg.getByTestId("tree-said")).toContainText(`Not queued: ${beta.branch}: you sent it back in src/board`);
  const entry = async () => ((await (await request.get(`/api/sessions/${coord}/landing`)).json()).entries as any[]).find((e) => e.branch === alpha.branch);
  await expect.poll(async () => (await entry())?.state, { timeout: 90_000 }).toBe("landed");
  expect(((await (await request.get(`/api/sessions/${coord}/landing`)).json()).entries as any[]).some((e) => e.branch === beta.branch)).toBe(false);

  // Drop the top level; landing src/landing is then refused, since gamma also changes it.
  await area(".").click();
  await dlg.getByTestId("tree-drop").click();
  await expect(area(".")).toHaveAttribute("data-decision", "drop");
  await area("src/landing").click();
  await expect(dlg.getByTestId("tree-area-held")).toContainText("is held: it changes top level, which you dropped");
  await expect(dlg.getByTestId("tree-land")).toBeDisabled();
  const refused = await request.post(`/api/sessions/${coord}/tree-review/decide`, { data: { area: "src/landing", action: "land" } });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toContain(`${gamma.branch}: it changes top level, which you dropped`);

  // Read again: alpha landed and is no longer shown.
  await dlg.getByTestId("tree-refresh").click();
  await expect(dlg.getByTestId("tree-summary")).toContainText("2 branches to land");
  await expect(dlg.getByTestId("tree-summary")).toContainText("1 landed, not shown");
  await area("src/board").click();
  await expect(dlg.getByTestId("tree-decision")).toHaveAttribute("data-action", "back");
  // Nothing can land now, and the order says why.
  await expect(dlg.getByTestId("tree-order")).toContainText("No branch can land now.");
  await expect(dlg.getByTestId("tree-held")).toContainText("held: it changes top level, which you dropped");
  await page.mouse.move(0, 0);
  await shoot(page, "tree-review-02-decisions");

  // Beta's agent commits a new change in src/board while the review is up: the view reads it by itself
  // (no Refresh), and the send-back it was made on is marked for review again.
  await expect.poll(async () => (await agentsOf()).find((a) => a.id === beta.id)?.status, { timeout: 60_000 }).toBe("completed");
  await request.post(`/api/sessions/${beta.session_id}/messages`, { data: { text: ask("Only change rule4.", calls([bash(`sed -i 's/rule3 = 300/rule3 = 3/' src/board/rules.ts && ${commit("Only rule4")}`)])) } });
  await soft(dlg.getByTestId("tree-decision")).toHaveAttribute("data-current", "false", { timeout: 30_000 });
  await soft(dlg.getByTestId("tree-decision")).toContainText("review it again");
});

// Many branches stay readable: N agents each change line 3 of the same file (one overlap of N sides) and a
// file of their own in one of four folders. Each side of the overlap keeps a readable width and the sides
// scroll; an area's row shows six lane dots and a count; the lines that name branches name five and say how
// many more; the overlapping file is listed first. Shot at two window sizes.
for (const n of [6, 30]) {
  test(`a tree of ${n} branches reads as one review`, async ({ page, request }) => {
    test.setTimeout(420_000);
    await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
    const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tree-${n}-${Date.now()}`, "repo");
    mkdirSync(join(repo, "src/board"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/board/rules.ts"), Array.from({ length: 10 }, (_, i) => `export const rule${i + 1} = ${i + 1};`).join("\n") + "\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
    const commit = (msg: string) => `git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`;
    const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: `Coordinator of ${n}` } })).json()).session.id as string;
    const lanes = Array.from({ length: n }, (_, i) => {
      const own = `src/part${i % 4}/lane${i}.ts`;
      const extra = i === 0 ? " && printf 'export const a = 1;\\n' > src/board/aaa.ts" : "";
      const cmd = `sed -i 's/rule3 = 3;/rule3 = ${100 + i};/' src/board/rules.ts && mkdir -p src/part${i % 4} && printf 'export const lane${i} = ${i};\\n' > ${own}${extra} && ${commit(`Lane ${i}`)}`;
      return { name: "spawn_agent", input: { message: `Lane ${i}\n${calls([{ name: "Bash", input: { command: cmd } }])}` } };
    });
    await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask(`Start ${n} agents.`, `script:batch ${JSON.stringify(lanes)}`) } });
    const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
    await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 300_000, intervals: [2_000] }).toBe(n);

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`/s/${coord}`);
    await openPanel(page, "board");
    await page.getByTestId("board-review-tree").click();
    const dlg = page.getByTestId("tree-review");
    await expect(dlg.getByTestId("tree-summary")).toContainText(`${n} branches to land · 5 areas · 1 overlap (1 would conflict)`, { timeout: 60_000 });
    const row = dlg.locator('[data-testid="tree-area"][data-area="src/board"]');
    await expect(row).toHaveAttribute("aria-current", "true");
    // Six dots at most, then the count; the row's counts on one line.
    const counts = row.locator(":scope > span").nth(1);
    await soft(counts.locator("span[aria-hidden]")).toHaveCount(Math.min(n, 6));
    if (n > 6) await soft(counts).toContainText(`+${n - 6}`);
    soft((await counts.boundingBox())!.height).toBeLessThan(22);
    // The overlapping file first, though aaa.ts sorts before it.
    await soft(dlg.getByTestId("tree-file").first()).toHaveAttribute("data-path", "src/board/rules.ts");
    // Every side of the overlap at least 20rem wide, the sides in a scroll.
    const ov = dlg.getByTestId("tree-overlap");
    await expect(ov.getByTestId("tree-hunk")).toHaveCount(n);
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    soft(Math.min(...await ov.getByTestId("tree-hunk").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width)))).toBeGreaterThanOrEqual(20 * rem - 1);
    // The row of sides scrolls as one (not each hunk on its own).
    soft(await ov.getByTestId("tree-hunk").first().evaluate((e) => { const box = e.parentElement!.parentElement!; return box.scrollWidth > box.clientWidth + 1; })).toBe(true);
    // A file's header counts six branches, then the rest as one; the overlap's note names five.
    const head = dlg.locator('[data-testid="tree-file"][data-path="src/board/rules.ts"] header');
    await soft(head.getByTestId("tree-file-count")).toHaveCount(Math.min(n, 6));
    soft((await head.boundingBox())!.height).toBeLessThan(40);
    soft((await ov.getByTestId("tree-overlap-note").innerText()).length).toBeLessThan(400);
    // The order shows its first eight steps, so the areas stay in sight.
    await soft(dlg.getByTestId("tree-step")).toHaveCount(Math.min(n, 8));
    soft((await row.boundingBox())!.y).toBeLessThan(1040);
    // Lines that name branches name five, then how many more.
    if (n > 5) {
      await soft(dlg.getByTestId("tree-carries")).toContainText(`${n} of its branches also change other areas`);
      soft((await dlg.getByTestId("tree-carries").innerText()).length).toBeLessThan(200);
      await soft(dlg.getByTestId("tree-area-order")).toContainText(`${n - 5} more, in the order on the left`);
      soft((await dlg.getByTestId("tree-area-order").innerText()).length).toBeLessThan(300);
    }
    await page.mouse.move(0, 0);
    await shoot(page, `tree-review-${n}-1920`);
    await page.setViewportSize({ width: 1366, height: 900 });
    soft((await counts.boundingBox())!.height).toBeLessThan(22);
    await page.mouse.move(0, 0);
    await shoot(page, `tree-review-${n}-1366`);
    await page.setViewportSize({ width: 1920, height: 1040 });
  });
}
