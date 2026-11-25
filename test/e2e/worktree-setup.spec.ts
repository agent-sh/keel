import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot, openPanel } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: a repository names a setup for the worktrees Keel makes (.keel/worktree.json). It commands run, so it is
// held until the owner pins it in the Trust panel; once pinned it runs once in each new worktree, before any model
// step is spent; a changed file is held again; a failing one is named on the session and on the chip.
test("a repository's worktree setup runs once per worktree under the owner's pin", async ({ page, request }) => {
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `setup-${Date.now()}`);
  mkdirSync(join(repo, ".keel"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "# Notes\n");
  const setup = (...commands: string[]) => {
    writeFileSync(join(repo, ".keel", "worktree.json"), JSON.stringify({ setup: commands }));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "setup");
  };
  setup("echo ran >> marker");

  const start = async (title: string) => {
    const r = await request.post("/api/worktrees", { data: { workspace: repo, title } });
    expect(r.status()).toBe(201);
    const { session, worktree } = await r.json();
    const { events } = await (await request.get(`/api/sessions/${session.id}`)).json();
    return { id: session.id as string, wt: worktree, kinds: (events as any[]).map((e) => e.kind) };
  };
  const marker = (path: string) => (existsSync(join(path, "marker")) ? readFileSync(join(path, "marker"), "utf8") : null);

  // Not pinned: held, nothing ran, and the session says so.
  const first = await start("first");
  expect(first.wt.setup.state).toBe("held");
  expect(marker(first.wt.path)).toBeNull();
  expect(first.kinds).toContain("note");

  // The owner reads the file in the Trust panel and pins it.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${first.id}`);
  await page.getByTestId("worktree-chip").waitFor();
  await expect(page.getByTestId("setup-mark")).toHaveAttribute("data-state", "held");
  await openPanel(page, "trust");
  const file = page.getByTestId("worktree-setup-file");
  await expect(file).toHaveAttribute("data-state", "new");
  await expect(file).toContainText("echo ran >> marker");
  await shoot(page, "worktree-setup-01-held");
  await file.getByTestId("trust-worktree-setup").click();
  await expect(file).toHaveAttribute("data-state", "pinned");

  // Two sessions in fresh worktrees: the marker is there once, and no model step was spent on it.
  const [a, b] = [await start("second"), await start("third")];
  for (const s of [a, b]) {
    expect(s.wt.setup).toMatchObject({ state: "ok", steps: 1 });
    expect(marker(s.wt.path)).toBe("ran\n");
    expect(s.kinds.filter((k) => ["assistant", "turn_start", "tool_use", "tool_result"].includes(k))).toEqual([]);
  }
  await page.goto(`/s/${a.id}`);
  await page.getByTestId("worktree-chip").click();
  await expect(page.getByTestId("worktree-setup")).toContainText(/^Setup ran in \d/);
  await shoot(page, "worktree-setup-02-ran");
  await page.keyboard.press("Escape");

  // A changed file is held again, and a worktree made from it runs nothing.
  setup("echo changed >> marker");
  const held = await start("fourth");
  expect(held.wt.setup.state).toBe("held");
  expect(held.wt.setup.note).toContain("changed since you pinned");
  expect(marker(held.wt.path)).toBeNull();

  // A pinned setup that fails is named: on the session, its chip and its note.
  setup("echo installing", "echo no network >&2; exit 4");
  const open = await request.get(`/api/worktree-setup?cwd=${encodeURIComponent(repo)}`);
  expect((await request.post("/api/worktree-setup/trust", { data: { cwd: repo, sha256: (await open.json()).sha256 } })).ok()).toBe(true);
  const bad = await start("fifth");
  expect(bad.wt.setup).toMatchObject({ state: "failed", steps: 1 });
  expect(bad.wt.setup.note).toContain("step 2 (echo no network >&2; exit 4) exited 4");
  expect(readFileSync(bad.wt.setup.log, "utf8")).toContain("no network");
  await page.goto(`/s/${bad.id}`);
  await expect(page.getByTestId("setup-mark")).toHaveAttribute("data-state", "failed");
  await expect(page.getByText("worktree setup failed after").first()).toBeVisible();
  await page.getByTestId("worktree-chip").click();
  await expect(page.getByTestId("worktree-setup")).toContainText("Setup failed after");
  await shoot(page, "worktree-setup-03-failed");

  // The variables a setup writes are taken only when the owner names them in Settings; the floor holds even then.
  setup('echo "APP_MODE=ci" >> "$KEEL_ENV_FILE"', 'echo "LESSOPEN=|x" >> "$KEEL_ENV_FILE"', 'echo "PATH=/x" >> "$KEEL_ENV_FILE"');
  const again = await request.get(`/api/worktree-setup?cwd=${encodeURIComponent(repo)}`);
  expect((await request.post("/api/worktree-setup/trust", { data: { cwd: repo, sha256: (await again.json()).sha256 } })).ok()).toBe(true);
  const none = await start("sixth");
  expect(none.wt.setup.env).toBeUndefined();
  expect(none.wt.setup.note).toContain("not taken from $KEEL_ENV_FILE: APP_MODE, LESSOPEN");
  await page.goto("/settings/safety");
  const names = page.getByTestId("worktree-setup-env");
  await expect(names).toHaveValue("");
  await names.fill("APP_*, PATH");
  await names.blur();
  await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.worktree_setup.env).toEqual(["APP_*", "PATH"]);
  await shoot(page, "worktree-setup-04-variables");
  try {
    const some = await start("seventh");
    expect(some.wt.setup.note).toContain("sets APP_MODE");
    expect(some.wt.setup.note).toContain("not taken from $KEEL_ENV_FILE: LESSOPEN");
    expect(some.wt.setup.note).toContain("left out of $KEEL_ENV_FILE: PATH");
  } finally {
    await request.patch("/api/settings", { data: { worktree_setup: { env: null } } });
  }
});
