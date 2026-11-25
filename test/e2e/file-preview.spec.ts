import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot } from "./shots.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MB = 1024 * 1024;

// A PNG that is only a header: it says 9000 x 9000 pixels, over what Keel decodes.
const hugePng = () => {
  const b = Buffer.from(PNG);
  b.writeUInt32BE(9000, 16);
  b.writeUInt32BE(9000, 20);
  return b;
};

// A ZIP of stored entries: local headers, the central directory, the end record.
function zip(entries: [string, string][]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let at = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name), d = Buffer.from(text);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt32LE(d.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42);
    local.push(l, n, d); central.push(c, n);
    at += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
  return Buffer.concat([...local, cd, end]);
}

// Feature: the Files panel shows a file by its kind: Markdown rendered, a table for CSV, JSON folded,
// an image within the limits, a page in a frame with no script and no network, a ZIP or tar listed,
// a large or binary file named. Each has its source, a raw view and a copy, and a file larger than one
// part is read in parts, never whole.
test("the Files panel previews a file by its kind and reads a large one in parts", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const word = `fp${Date.now().toString(36)}`;
  const { home } = (await (await request.get("/api/workspaces")).json()) as { home: string };
  const dir = join(home, ".cache/keel-work/bun/e2e-ws", word);
  mkdirSync(join(dir, "pack"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "# Release notes\n\nA **bold** claim, a [link](https://example.com/docs) and a list:\n\n- first\n- second\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  const rows = ["id,name,note"];
  for (let i = 1; i <= 1500; i++) rows.push(i === 2 ? `2,"Smith, Jo","said ""hi"""` : `${i},name${i},n${i}`);
  writeFileSync(join(dir, "people.csv"), rows.join("\n") + "\n");
  writeFileSync(join(dir, "cells.tsv"), "k\tv\nalpha\t1\nbeta\t2\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "keel", port: 4795, deep: { list: [1, 2, { inner: "leaf" }], on: true }, none: null }, null, 2));
  writeFileSync(join(dir, "page.html"), '<h1 id="t">Hello page</h1><p>Body text</p><script>document.getElementById("t").textContent = "SCRIPT RAN";</script><img src="http://127.0.0.1:9/never.png">');
  writeFileSync(join(dir, "dot.png"), PNG);
  writeFileSync(join(dir, "huge.png"), hugePng());
  writeFileSync(join(dir, "bundle.zip"), zip([["src/", ""], ["src/main.ts", "export {};\n"], ["README.md", "x".repeat(2048)]]));
  writeFileSync(join(dir, "pack/a.txt"), "alpha\n");
  writeFileSync(join(dir, "pack/b.txt"), "b".repeat(3000));
  expect(spawnSync("tar", ["-cf", join(dir, "plain.tar"), "-C", dir, "pack"]).status).toBe(0);
  expect(spawnSync("tar", ["-czf", join(dir, "bundle.tgz"), "-C", dir, "pack"]).status).toBe(0);
  // 50 MB of text and 50 MB of zeros: neither may be read whole.
  writeFileSync(join(dir, "huge.log"), Buffer.from("a line of the log, long enough to count\n".repeat(Math.ceil((50 * MB) / 40))));
  writeFileSync(join(dir, "blob.bin"), Buffer.alloc(50 * MB));
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: `Files ${word}`, workspace: dir } })).json();

  const sizes: { url: string; bytes: number }[] = [];
  page.on("response", async (r) => { if (r.url().includes("/api/fs/")) sizes.push({ url: r.url(), bytes: (await r.body().catch(() => Buffer.alloc(0))).length }); });
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "files");
  const view = page.getByTestId("file-view");
  const open = async (name: string) => {
    if (await view.count()) await page.getByRole("button", { name: "Back to the file list" }).click();
    await page.getByTestId("files-search").fill(name);
    await page.getByTestId("files-list").getByText(name, { exact: true }).click();
    await expect(view).toHaveAttribute("aria-label", `File ${name}`);
  };

  // Markdown: rendered, its link opens in a tab by the transcript's own rule, its source on the toggle (remembered).
  await open("notes.md");
  await expect(view.getByTestId("file-markdown").locator("h1")).toHaveText("Release notes");
  await expect(view.getByTestId("file-markdown").locator("strong")).toHaveText("bold");
  await expect(view.getByTestId("file-markdown").locator("li")).toHaveCount(2);
  await expect(view.getByTestId("file-markdown").locator("table tr")).toHaveCount(2);
  await expect(view.getByTestId("file-markdown").locator("a")).toHaveAttribute("target", "_blank");
  await shoot(page, "files-01-markdown");
  await view.getByTestId("file-view-source").click();
  await expect(view).toContainText("# Release notes");
  await expect(view.getByTestId("file-markdown")).toHaveCount(0);
  await view.getByTestId("file-copy").click();
  await expect(view.getByTestId("file-copy")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("# Release notes");
  const raw = await request.get(`/api/fs/raw?root=${encodeURIComponent(dir)}&path=notes.md`);
  expect(raw.headers()["content-type"]).toContain("text/plain");
  expect(await raw.text()).toContain("**bold**");
  // The choice is kept for the kind: another Markdown file opens in its source.
  writeFileSync(join(dir, "other.md"), "# Other\n");
  await open("other.md");
  await expect(view.getByTestId("file-view-source")).toHaveAttribute("aria-selected", "true");
  await view.getByTestId("file-view-preview").click();

  // CSV: a table of the first 1,000 rows, the rest counted; quoted fields hold their commas.
  await open("people.csv");
  const table = view.getByTestId("file-table");
  await expect(table.locator("thead th")).toHaveText(["", "id", "name", "note"]);
  await expect(table.locator("tbody tr")).toHaveCount(1000);
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(2)).toHaveText("Smith, Jo");
  await expect(table.locator("tbody tr").nth(1).locator("td").nth(3)).toHaveText('said "hi"');
  await expect(view.getByTestId("file-rows")).toContainText("1,000 of 1,500 rows shown, 500 more not shown.");
  await shoot(page, "files-02-csv");
  await open("cells.tsv");
  await expect(view.getByTestId("file-table").locator("tbody tr")).toHaveCount(2);
  await expect(view.getByTestId("file-table").locator("tbody tr").first().locator("td").nth(1)).toHaveText("alpha");

  // JSON: folded to the second level; a branch opens.
  await open("config.json");
  const json = view.getByTestId("file-json");
  await expect(json).toContainText("name:");
  await expect(json).toContainText("4795");
  await expect(json).not.toContainText("leaf");
  await json.getByRole("button", { name: /list/ }).click();
  await json.getByRole("button", { name: /\{ 1 key \}|\{/ }).last().click();
  await expect(json).toContainText("leaf");
  await shoot(page, "files-03-json");

  // HTML: in a frame with no script and no network; its source on the toggle.
  await open("page.html");
  const frame = view.getByTestId("file-frame");
  await expect(frame).toHaveAttribute("sandbox", "");
  const inner = page.frameLocator('[data-testid="file-frame"]');
  await expect(inner.locator("h1")).toHaveText("Hello page");
  await page.waitForTimeout(300);
  await expect(inner.locator("h1")).toHaveText("Hello page");
  const page_ = await request.get(`/api/fs/raw?root=${encodeURIComponent(dir)}&path=page.html`);
  expect(page_.headers()["content-security-policy"]).toMatch(/sandbox/);
  expect(page_.headers()["content-security-policy"]).toMatch(/default-src 'none'/);
  expect(page_.headers()["content-security-policy"]).not.toMatch(/script-src|allow-scripts/);
  await shoot(page, "files-04-html");
  await view.getByTestId("file-view-source").click();
  await expect(view).toContainText("<h1");

  // Images: drawn within the limits; one over them is named with its size.
  await open("dot.png");
  await expect.poll(() => view.getByTestId("file-image").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  await open("huge.png");
  await expect(view.getByTestId("file-image")).toHaveCount(0);
  await expect(view.getByTestId("file-note")).toContainText("9000 x 9000 px");
  await expect(view.getByTestId("file-note")).toContainText("not drawn");

  // Archives: listed by name and size, never extracted.
  await open("bundle.zip");
  const list = view.getByTestId("file-archive");
  await expect(list.locator("tbody tr")).toHaveCount(3);
  await expect(list).toContainText("src/main.ts");
  await expect(list.locator("tbody tr").nth(2)).toContainText("2 KB");
  await shoot(page, "files-05-zip");
  await open("plain.tar");
  await expect(view.getByTestId("file-archive")).toContainText("pack/b.txt");
  await expect(view.getByTestId("file-archive")).toContainText("3 KB");
  await open("bundle.tgz");
  await expect(view.getByTestId("file-archive")).toContainText("pack/a.txt");

  // A binary file: named with its size and kind, not read.
  await open("blob.bin");
  await expect(view.getByTestId("file-note")).toContainText("50.0 MB");
  await expect(view.getByTestId("file-copy")).toContainText("Copy path");
  await expect(view.getByTestId("file-raw")).toHaveAttribute("href", /\/api\/fs\/raw\?/);

  // A 50 MB text file: one part, then the next on request.
  await open("huge.log");
  await expect(view.getByTestId("file-range")).toContainText("Bytes 0 to");
  await expect(view.getByTestId("file-range")).toContainText("of 52,428,800");
  await shoot(page, "files-06-large");
  await view.getByRole("button", { name: "Next part" }).click();
  await expect(view.getByTestId("file-range")).not.toContainText("Bytes 0 to");
  await view.getByRole("button", { name: "Previous part" }).click();
  await expect(view.getByTestId("file-range")).toContainText("Bytes 0 to");

  // The size bound: nothing the panel asked for was larger than a part (and the zeros and the log never came whole).
  const fetched = sizes.filter((s) => s.url.includes("/api/fs/file?"));
  expect(fetched.length).toBeGreaterThan(10);
  expect(Math.max(...fetched.map((s) => s.bytes))).toBeLessThan(MB);
  expect(sizes.filter((s) => s.url.includes("/api/fs/raw?") && s.bytes > 8 * MB)).toEqual([]);

  // Narrow: the toolbar wraps and the table scrolls inside itself.
  await open("people.csv");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(view.getByTestId("file-table")).toBeVisible();
  await shoot(page, "files-07-narrow-csv");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
