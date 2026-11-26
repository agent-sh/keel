import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { calls, folder } from "./answering.ts";
import { ask, endsAre, HAIKU, openFolds, shoot, WORKBENCH } from "./shots.ts";

test.use({ storageState: WORKBENCH, viewport: { width: 1920, height: 1040 } });

test("only a successful edit to a loaded instruction file is marked on the tool line", async ({ page, request }) => {
  const workspace = folder("instruction-edit-line");
  const active = join(workspace, "AGENTS.md");
  const unused = join(workspace, "reference", "CLAUDE.md");
  const nested = join(workspace, "package", "AGENTS.md");
  const note = join(workspace, "package", "note.txt");
  mkdirSync(join(workspace, "reference"));
  mkdirSync(join(workspace, "package"));
  for (const path of [active, unused]) writeFileSync(path, "# Local notes\n\nUse green labels.\n");
  writeFileSync(nested, "# Package notes\n\nUse green labels.\n");
  writeFileSync(note, "A note without instructions.\n");
  try {
    const { session } = await (await request.post("/api/sessions", { data: { workspace, model: HAIKU } })).json();
    const base = `/api/sessions/${session.id}`;
    await request.put(`${base}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await page.goto(`/s/${session.id}`);
    const edit = (file_path: string, old_string: string) => ({ name: "Edit", input: { file_path, old_string, new_string: "Use blue labels." } });
    await request.post(`${base}/messages`, { data: { text: ask("Edit AGENTS.md and reference/CLAUDE.md: replace 'Use green labels.' with 'Use blue labels.'.", calls([edit(unused, "Use green labels."), edit(active, "Use green labels."), edit(active, "This text is absent.")])) } });
    await endsAre(page, 1);
    await openFolds(page);
    const group = page.getByTestId("work-step").filter({ has: page.getByTestId("step-instruction-edit") });
    if (await group.count()) await group.locator("button[data-step]").click();
    const changed = page.getByTestId("tool-instruction-edit");
    await expect(changed).toHaveCount(1);
    await expect(changed).toHaveText("instruction file");
    const call = page.getByTestId("tool-call").filter({ has: changed });
    await expect(call).toHaveAttribute("data-state", "ok");
    await expect(call).toContainText("AGENTS.md");
    await call.locator("button.k-line").click();
    await expect(call.getByTestId("tool-instruction-detail")).toContainText("Session folder");
    await expect(call.getByTestId("tool-instruction-detail")).toContainText("line 3");
    await expect(call.getByTestId("tool-instruction-detail")).toContainText("Written to disk");
    await shoot(page, "instruction-edit-line");

    await request.post(`${base}/messages`, { data: { text: ask("Read package/note.txt, then replace 'Use green labels.' with 'Use blue labels.' in package/AGENTS.md.", calls([{ name: "Read", input: { file_path: note } }, edit(nested, "Use green labels.")])) } });
    await endsAre(page, 2);
    const child = page.getByTestId("tool-call").filter({ has: changed }).last();
    await expect(child).toHaveAttribute("data-state", "ok");
    await child.locator("button.k-line").click();
    await expect(child.getByTestId("tool-instruction-detail")).toContainText("Nested folder");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
