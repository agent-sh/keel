import { expect, test, type APIRequestContext } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/blobs-mcp.ts`;
const STAND_IN = "scripted:claude-stand-in";
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const events = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
// The results of the session's calls, in order (the stand-in names its own call ids).
const resultsOf = async (request: APIRequestContext, id: string) => (await events(request, id))
  .filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as any[]);

test.afterEach(async ({ request }) => {
  await request.delete("/api/mcp/servers/blobs").catch(() => {});
});

// Feature: binary tool results are files the model can open. A tool that returns a PDF (an embedded
// resource labelled application/octet-stream), a PNG image and a WAV audio clip: the result names a file
// for each, with the extension its bytes and type give, under the session's folder; the image is also
// shown as an image; no base64 is in the model's words; the transcript lists the files, and each opens
// from there; the model reads the PDF from its path.
test("mcp blobs: a PDF, an image and audio come as files the model can read", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!SCRIPTED || !models.some((m) => m.id === STAND_IN), "needs the scripted Claude stand-in: run on the scripted provider (KEEL_SCRIPTED_PROVIDER=1)");
  test.skip(spawnSync("pdfinfo", ["-v"]).error !== undefined, "needs poppler-utils: the model reads a PDF through pdfinfo and pdftotext");
  await request.delete("/api/mcp/servers/blobs").catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: "blobs", command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
  await expect.poll(async () => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((s) => s.name === "blobs")?.state, { timeout: 20_000 }).toBe("ready");

  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `mcp-blobs-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: STAND_IN, title: "MCP blobs" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const ends = (n: number) => expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 60_000 }).toBe(n);
  try {
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(calls([
      { name: "ToolSearch", input: { query: "select:mcp__blobs__fetch" } },
      { name: "mcp__blobs__fetch", input: {} },
    ]));
    await page.keyboard.press("Enter");
    await ends(1);

    // The model's result: one line a file, with its type, size and path; the image goes on as an image too.
    const got = (await resultsOf(request, session.id)).at(-1);
    expect(got, "the call's result").toBeTruthy();
    const blocks = got.content as any[];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(text.length).toBeLessThan(1200);
    expect(text).not.toMatch(/[A-Za-z0-9+/]{200}/);
    const path = (ext: string) => new RegExp(`saved to (\\S+/files/\\S+\\.${ext})\\]`).exec(text)?.[1] as string;
    const [pdf, png, wav] = [path("pdf"), path("png"), path("wav")];
    expect([pdf, png, wav].every(Boolean), text).toBe(true);
    expect(text).toContain("[resource file:///reports/quarterly, application/pdf,");
    expect(text).toContain("image, image/png,");
    expect(text).toContain("audio, audio/wav,");
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);

    // The transcript lists the three files, and each opens from its chip with its own bytes.
    const card = page.getByTestId("tool-call").filter({ hasText: "mcp__blobs__fetch" }).last();
    await card.click();
    const chips = card.getByTestId("result-file");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toContainText("quarterly.pdf");
    await expect(chips.nth(1)).toContainText(".png");
    await expect(chips.nth(2)).toContainText(".wav");
    const bytes = async (i: number) => Buffer.from(await (await page.request.get((await chips.nth(i).getAttribute("href"))!)).body());
    expect((await bytes(0)).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await bytes(1)).subarray(1, 4).toString()).toBe("PNG");
    expect((await bytes(2)).subarray(8, 12).toString()).toBe("WAVE");
    // The image is drawn as well, from the bytes the model has.
    await expect.poll(() => card.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(48);
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "mcp-blobs-01-files");

    // A name outside the session's own folder is not served.
    expect((await request.get(`/api/sessions/${session.id}/saved/..%2F..%2Fx`)).status()).toBe(404);
    expect((await request.get(`/api/sessions/${session.id}/saved/nothing.pdf`)).status()).toBe(404);

    // The model opens the PDF from the path the result named: both pages.
    await page.getByTestId("composer").fill(calls([{ name: "Read", input: { file_path: pdf } }]));
    await page.keyboard.press("Enter");
    await ends(2);
    const read = (await resultsOf(request, session.id)).at(-1);
    const words = typeof read.content === "string" ? read.content : read.content.map((c: any) => c.text ?? "").join("\n");
    expect(words).toContain("2 pages");
    expect(words).toContain("Quarterly page one");
    expect(words).toContain("Quarterly page two");
  } finally {
    await request.delete(`/api/sessions/${session.id}`).catch(() => {});
  }
});
