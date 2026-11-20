import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { openPanel, shoot } from "./shots.ts";

test.use({ viewport: { width: 1700, height: 980 } });

// A 1x1 PNG, written by a command into the artifacts folder.
const DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Feature: artifacts. A session writes a report, changes a file, puts a chart,
// a page and an image in its artifacts folder and makes a file by a command;
// the panel lists each as it lands (made or changed), previews markdown, the
// page in a sandbox that reaches nothing, the image, and the diff of the
// changed file; download and the path work; the project's page lists them too.
test("artifacts: indexed from tool calls, previewed, per session and per project", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const word = `af${Date.now().toString(36)}`;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", word);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "README.md"), "# Tool\n\nOld line.\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const s = (await (await request.post("/api/sessions", { data: { workspace: ws, model: "scripted:stand-in", title: `Report ${word}` } })).json()).session;
  await request.put(`/api/sessions/${s.id}/permissions`, { data: { mode: "full-auto" } });
  const list = async () => (await (await request.get(`/api/sessions/${s.id}/artifacts`)).json());
  const { dir } = await list();

  await page.goto(`/s/${s.id}`);
  await openPanel(page, "artifacts");
  await expect(page.getByTestId("artifacts-empty")).toBeVisible();

  const page_ = `<!doctype html><h1 id="h">Waiting</h1><script>document.getElementById("h").textContent = "Script ran";
fetch("/api/sessions").then(() => document.body.append(" reached the daemon"), () => document.body.append(" network blocked"));</script>`;
  const calls = [
    { name: "Write", input: { file_path: join(ws, "report.md"), content: `# Findings ${word}\n\n- **one** thing\n- another\n` } },
    { name: "Read", input: { file_path: join(ws, "README.md") } },
    { name: "Edit", input: { file_path: join(ws, "README.md"), old_string: "Old line.", new_string: "New line." } },
    { name: "Write", input: { file_path: `${dir}/chart.svg`, content: `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#3a7"/></svg>` } },
    { name: "Write", input: { file_path: `${dir}/page.html`, content: page_ } },
    { name: "Bash", input: { command: `echo ${DOT} | base64 -d > ${dir}/dot.png && echo made > made-by-shell.txt` } },
  ];
  await request.post(`/api/sessions/${s.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  const rows = page.getByTestId("artifact-row");
  // They land while the session works; the command's file comes with the turn's end.
  await expect(rows).toHaveCount(6, { timeout: 30_000 });
  const got = Object.fromEntries((await list()).artifacts.map((a: any) => [a.name, a]));
  expect(got["report.md"]).toMatchObject({ created: true, kind: "markdown", source: "edit", tool: "Write" });
  expect(got["README.md"]).toMatchObject({ created: false, source: "edit", tool: "Edit" });
  expect(got["page.html"]).toMatchObject({ created: true, kind: "html" });
  expect(got["dot.png"]).toMatchObject({ kind: "image", source: "folder" });
  expect(got["made-by-shell.txt"]).toMatchObject({ created: true, source: "shell" });

  // The prompt names the folder in the session's own part, after the cache split.
  const kept = await (await request.get(`/api/telemetry/prompt?session_id=${s.id}&text=1`)).json();
  expect(kept.blocks.map((b: any) => b.name)).toContain("Artifacts");
  expect(kept.text.slice(kept.split)).toContain(dir);
  expect(kept.text.slice(0, kept.split)).not.toContain(dir);

  // Markdown, rendered.
  await rows.filter({ hasText: "report.md" }).click();
  await expect(page.getByTestId("artifact-body").getByRole("heading", { name: `Findings ${word}` })).toBeVisible();
  await page.getByTestId("artifact-copy-path").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(join(ws, "report.md"));
  await shoot(page, "artifacts-01-markdown");

  // The page runs its script in a sandbox that reaches nothing.
  await rows.filter({ hasText: "page.html" }).click();
  await expect(page.getByTestId("artifact-frame")).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator('[data-testid="artifact-frame"]');
  await expect(frame.locator("#h")).toHaveText("Script ran");
  await expect(frame.locator("body")).toContainText("network blocked");
  await shoot(page, "artifacts-02-page");

  // The image, and the changed file's diff.
  await rows.filter({ hasText: "dot.png" }).click();
  await expect(page.getByTestId("artifact-image")).toBeVisible();
  await rows.filter({ hasText: "README.md" }).click();
  await page.getByTestId("artifact-view-diff").click();
  await expect(page.getByTestId("diff-view")).toContainText("New line.");
  await shoot(page, "artifacts-03-diff");

  // Download; nothing outside the session's artifacts is served.
  const dl = await request.get(await page.getByTestId("artifact-download").getAttribute("href") as string);
  expect(dl.headers()["content-disposition"]).toContain("README.md");
  expect((await request.get(`/api/sessions/${s.id}/artifacts/raw?path=${encodeURIComponent("/etc/hostname")}`)).status()).toBe(404);
  const html = await request.get(`/api/sessions/${s.id}/artifacts/raw?path=${encodeURIComponent(`${dir}/page.html`)}`);
  expect(html.headers()["content-security-policy"]).toContain("sandbox");

  // The project of the folder lists them with the session's name.
  const p = (await (await request.post("/api/projects", { data: { name: `Docs ${word}`, folders: [ws] } })).json()).project;
  await page.goto(`/p/${p.id}`);
  const all = page.getByTestId("project-artifacts-list");
  await expect(all.getByTestId("artifact-row")).toHaveCount(6);
  await all.getByTestId("artifact-row").filter({ hasText: "chart.svg" }).click();
  await expect(all.getByTestId("artifact-image")).toBeVisible();
  await page.getByTestId("project-artifacts").scrollIntoViewIfNeeded();
  await shoot(page, "artifacts-04-project");

  await request.delete(`/api/projects/${p.id}`);
  await request.delete(`/api/sessions/${s.id}`);
});
