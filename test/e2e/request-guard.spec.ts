import { expect, test } from "./isolate.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HAIKU, shoot, ask, pickModel } from "./shots.ts";

// The browser resolves rebind.test to 127.0.0.1, the way a DNS-rebinding page
// reaches the daemon under its own name.
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP rebind.test 127.0.0.1"] } });

// Feature: the request guard. A page on another origin cannot create a
// session with a simple fetch POST or a form POST, and cannot open the live
// socket; a page under a foreign Host name (DNS rebinding) is refused; the
// daemon's own UI still creates a session and streams its turn.
test("foreign pages cannot drive the daemon", async ({ page, request, baseURL }) => {
  const target = new URL(baseURL!).origin;
  const tag = `guard-${Date.now().toString(36)}`;
  const fx = spawn("bun", [join(import.meta.dirname, "fixtures/foreign-page.ts")], { stdio: ["ignore", "pipe", "inherit"] });
  const mine = async () => ((await (await request.get("/api/sessions")).json()).sessions as any[]).filter((s) => String(s.title ?? "").startsWith(tag));
  try {
    const port = await new Promise<string>((res) => createInterface({ input: fx.stdout! }).once("line", res));
    await page.goto(`http://127.0.0.1:${port}/?target=${encodeURIComponent(target)}&tag=${tag}`);
    await expect.poll(() => page.evaluate(() => Object.keys((window as any).results).length), { timeout: 15_000 }).toBe(3);
    const results = await page.evaluate(() => (window as any).results);
    expect(results.ws).toBe("refused");
    await shoot(page, "request-guard-01-foreign-page");
    // The requests left the browser; the daemon refused them, so nothing exists.
    expect(await mine()).toEqual([]);

    // DNS rebinding: the daemon's own port under a name that is not its own.
    const rebound = await page.goto(target.replace("127.0.0.1", "rebind.test").replace("localhost", "rebind.test") + "/api/sessions");
    expect(rebound!.status()).toBe(403);
    expect(await rebound!.text()).toContain("not this daemon's");

    // The daemon's own UI: a same-origin POST creates the session and the socket streams the turn.
    await page.goto("/");
    await pickModel(page);
    await page.getByTestId("composer").fill(ask(`Reply with the single word ${tag}.`, `script:say ${tag}`));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\//);
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText(tag);
    await shoot(page, "request-guard-02-own-ui");
    const id = new URL(page.url()).pathname.split("/").pop()!;
    await request.delete(`/api/sessions/${id}`);
  } finally {
    for (const s of await mine()) await request.delete(`/api/sessions/${s.id}`);
    fx.kill();
  }
});
