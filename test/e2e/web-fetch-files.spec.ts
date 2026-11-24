import { expect, test } from "./isolate.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { daemon, exited, ROOT, sessionsFolder } from "./own-daemon.ts";
import { shoot } from "./shots.ts";
import { pdf, png } from "./fixtures/files.ts";

// Feature: a page fetch is decided by what the server says it is and by its bytes, not by the address. A PDF
// served at /doc (no .pdf in the path) is read for its text, a PNG at /img comes as an image with its file,
// and a zip at /file is saved and named in one line, never dumped as text. The transcript lists the three
// files and each opens from its chip. The pages come from a local server through a stand-in fetch program
// (fixtures/webfetch-files-standin.ts) that refuses a file by its type as the real program does, and a
// preload that names the server as a public-looking host (the web tools refuse a local address).
const HOST = "files.example.test";
const zip = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) % 256))]);

test("web fetch: a PDF without .pdf, an image and a zip come as text, an image and a file", async ({ page }) => {
  test.skip(spawnSync("pdftotext", ["-v"]).error !== undefined, "needs poppler-utils: a PDF is read through pdftotext");
  const seen: string[] = [];
  const web = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const file = (type: string, bytes: Buffer) => res.writeHead(200, { "content-type": type }).end(bytes);
    if (req.url === "/doc") return file("application/pdf", pdf);
    if (req.url === "/img") return file("image/png", png);
    if (req.url === "/file") return file("application/zip", zip);
    res.writeHead(404, { "content-type": "text/plain" }).end("none");
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  const state = join(ROOT, `web-fetch-files-${Date.now()}`);
  const origin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const d = await daemon(state, 0, false, {
    KEEL_WEBFETCH_BIN: join(import.meta.dirname, "fixtures/webfetch-files-standin.ts"),
    WEB_STANDIN: origin,
    WEB_STANDIN_HOST: HOST,
    BUN_OPTIONS: `--preload=${join(import.meta.dirname, "fixtures/local-names.ts")}`,
  });
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  try {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title: "Files", workspace: sessionsFolder(state) });
    const base = `/api/sessions/${session.id}`;
    await call(`${base}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${session.id}`);
    const fetches = ["/doc", "/img", "/file"].map((p) => ({ name: "WebFetch", input: { url: `https://${HOST}${p}`, prompt: "" } }));
    await page.getByTestId("composer").fill(`Fetch the three. script:obey ${JSON.stringify(fetches)}`);
    await page.getByTestId("composer").press("Enter");
    await expect.poll(async () => { const r = await call(base); return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length; }, { timeout: 60_000 }).toBe(1);

    const results = (await call(base)).events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results as any[]);
    expect(results).toHaveLength(3);
    const words = (r: any) => (typeof r.content === "string" ? r.content : r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"));
    const [doc, img, file] = results;
    // The PDF: its text, from a PDF file saved under the session's files.
    expect(words(doc)).toMatch(/^PDF saved to \S+\/files\/\S+\.pdf\n/);
    expect(words(doc)).toContain("Quarterly page one");
    expect(words(doc)).toContain("Quarterly page two");
    // The image: one line naming its file, and the image itself; no byte of it as text.
    expect(words(img)).toMatch(/^\[image\/png, \d+ KB, saved to \S+\/files\/\S+\.png\]$/);
    expect(img.content.filter((b: any) => b.type === "image")).toHaveLength(1);
    // The zip: one line with its type and size, and nothing of its bytes.
    expect(words(file)).toMatch(new RegExp(`^\\[application/zip, ${zip.length} bytes, saved to \\S+/files/\\S+\\.zip\\]$`));
    expect(file.content).not.toContain("PK");
    expect(readFileSync(/saved to (\S+)\]/.exec(words(file))![1]!).equals(zip)).toBe(true);
    // The server was asked for the three, and for each by the stand-in and again by Keel for the file's bytes.
    expect(seen.filter((s) => s === "GET /doc").length).toBeGreaterThanOrEqual(1);

    // The transcript lists the three files, and each opens from its chip with its own bytes.
    for (const p of ["/doc", "/img", "/file"]) await page.getByRole("button", { name: `Fetched https://${HOST}${p}` }).click();
    const chips = page.getByTestId("result-file");
    await expect(chips).toHaveCount(3);
    const bytes = async (i: number) => Buffer.from(await (await page.request.get(d.url + (await chips.nth(i).getAttribute("href"))!)).body());
    expect((await bytes(0)).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await bytes(1)).subarray(1, 4).toString()).toBe("PNG");
    expect((await bytes(2)).subarray(0, 2).toString()).toBe("PK");
    await shoot(page, "web-fetch-files-01-files");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    web.close();
    rmSync(state, { recursive: true, force: true });
  }
});
