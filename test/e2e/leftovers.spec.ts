import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const has = (cmd: string) => { try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } };
// A port nothing listens on now: the kernel picks it, and it is let go at once.
const freePort = () => new Promise<number>((ok, no) => { const s = createServer(); s.once("error", no); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const answers = (port: number) => new Promise<boolean>((ok) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });

// Feature: what an agent leaves behind. An agent starts a server on a port, a background sleep, a worktree
// with one commit and a branch with none of its own, then ends its turn. It waits on its running commands
// (their end would start its next turn), so the owner stops it. At its end the server and the sleep are
// stopped and the port is free. Keel did not make the worktree or the branch (the agent's commands did), so both
// stay, named in its report with what is in them, and are listed on Settings > Leftovers as found by the agent.
// Remove says the ignored path goes too, takes the folder away and leaves its branch listed with the commit;
// Remove all deletes the branch that loses nothing and leaves the one with the commit.
test("an agent's processes stop when it ends; what its commands made is listed, and the owner removes it", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  test.skip(!has("python3"), "needs python3: the agent's server is python3 -m http.server");
  const stamp = Date.now();
  const base = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  const repo = join(base, `left-${stamp}`), wtName = `left-${stamp}-wt`, wt = join(base, wtName), branch = `left-work-${stamp}`, merged = `left-merged-${stamp}`;
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "notes\n");
  writeFileSync(join(repo, ".gitignore"), "out/\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const port = await freePort();
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: repo, title: "Leftovers" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const child = [
    { name: "Bash", input: { command: `python3 -m http.server ${port} --bind 127.0.0.1`, run_in_background: true } },
    { name: "Bash", input: { command: "sleep 300", run_in_background: true } },
    { name: "Bash", input: { command: `git branch ${merged} && git worktree add -q ../${wtName} -b ${branch} && cd ../${wtName} && echo made > made.txt && git add made.txt && git -c user.name=k -c user.email=k@k commit -qm 'One commit' && mkdir out && echo a,b > out/results.csv` } },
    { name: "Bash", input: { command: `for i in $(seq 100); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && break; sleep 0.1; done; echo up` } },
  ];
  const calls = [{ name: "spawn_agent", input: { message: `Leftover maker\nscript:calls ${JSON.stringify(child)}`, isolation: "none" } }];
  try {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    const agent = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents[0];
    await expect.poll(async () => (await agent())?.status, { timeout: 60_000 }).toBe("waiting");
    expect((await request.post(`/api/sessions/${session.id}/agents/${(await agent()).id}/stop`)).ok()).toBe(true);
    await expect.poll(async () => (await agent())?.status, { timeout: 60_000 }).toBe("stopped");
    const a = await agent();
    // The report's one line: both commands stopped (the server by its port); the worktree and the branch listed
    // with what is in them, not removed.
    const line = String(a.result).split("\n").find((l: string) => l.startsWith("Left behind:"));
    expect(line).toContain(`stopped \`python3 -m http.server ${port} --bind 127.0.0.1\` on port ${port}, \`sleep 300\``);
    expect(line).toContain(`not removed (who made them is not known; Settings, Leftovers removes them): worktree ${wt} (branch ${branch}: 1 commit on no other branch, 1 ignored path (out/)), branch ${merged} in ${repo} (every commit on another branch)`);
    expect(await answers(port)).toBe(false);
    const jobs = (await (await request.get(`/api/sessions/${a.session_id}/jobs`)).json()).jobs as any[];
    const bg = jobs.filter((j) => j.background);
    expect(bg).toHaveLength(2);
    for (const j of bg) { expect(j.running).toBe(false); expect(j.stop_reason).toBe("was stopped: its agent ended"); }
    expect(git(repo, "worktree", "list")).toContain(wt);

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/settings/leftovers");
    const row = page.locator(`[data-testid="leftover-worktree"][data-path="${wt}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("leftover-worktree-holds")).toHaveText("0 uncommitted, 1 ignored, 1 commit not on main");
    await expect(row).toContainText(branch);
    await expect(row.getByTestId("leftover-by")).toHaveAttribute("data-how", "found");
    await expect(row.getByTestId("leftover-by")).toContainText("found by");
    await expect(row).toContainText("Leftover maker");
    await expect(page.locator(`[data-testid="leftover-process"]`).filter({ hasText: `http.server ${port}` })).toHaveCount(0);
    // The one act for the whole list says what goes, the ignored path included.
    await expect(page.getByTestId("leftovers-remove-all")).toContainText("1 ignored path with them");
    // A row's buttons say which row they act on: a screen reader's list of buttons reads Remove ten times otherwise.
    await expect(row.getByTestId("leftover-remove")).toHaveAccessibleName(`Remove worktree ${wt}`);
    await expect(page.locator(`[data-testid="leftover-branch"][data-name="${merged}"]`).getByTestId("leftover-delete")).toHaveAccessibleName(`Delete branch ${merged}`);
    await shoot(page, "leftovers-01-page");

    // Remove asks first; the folder goes, its branch stays with the commit and cannot be deleted.
    await row.getByTestId("leftover-remove").click();
    await expect(page.getByRole("alertdialog")).toContainText("Branch " + branch + " and its commits stay.");
    await expect(page.getByRole("alertdialog")).toContainText("1 ignored path goes with it: out/.");
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("leftovers-said")).toHaveText("Removed.");
    await expect(row).toHaveCount(0);
    const b = page.locator(`[data-testid="leftover-branch"][data-name="${branch}"]`);
    await expect(b).toContainText("1 commit not on main");
    await expect(b.getByTestId("leftover-delete")).toBeDisabled();
    expect(git(repo, "worktree", "list")).not.toContain(wt);
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    // Two branches found by one agent: the group says so once, its rows do not repeat it.
    await expect(page.locator('[data-testid="leftover-branch"] [data-testid="leftover-by"]')).toHaveCount(0);
    await expect(page.getByTestId("leftover-by")).toHaveCount(1);
    await expect(page.getByTestId("leftover-by")).toContainText("Leftover maker");
    await shoot(page, "leftovers-02-removed");

    // Remove all: the branch with nothing of its own goes, the one with the commit stays.
    const m = page.locator(`[data-testid="leftover-branch"][data-name="${merged}"]`);
    await expect(m).toContainText("all on main");
    await page.getByTestId("leftovers-remove-all").click();
    await expect(page.getByRole("alertdialog")).toContainText("whose commits are all on the base");
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove all" }).click();
    await expect(page.getByTestId("leftovers-said")).toContainText("deleted");
    await expect(m).toHaveCount(0);
    await expect(b).toContainText("1 commit not on main");
    expect(git(repo, "branch", "--list", merged)).toBe("");
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
  } finally {
    await request.post(`/api/sessions/${session.id}/interrupt`, { data: { by: "owner" } });
    await request.delete(`/api/sessions/${session.id}`);
    try { git(repo, "worktree", "remove", "--force", wt); } catch {}
    rmSync(repo, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

// Feature: what a command leaves running in its job scope after its call ended. A session's command leaves a
// process in its scope and ends. Settings > Leftovers lists the command with the memory its scope holds and
// what becomes of it (kept: its session lives); Keep holds it, and the mark stays over a reload. Settings >
// Resources counts what is left running. (A session cannot be archived with such a command: archiving stops
// it. That the next daemon takes a scope back after a restart and stops it once its session ended and it
// idled is src/automation/scopes.test.ts, which kills a daemon; the decision is leftover-rules.test.ts.)
test("a command's scope left running is listed with its memory and fate, and Keep holds it", async ({ page, request }) => {
  const STAND_IN = "scripted:stand-in";
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = String(1e9 + Math.floor(Math.random() * 8e9));
  // The process the command leaves, by the words only it carries (the spec runs on the daemon's machine).
  const left = () => readdirSync("/proc").filter((n) => { try { return /^\d+$/.test(n) && readFileSync(`/proc/${n}/cmdline`, "utf8").startsWith(`sleep\u0000600.${tag}`); } catch { return false; } }).map(Number);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Left in its scope" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  try {
    const calls = [{ name: "Bash", input: { command: `setsid sleep 600.${tag} > /dev/null 2>&1 < /dev/null & echo left` } }];
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
    const job = async () => ((await (await request.get(`/api/sessions/${session.id}/jobs`)).json()).jobs as any[]).find((j) => j.command.includes(tag));
    await expect.poll(async () => (await job())?.running, { timeout: 60_000 }).toBe(false);
    const j = await job();
    test.skip(j.contain !== "cgroup", `needs systemd user scopes: the daemon holds its commands by ${j.contain} (${j.contain_why})`);

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto("/settings/leftovers");
    const row = page.locator(`[data-testid="leftover-process"][data-job="${j.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("leftover-fate")).toHaveText("Kept: its session lives.");
    await expect(row.getByTestId("leftover-memory")).toHaveText(/^\d+ MB$/);
    await expect(row).toContainText("command ended");
    await expect(page.getByText(/One with a terminal in it \(tmux, script, an editor\) or a process put in it from outside is kept until you stop it\./)).toBeVisible();
    await expect(row.getByTestId("leftover-keep")).toHaveAccessibleName(/^Keep .+/);
    await expect(row.getByTestId("leftover-stop")).toHaveAccessibleName(/^Stop .+/);
    await shoot(page, "leftovers-03-scope");

    await row.getByTestId("leftover-keep").click();
    await expect(row.getByTestId("leftover-keep")).toHaveAttribute("aria-pressed", "true");
    await expect(row.getByTestId("leftover-fate")).toHaveText(/^Kept: you keep it\./);
    await page.reload();
    await expect(row.getByTestId("leftover-keep")).toHaveAttribute("aria-pressed", "true");
    await shoot(page, "leftovers-04-kept");

    await page.goto("/settings/resources");
    await expect(page.getByTestId("tile-left")).toContainText(/\d+(\.\d)? (KB|MB|GB)/);
    await expect(page.getByTestId("tile-left-open")).toContainText(/\d+ commands?/);
    await shoot(page, "leftovers-05-resources");
    expect(left().length).toBe(1);

    // Stopped from the page, the mark goes with it.
    expect((await request.post("/api/leftovers/stop", { data: { session_id: session.id, job_id: j.id } })).ok()).toBe(true);
    await expect.poll(() => left().length, { timeout: 10_000 }).toBe(0);
  } finally {
    for (const pid of left()) try { process.kill(pid, "SIGKILL"); } catch {}
    await request.delete(`/api/sessions/${session.id}`);
  }
});
