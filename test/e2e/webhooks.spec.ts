import { expect, test } from "./isolate.ts";
import { createHmac } from "node:crypto";
import { shoot } from "./shots.ts";

const sign = (secret: string, id: string, ts: number, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

// Feature: a webhook loop that takes only signed requests. The URL and the
// signing secret are shown once; an unsigned, stale or replayed request does not
// run, a valid one does; a new key and secret end the old ones.
test("webhooks: signed loop, key shown once, replay window, rotation", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await page.goto("/");
  await page.getByTestId("loops-button").click();
  await page.getByTestId("new-loop-button").click();
  await page.getByTestId("new-loop-schedule").fill("webhook");
  await expect(page.getByTestId("new-loop-signed")).toBeChecked();
  await page.getByTestId("new-loop-prompt").fill("Reply with only the word ok.");
  await page.getByRole("button", { name: "Create loop" }).click();
  await expect(page.getByTestId("webhook-secret")).toContainText("whsec_");
  await shoot(page, "webhooks-01-shown-once");

  const url = (await page.getByTestId("webhook-url").textContent())!;
  const secret = (await page.getByTestId("webhook-secret").textContent())!;
  const path = new URL(url).pathname;
  const { loops } = await (await request.get("/api/loops")).json();
  const loop = loops.find((l: any) => l.kind === "webhook");
  // The key and the secret never leave the store again.
  expect(JSON.stringify(loops)).not.toContain(secret);
  expect(JSON.stringify(loops)).not.toContain(path.split("/").at(-1));

  const body = JSON.stringify({ event: "push" });
  const now = Math.floor(Date.now() / 1000);
  const unsigned = await request.post(path, { data: body });
  expect(unsigned.status()).toBe(401);
  expect((await unsigned.json()).error).toContain("not signed");
  const stale = await request.post(path, { data: body, headers: { "webhook-id": "m0", "webhook-timestamp": String(now - 600), "webhook-signature": sign(secret, "m0", now - 600, body) } });
  expect(stale.status()).toBe(401);

  const good = { "webhook-id": "m1", "webhook-timestamp": String(now), "webhook-signature": sign(secret, "m1", now, body), "content-type": "application/json" };
  expect((await request.post(path, { data: body, headers: good })).status()).toBe(200);
  // The same delivery again is taken once.
  expect((await request.post(path, { data: body, headers: good })).status()).toBe(200);

  await page.getByTestId("loop-item").filter({ hasText: "Reply with only the word ok" }).click();
  const runs = page.getByTestId("loop-run");
  await expect(runs.filter({ hasNotText: "not run" })).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("loop-history")).toContainText("already taken was sent again");
  await expect(page.getByTestId("loop-history")).toContainText("more than five minutes off");
  await expect(page.getByTestId("webhook-mode")).toContainText("Signed requests only");
  await expect(runs.filter({ hasNotText: "not run" }).first()).not.toContainText("running", { timeout: 60_000 });
  await shoot(page, "webhooks-02-history");

  // A new key and secret: the old URL no longer reaches the loop.
  await page.getByTestId("rotate-key").click();
  await expect(page.getByTestId("webhook-secret")).toContainText("whsec_");
  const secret2 = (await page.getByTestId("webhook-secret").textContent())!;
  expect(secret2).not.toBe(secret);
  const old = await request.post(path, { data: body, headers: { ...good, "webhook-id": "m2", "webhook-signature": sign(secret, "m2", now, body) } });
  expect(old.status()).toBe(200); // the answer never says whether a key exists
  const after = (await (await request.get(`/api/loops/${loop.id}/runs`)).json()).runs;
  expect(after.some((r: any) => r.skip_reason?.includes("m2"))).toBe(false);
  expect(after.length).toBe(4); // one run, then unsigned, stale and replayed requests not run
  await shoot(page, "webhooks-03-rotated");

  await request.delete(`/api/loops/${loop.id}`);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
