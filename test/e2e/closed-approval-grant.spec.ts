import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { folder } from "./answering.ts";
import { ask, endsAre, HAIKU, openPanel, scriptBash, shoot, WORKBENCH } from "./shots.ts";

test.use({ storageState: WORKBENCH, viewport: { width: 1920, height: 1040 } });

test("the closed approval can revoke only the grant it created", async ({ page, request }) => {
  const workspace = folder("closed-approval-grant");
  const { session } = await (await request.post("/api/sessions", { data: { workspace, model: HAIKU } })).json();
  const base = `/api/sessions/${session.id}`;
  const grants = async () => ((await (await request.get("/api/permissions/grants")).json()).grants as { id: string; scope: string; pattern: string }[]).filter((g) => g.scope === workspace);
  await request.put(`${base}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  try {
    const submit = (file: string) => request.post(`${base}/messages`, { data: { text: ask(`Run exactly touch ${file} in Bash, then stop.`, scriptBash(`touch ${file}`)) } });
    await submit("once.txt");
    await page.getByTestId("approval").getByTestId("allow-once").click();
    await endsAre(page, 1);
    await submit("first.txt");
    await page.getByTestId("approval").getByTestId("allow-always").click();
    await page.getByTestId("grant-always").click();
    await endsAre(page, 2);
    const [original] = await grants();
    expect(original).toBeDefined();

    await openPanel(page, "timeline");
    const rows = page.getByTestId("timeline-row");
    const once = rows.filter({ hasText: "Approval for Bash allowed once" });
    await once.locator("button[data-row]").click();
    await expect(once.getByTestId("revoke-approval-grant")).toHaveCount(0);
    const closed = rows.filter({ hasText: "Approval for Bash allowed from now on" });
    await closed.locator("button[data-row]").click();
    const revoke = closed.getByTestId("revoke-approval-grant");
    await expect(revoke).toBeVisible();
    await shoot(page, "closed-approval-grant");
    await revoke.click();
    await expect(revoke).toHaveCount(0);
    expect(await grants()).toEqual([]);
    expect(existsSync(join(workspace, "first.txt"))).toBe(true);

    await submit("after.txt");
    await expect(page.getByTestId("approval")).toBeVisible();
    const replacement = await request.post("/api/permissions/grants", { data: { session_id: session.id, kind: "shell", pattern: original!.pattern } });
    expect(replacement.ok()).toBe(true);
    const { grant } = await replacement.json();
    expect(grant.id).not.toBe(original!.id);
    await page.reload();
    await openPanel(page, "timeline");
    const detail = closed.getByTestId("timeline-detail");
    if (!(await detail.isVisible())) await closed.locator("button[data-row]").click();
    await expect(detail).toBeVisible();
    await expect(revoke).toHaveCount(0);
    expect((await grants()).map((g) => g.id)).toEqual([grant.id]);
  } finally {
    for (const { id } of await grants()) await request.delete(`/api/permissions/grants/${id}`);
  }
});
