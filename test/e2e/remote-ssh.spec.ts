import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openPanel, shoot } from "./shots.ts";

// Feature: ssh machines and remote sessions. A host of the ssh configuration
// (KEEL_SSH_E2E_HOST) with its aliases as routes, reached and enabled with no
// install by hand; a session in a folder there (KEEL_SSH_E2E_ROOT, a scratch
// directory the spec fills and empties) whose shell and file edits run there,
// its terminal pane over the same connection, and a session here moved there
// with its uncommitted change and back. The daemon under test is
// started with KEEL_REMOTE_DIR inside that scratch directory, so the helper it
// puts there goes with it.
const HOST = process.env.KEEL_SSH_E2E_HOST ?? "";
const ROOT = process.env.KEEL_SSH_E2E_ROOT ?? "";
test.skip(!HOST || !ROOT, "needs KEEL_SSH_E2E_HOST and KEEL_SSH_E2E_ROOT");
test.setTimeout(420_000);

const LOCAL = `${process.env.HOME}/.cache/keel-work/bun/remote-move-${Date.now().toString(36)}`;
const there = (cmd: string) => execFileSync("ssh", ["-o", "BatchMode=yes", HOST, cmd], { encoding: "utf8" });

test("ssh machine: one per box, enabled, a remote session's tools and terminal run there", async ({ page, request }) => {
  await page.setViewportSize({ width: 1700, height: 980 });
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const proj = `${ROOT}/proj`;
  there(`rm -rf ${proj} && mkdir -p ${proj} && cd ${proj} && git init -q && printf 'hello\\n' > notes.txt`);
  let sid = "";
  let mid = "";
  let moved = "";
  try {
    // One entry per box: the aliases of the host are its routes.
    await page.goto("/settings/machines");
    const host = page.locator(`[data-testid="ssh-host"][data-host="${HOST}"]`);
    await expect(host).toBeVisible();
    await host.getByTestId("ssh-reach").click();
    await expect(host.getByTestId("ssh-facts")).toContainText("cores", { timeout: 30_000 });
    await shoot(page, "remote-01-ssh-hosts");

    // Enabled with one switch: nothing to install, nothing to type.
    await host.getByTestId("machine-toggle").click();
    const row = page.locator('[data-testid="machine-row"]').filter({ hasText: HOST });
    await expect(row.getByTestId("machine-link")).toContainText(`over ssh via`, { timeout: 30_000 });
    await expect(row.getByTestId("machine-state")).toContainText(/ready|busy/);
    mid = (await row.getAttribute("data-machine"))!;
    // The scratch directory is the grant for this run.
    await row.getByRole("button", { name: "Edit" }).click();
    await row.getByLabel("Granted directory").fill(ROOT);
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText(ROOT);
    await shoot(page, "remote-02-enabled");

    // A new session there, in a folder picked by browsing that machine.
    await page.goto("/");
    await page.getByTestId("machine-picker").click();
    await page.locator(`[data-testid="machine-option"][data-machine="${mid}"]`).click();
    await page.getByTestId("remote-folder-picker").click();
    const popup = page.getByTestId("remote-folder-popup");
    // With no session there yet it opens on the folders; with some, on the recent ones.
    if (await popup.getByTestId("remote-browse").isVisible()) await popup.getByTestId("remote-browse").click();
    await popup.getByTestId("remote-dir").filter({ hasText: "proj" }).click();
    await expect(popup).toContainText("/proj");
    await shoot(page, "remote-03-folder");
    await popup.getByTestId("remote-use-folder").click();
    await expect(page.getByTestId("remote-folder-picker")).toContainText("proj");
    await page.getByTestId("model-picker").click();
    await page.getByPlaceholder("Search models").fill("haiku 5.5");
    await page.getByRole("option").first().click();
    await page.getByTestId("composer").fill("Two tool calls, in order. 1) Bash: uname -s && hostname && pwd. 2) Edit notes.txt: replace hello with hello from keel. Then reply with the word done.");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/s\//);
    sid = page.url().split("/s/")[1]!.split(/[/?#]/)[0]!;
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 180_000 });
    const bash = page.locator('[data-tool="Bash"]').first();
    await expect(bash.getByTestId("tool-machine")).toHaveText(HOST);
    await bash.click();
    await expect(bash).toContainText("Linux");
    await expect(bash).toContainText(proj);
    expect(there(`cat ${proj}/notes.txt`)).toContain("hello from keel");
    await expect(page.getByTestId("machine-chip")).toContainText(HOST);
    await expect(page.locator(`section.k-group[data-machine="${mid}"]`).getByTestId("group-machine")).toHaveText(HOST);
    await shoot(page, "remote-04-session");

    // The terminal pane: the session's commands there, and one of the owner's.
    await openPanel(page, "terminal");
    const term = page.getByTestId("terminal-panel");
    await expect(term.getByTestId("term-machine").first()).toContainText(HOST);
    await term.getByTestId("term-input").fill("cat notes.txt && uname -n");
    await term.getByTestId("term-run").click();
    const mine = term.locator('[data-testid="term-entry"]').filter({ has: page.getByTestId("term-by-owner") }).last();
    await expect(mine).toHaveAttribute("data-state", "ok", { timeout: 60_000 });
    if (!(await mine.getByTestId("term-output").isVisible())) await mine.getByTestId("term-toggle").click();
    await expect(mine.getByTestId("term-output")).toContainText("hello from keel");
    await shoot(page, "remote-05-terminal");

    // A session here moves there with its uncommitted change, and comes back.
    const git = (...a: string[]) => execFileSync("git", ["-C", LOCAL, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    mkdirSync(LOCAL, { recursive: true });
    git("init", "-q");
    writeFileSync(`${LOCAL}/a.txt`, "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "init");
    writeFileSync(`${LOCAL}/a.txt`, "one\ntwo\n");
    const mv = (await (await request.post("/api/sessions", { data: { workspace: LOCAL, title: "Moves to the ssh machine" } })).json()).session;
    moved = mv.id;
    await page.goto(`/s/${mv.id}`);
    await page.getByTestId("machine-chip").click();
    await page.locator(`[data-testid="move-to"][data-machine="${mid}"]`).click();
    await expect(page.getByTestId("move-progress")).toHaveAttribute("data-state", "done", { timeout: 120_000 });
    await shoot(page, "remote-06-moved");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("machine-chip")).toContainText(HOST);
    const ws = (await (await request.get(`/api/sessions/${mv.id}`)).json()).session.workspace;
    expect(there(`cat ${ws}/a.txt`)).toBe("one\ntwo\n");
    there(`echo three >> ${ws}/a.txt`);
    await page.getByTestId("machine-chip").click();
    await page.locator('[data-testid="move-to"][data-machine="local"]').click();
    await expect.poll(() => readFileSync(`${LOCAL}/a.txt`, "utf8"), { timeout: 120_000 }).toBe("one\ntwo\nthree\n");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("machine-chip")).not.toContainText(HOST);

    // Switched off once no session uses it: back among the hosts, its helper ended.
    for (const id of [moved, sid]) await request.delete(`/api/sessions/${id}`);
    moved = sid = "";
    await page.goto("/settings/machines");
    await page.locator('[data-testid="machine-row"]').filter({ hasText: HOST }).getByTestId("machine-toggle").click();
    await expect(page.locator(`[data-testid="ssh-host"][data-host="${HOST}"]`)).toBeVisible({ timeout: 30_000 });
    mid = "";
    const alive = `for f in ${ROOT}/*/run-*/hands.pid $HOME/.cache/keel-remote/run-*/hands.pid; do [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && echo alive; done; true`;
    await expect.poll(() => there(alive), { timeout: 15_000 }).toBe("");
  } finally {
    if (moved) await request.delete(`/api/sessions/${moved}`);
    rmSync(LOCAL, { recursive: true, force: true });
    if (sid) await request.delete(`/api/sessions/${sid}`);
    if (mid) await request.delete(`/api/fleet/machines/${mid}`);
    await request.put("/api/permissions/settings", { data: { default_mode: prev } });
    there(`rm -rf ${proj}`);
  }
});
