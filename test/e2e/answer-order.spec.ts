import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: answers that come late, twice or not at all. Two places in the
// workbench asked the daemon without minding when the answer came: the phone
// pairing code (every click made a new code) and the folder browser of an ssh
// machine (an old answer replaced a newer one, also after the popup closed).
// The requests are held or failed in the browser; the daemon is the real one.

test("clicking for a pairing code again while one is on its way asks once", async ({ page }) => {
  let asked = 0;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/mobile/pair", async (route) => {
    asked++;
    if (asked === 1) await held; // the first answer is slow
    if (asked === 3) return route.fulfill({ status: 500, json: { error: "the daemon is busy" } });
    await route.continue();
  });
  await page.goto("/settings/phone");
  const show = page.getByTestId("pair-show");
  await page.getByTestId("pair-url").fill("https://keel.example.test");
  await show.click();
  await expect(show).toBeDisabled();
  await shoot(page, "answer-order-01-pair-asking");
  // More clicks while it is on its way: by the pointer, and by a script that does not wait for the page.
  await show.click({ force: true });
  await show.evaluate((b: HTMLButtonElement) => { b.disabled = false; b.click(); b.click(); });
  release();
  await expect(page.getByTestId("pair-qr").locator("svg")).toBeVisible();
  expect(asked).toBe(1);
  // Asking again on purpose makes a new code.
  const first = await page.getByTestId("pair-bundle").getAttribute("data-link");
  await expect(show).toBeEnabled();
  await expect(show).toHaveText(/New code/);
  await show.click();
  await expect.poll(() => page.getByTestId("pair-bundle").getAttribute("data-link")).not.toBe(first);
  expect(asked).toBe(2);
  // A refused request says so and leaves the button usable.
  await show.click();
  await expect(page.getByText("the daemon is busy")).toBeVisible();
  await expect(show).toBeEnabled();
  expect(asked).toBe(3);
});

test("a late folder listing never replaces the newest one, nor a popup opened again", async ({ page }) => {
  // An ssh machine that exists only in this page, with its folders answered here.
  const fake = { id: "ssh:answer-order", name: "devbox", source: "ssh", transport: "ssh", enabled: true, state: "ready", ssh_host: "devbox", workspace_root: "/srv/work", facts: { home: "/srv" } };
  await page.route("**/api/fleet/machines", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, machines: [...real.machines, fake] } });
  });
  const listing = (path: string) => ({
    path, parent: path === "/srv/work" ? null : path.slice(0, path.lastIndexOf("/")), root: "/srv/work", is_git: false,
    dirs: ["alpha", "beta"].map((name) => ({ name, path: `${path}/${name}`, is_git: false })),
  });
  // Each listing but the root's waits until the test lets it go.
  const waiting = new Map<string, () => void>();
  await page.route("**/api/fleet/machines/*/dirs**", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "/srv/work";
    if (path !== "/srv/work") await new Promise<void>((r) => waiting.set(path, r));
    await route.fulfill({ json: listing(path) });
  });
  const letGo = async (path: string) => { await expect.poll(() => waiting.has(path)).toBe(true); waiting.get(path)!(); };

  await page.goto("/");
  await page.getByTestId("machine-picker").click();
  await page.locator('[data-testid="machine-option"][data-machine="ssh:answer-order"]').click();
  await page.getByTestId("remote-folder-picker").click();
  const popup = page.getByTestId("remote-folder-popup");
  const dir = (name: string) => popup.getByTestId("remote-dir").filter({ hasText: name });
  await expect(dir("alpha")).toBeVisible();
  // Two folders asked for, the second answered first.
  await dir("alpha").click();
  await dir("beta").click();
  await letGo("/srv/work/beta");
  await expect(popup).toContainText("~/work/beta");
  await letGo("/srv/work/alpha");
  await page.waitForTimeout(300);
  await expect(popup).toContainText("~/work/beta");
  await expect(popup).not.toContainText("~/work/alpha");
  await shoot(page, "answer-order-02-newest-folder");

  // A folder asked for, then the popup closed and opened again before the answer.
  await dir("alpha").click();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await page.getByTestId("remote-folder-picker").click();
  await expect(dir("alpha")).toBeVisible();
  await letGo("/srv/work/beta/alpha");
  await page.waitForTimeout(300);
  await expect(popup).not.toContainText("beta/alpha");
  await expect(popup).toContainText("~/work");
});
