import type { APIRequestContext, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const SHOTS = process.env.KEEL_SHOTS ?? `${process.env.HOME}/.cache/keel-work/bun/shots`;
mkdirSync(SHOTS, { recursive: true });

// A screenshot of the current page in light and dark.
export async function shoot(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => {
      document.documentElement.classList.add("theme-switch");
      document.documentElement.classList.toggle("dark", t === "dark");
    }, theme);
    await page.waitForTimeout(60);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
  }
  await page.evaluate(() => document.documentElement.classList.remove("theme-switch"));
}

export const HAIKU = process.env.KEEL_TEST_MODEL ?? "bedrock:global.anthropic.claude-haiku-5-5";

// Opens a side panel of the session on screen: from the header when it is at
// hand, else from the Panels picker. Nothing happens when it is already open.
export async function openPanel(page: Page, id: string) {
  await page.getByTestId("panel-menu").waitFor();
  const side = page.getByTestId("side-panel");
  if ((await side.count()) && (await side.getAttribute("data-panel")) === id) return;
  const hand = page.getByTestId(`panel-toggle-${id}`);
  if (await hand.isVisible()) return hand.click();
  await page.getByTestId("panel-menu").click();
  await page.getByTestId(`panel-pick-${id}`).click();
}

// Headers of a remote device: a proxy's forwarding header and the daemon's
// access token (read at the desk), so the request reaches the route as remote.
export async function remoteHeaders(request: APIRequestContext, base = ""): Promise<Record<string, string>> {
  const { path } = await (await request.get(`${base}/api/remote-access`)).json();
  return { "x-forwarded-for": "10.0.0.2", authorization: `Bearer ${new URL(path, "http://x").searchParams.get("token")}` };
}
