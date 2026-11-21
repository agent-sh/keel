import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext } from "./isolate.ts";
import { emptyKeel } from "./peer.ts";
import { HAIKU, shoot } from "./shots.ts";

// The Claude Code session gains a question and an answer.
function growClaude(path: string, cwd: string, id: string) {
  const base = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString() };
  appendFileSync(path, JSON.stringify({ ...base, type: "user", uuid: "u9", parentUuid: "a3", message: { role: "user", content: "And its colour?" } }) + "\n");
  appendFileSync(path, JSON.stringify({ ...base, type: "assistant", uuid: "a9", parentUuid: "u9", message: { id: "msg_9", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Yellow." }] } }) + "\n");
}

// The Claude Code session rewinds and goes on another branch (after the tool result).
function rewindClaude(path: string, cwd: string, id: string) {
  const base = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString() };
  appendFileSync(path, JSON.stringify({ ...base, type: "assistant", uuid: "r1", parentUuid: "u2", message: { id: "msg_r", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Another answer." }] } }) + "\n");
  appendFileSync(path, JSON.stringify({ ...base, type: "user", uuid: "r2", parentUuid: "r1", message: { role: "user", content: "Go on from there." } }) + "\n");
}

// A Claude Code transcript of the given records (chained in order).
function claudeFile(dir: string, cwd: string, id: string, recs: any[]) {
  mkdirSync(dir, { recursive: true });
  let parent: string | null = null;
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, recs.map((r, i) => { const uuid = `${id}-${i}`; const x = { cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, parentUuid: parent, ...r }; parent = uuid; return JSON.stringify(x); }).join("\n") + "\n");
  return path;
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Feature: import of other harnesses' sessions and export. The sheet lists
// Claude Code, Codex and Rust Keel sessions from their stores, previews one,
// imports a copy that a model goes on with, updates it when the source grew;
// a session exports to Markdown, to a Keel file another Keel imports, and as a
// new Claude Code transcript with the command that resumes it.
// Run the daemon with KEEL_IMPORT_CLAUDE_DIR, KEEL_IMPORT_CODEX_DIR and
// KEEL_IMPORT_KEEL_DB at scratch stores: this test writes its fixtures there.
test("import and export", async ({ page, request }) => {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = (h: string) => first.harnesses.find((x: any) => x.harness === h)?.store as string;
  test.skip(!store("claude").includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  // Only this test's own failures count (the daemon may be busy with others):
  // what its page reports, and server errors of the import or of its sessions.
  const start = Date.now();
  const pageErrors: string[] = [];
  const mine = new Set<string>();
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/errors") pageErrors.push(String(r.postDataJSON()?.message)); });
  page.on("framenavigated", (f) => { const m = /\/s\/([^/?#]+)/.exec(f.url()); if (m) mine.add(m[1]!); });
  const tag = String(Date.now());
  // Antigravity's store is written only when the daemon reads a scratch one (KEEL_IMPORT_AGY_DIR).
  const agyScratch = !!store("agy")?.includes("keel-work");
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `import-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const made = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/import-stores.ts"), store("claude"), store("codex"), store("keel"), cwd, tag, ...(agyScratch ? [store("agy")] : [])], { encoding: "utf8" }));

  // The sheet: harness tabs with counts, a list, a preview.
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("import-sheet");
  await expect(sheet).toBeVisible();
  await page.getByTestId("import-search").fill(tag);
  const rows = sheet.getByTestId("import-row");
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  await expect(rows.first()).toContainText("Name the quince fixture");
  await rows.first().click();
  const preview = page.getByTestId("import-preview");
  await expect(preview.getByTestId("import-counts")).toContainText("1prompts");
  await expect(preview).toContainText("not carried: signatures");
  await expect(preview).toContainText("The fruit is quince.");
  await shoot(page, "import-01-preview");

  // Import, then a model goes on with the copy.
  await preview.getByTestId("import-go").click();
  await expect(page).toHaveURL(/\/s\//);
  const id = page.url().split("/s/")[1]!;
  await expect(page.getByTestId("assistant-text").last()).toContainText("The fruit is quince.");
  await request.patch(`/api/sessions/${id}`, { data: { model: HAIKU } });
  await page.reload();
  await page.getByTestId("composer").fill("Which fruit did the file name? Answer with the one word.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/quince/i);
  await shoot(page, "import-02-continued");

  // The source goes on: the list says so. The copy went on here too, so it is
  // not updated (the source's turns would land after its own); a new copy has both.
  growClaude(made.claude, cwd, `c0ffee00-0000-4000-8000-${tag.padStart(12, "0")}`);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.keyboard.press("Enter");
  await page.getByTestId("import-search").fill(tag);
  await expect(rows.first().getByTestId("import-imported")).toHaveText("imported · grew", { timeout: 15_000 });
  await rows.first().click();
  await expect(preview).toContainText("the copy went on here and the original too");
  await expect(preview.getByTestId("import-update")).toHaveCount(0);
  await preview.getByTestId("import-new").click();
  await expect(page.getByTestId("transcript").getByText("Yellow.")).toBeVisible();
  const second = page.url().split("/s/")[1]!;
  mine.add(second);

  // Two copies now: the preview names each; Open opens the copy the row
  // shows, and opens it with the original moved away.
  const claudeId = `c0ffee00-0000-4000-8000-${tag.padStart(12, "0")}`;
  const openSheet = async () => {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await expect(page.getByRole("option", { name: "Import sessions" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
  };
  await openSheet();
  await page.getByTestId("import-search").fill(tag);
  await rows.first().click();
  await expect(preview.getByTestId("import-copy")).toHaveCount(2);
  await shoot(page, "import-06-copies");
  renameSync(made.claude, `${made.claude}.moved`);
  await preview.getByTestId("import-open").click();
  await expect(page).toHaveURL(new RegExp(`/s/${second}$`));
  const opened = await request.post("/api/import", { data: { harness: "claude", id: claudeId, mode: "open", session_id: id } });
  expect((await opened.json()).session.id).toBe(id);
  renameSync(`${made.claude}.moved`, made.claude);

  // The original rewinds and goes on another branch: neither an update nor a
  // batch update appends its new turns after what the copy holds.
  rewindClaude(made.claude, cwd, claudeId);
  const held = (await (await request.get(`/api/sessions/${second}`)).json()).events.length;
  const upd = await request.post("/api/import", { data: { harness: "claude", id: claudeId, path: made.claude, mode: "update" } });
  expect(upd.status()).toBe(409);
  expect((await upd.json()).error).toContain("another branch");
  const bu = await (await request.post("/api/import/batch", { data: { mode: "update", items: [{ harness: "claude", id: claudeId, path: made.claude }] } })).json();
  expect(bu.results[0]).toMatchObject({ ok: false, status: 409 });
  expect((await (await request.get(`/api/sessions/${second}`)).json()).events.length).toBe(held);

  // Codex, the Rust Keel and Antigravity, from their own stores.
  const others: [string, string, string][] = [["codex", "Pick a code word", "The code word is bramble."], ["keel", "Harbour Kythira", "The harbour is Kythira."]];
  if (agyScratch) others.push(["agy", "Lighthouse Pharos", "The lighthouse is Pharos."]);
  for (const [tab, row, text] of others) {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await page.keyboard.press("Enter");
    await page.getByTestId(`import-tab-${tab}`).click();
    await page.getByTestId("import-search").fill(tag);
    await expect(rows.first()).toContainText(row, { timeout: 20_000 }); // a store's first listing reads its files
    await rows.first().click();
    await expect(page.getByTestId("import-preview")).toContainText(text);
    if (tab === "keel") await shoot(page, "import-03-keel");
    if (tab === "agy") {
      // Calls and results paired by order, the parallel results written before their call.
      await expect(page.getByTestId("import-preview").getByTestId("import-counts")).toContainText("2tool calls");
      await shoot(page, "import-03b-agy");
    }
    await page.getByTestId("import-go").click();
    await expect(page.getByTestId("assistant-text").last()).toContainText(text);
  }

  // Export: Markdown and a Keel file to download, and a Claude Code transcript.
  const md = await request.get(`/api/sessions/${id}/export?format=md`);
  expect(md.headers()["x-keel-redacted"]).toBe("1");
  expect(await md.text()).toContain("quince");
  const keelFile = await (await request.get(`/api/sessions/${id}/export?format=jsonl`)).text();
  const again = await (await request.post("/api/sessions/import", { data: keelFile, headers: { "content-type": "application/x-ndjson" } })).json();
  expect(again.events_imported).toBeGreaterThan(3);
  expect(again.model.reason).toBe("listed");
  // A copy cut short is refused before any session is made; the Keel file has no parts to choose.
  const cut = keelFile.split("\n").slice(0, 3).join("\n") + "\n";
  const refused = await request.post("/api/sessions/import", { data: cut, headers: { "content-type": "application/x-ndjson" } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toContain("incomplete export: expected");
  expect((await request.get(`/api/sessions/${id}/export?format=jsonl&include=tools`)).status()).toBe(400);
  await page.goto(`/s/${id}`);
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog.getByTestId("export-origin")).toContainText("Imported from Claude Code");
  await dialog.getByTestId("export-claude").click();
  await expect(dialog.getByTestId("export-command")).toContainText("claude --resume");
  await shoot(page, "import-04-export");
  const path = (await dialog.getByTestId("export-path").textContent())!.trim();
  expect(path.startsWith(store("claude"))).toBe(true);
  expect(existsSync(path)).toBe(true);
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.some((r) => r.type === "assistant" && JSON.stringify(r.message.content).includes("quince"))).toBe(true);
  // What was written reads back as a Claude Code session.
  const listed = await (await request.get(`/api/import/sessions?harness=claude&q=${tag}&refresh=1`)).json();
  expect(listed.total).toBe(2);

  // Import all: what the shown list holds, counted and confirmed first. A
  // question of only an image and one whose prompt sits between long tool
  // outputs are listed; one whose file went away before the import is named
  // with its reason, and Retry failed sends only it.
  const bulkCwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `bulk-${tag}`);
  mkdirSync(bulkCwd, { recursive: true });
  const bulkDir = join(store("claude"), bulkCwd.replace(/[^A-Za-z0-9]/g, "-"));
  const long = "x".repeat(70_000);
  const result = (n: number) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: long }] } });
  claudeFile(bulkDir, bulkCwd, `b0000000-0000-4000-8000-${tag.padStart(12, "0")}`, [{ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] } }, { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Analysis complete." }], stop_reason: "end_turn" } }]);
  claudeFile(bulkDir, bulkCwd, `b1000000-0000-4000-8000-${tag.padStart(12, "0")}`, [result(0), { type: "user", message: { role: "user", content: "The middle prompt" } }, result(1)]);
  const goner = claudeFile(bulkDir, bulkCwd, `b2000000-0000-4000-8000-${tag.padStart(12, "0")}`, [{ type: "user", message: { role: "user", content: "Soon gone" } }]);
  await page.goto("/");
  await openSheet();
  await page.getByTestId("import-tab-claude").click();
  await page.getByTestId("import-search").fill(`bulk-${tag}`);
  await expect(rows).toHaveCount(3, { timeout: 15_000 });
  await expect(sheet.getByTestId("import-list")).toContainText("Image prompt");
  await expect(sheet.getByTestId("import-list")).toContainText("The middle prompt");
  await sheet.getByTestId("import-all").click();
  await expect(sheet.getByTestId("import-all-confirm")).toContainText("Import 3 new copies");
  rmSync(goner);
  await sheet.getByTestId("import-all-go").click();
  await expect(sheet.getByTestId("import-total")).toHaveText("Imported 2; 1 not imported");
  await expect(sheet.getByTestId("import-fail")).toHaveCount(1);
  await expect(sheet.getByTestId("import-fail")).toContainText("Soon gone");
  await expect(sheet.getByTestId("import-fail")).toContainText("moved or was removed");
  await shoot(page, "import-05-bulk-failed");
  claudeFile(bulkDir, bulkCwd, `b2000000-0000-4000-8000-${tag.padStart(12, "0")}`, [{ type: "user", message: { role: "user", content: "Soon gone" } }]);
  await sheet.getByTestId("import-retry-failed").click();
  await expect(sheet.getByTestId("import-total")).toHaveText("Imported 1");
  await expect(sheet.getByTestId("import-imported")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // A batch opens what was imported before and says which item it could not find.
  const batch = await (await request.post("/api/import/batch", { data: { items: [{ harness: "keel", id: `keel-${tag}` }, { harness: "codex", id: "no-such-rollout" }] } })).json();
  expect(batch.counts).toEqual({ opened: 1, failed: 1 });

  if (again.session?.id) mine.add(again.session.id);
  const serverErrors = ((await (await request.get("/api/errors")).json()).errors as any[])
    .filter((e) => e.source !== "client" && e.ts >= start && (String(e.context?.at ?? "").startsWith("import") || mine.has(e.context?.session ?? e.context?.session_id)))
    .map((e) => e.message);
  expect([...pageErrors, ...serverErrors]).toEqual([]);
});

// The Markdown export writes the parts it has text for, tool calls and
// reasoning. A part it does not write (diffs) is refused, not answered with a
// file that leaves it out.
test("a Markdown export refuses a part it does not write", async ({ request }) => {
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "Export parts" } })).json();
  try {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Read", input: { file_path: "/no/such/file.txt" } }])}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}/events`)).json()).events.some((e: any) => e.kind === "turn_end"), { timeout: 30_000 }).toBe(true);
    const get = (include: string) => request.get(`/api/sessions/${session.id}/export?format=md&include=${include}`);
    for (const include of ["diffs", "tools,diffs"]) {
      const r = await get(include);
      expect([include, r.status(), (await r.json()).error]).toEqual([include, 400, "the export has no diffs part: an edit's change is in its tool call (include=tools); the parts are reasoning and tools"]);
    }
    expect((await (await get("patches")).json()).error).toBe("unknown part patches: the parts are reasoning and tools");
    const plain = await request.get(`/api/sessions/${session.id}/export?format=md`);
    expect([plain.status(), (await plain.text()).includes("**Call 1: Read**")]).toEqual([200, false]);
    for (const include of ["tools", "tools,reasoning"]) {
      const r = await get(include);
      expect([include, r.status(), (await r.text()).includes("**Call 1: Read**")]).toEqual([include, 200, true]);
    }
    expect((await get("reasoning")).status()).toBe(200);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});

// ---- the scripted specs: no model is called, a stand-in answers.

const SCRIPTED = "scripted:stand-in";
const scripted = async (request: APIRequestContext) => ((await (await request.get("/api/models")).json()).models as any[]).some((m) => m.id === SCRIPTED);
const SCRATCH = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
const eventsOf = async (request: APIRequestContext, id: string, base = "") => (await (await request.get(`${base}/api/sessions/${id}`)).json()).events as any[];

// One prompt and the stand-in's reply, waited for.
async function say(request: APIRequestContext, id: string, text: string, images?: unknown[]) {
  const ends = async () => (await eventsOf(request, id)).filter((e) => e.kind === "turn_end").length;
  const before = await ends();
  expect((await request.post(`/api/sessions/${id}/messages`, { data: { text, images } })).ok()).toBe(true);
  await expect.poll(ends, { timeout: 30_000 }).toBe(before + 1);
}

// A Keel file with its attached files inside opens whole in a Keel that never
// had them: the same bytes under two names are one stored file there, and each
// name downloads them. The ordinary Keel file is as it was: names, no bytes.
test("a Keel file carries its attached files to an empty Keel", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const bytes = Buffer.from(`ledger ${tag}\n\u0000\u00ff binary tail`, "latin1");
  const up = async (name: string) => (await (await request.post(`/api/attachments?name=${encodeURIComponent(name)}`, { headers: { "content-type": "application/octet-stream" }, data: bytes })).json());
  const budget = await up(`budget-${tag}.bin`);
  const release = await up(`דוח-${tag}.bin`);
  expect(budget.id).toBe(release.id);
  const { session } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, title: `Bundle ${tag}` } })).json();
  await say(request, session.id, "The budget.", [budget]);
  await say(request, session.id, "The release.", [release]);

  // The dialog offers the files once; the switch changes what the Keel file link fetches.
  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  const dialog = page.getByTestId("export-dialog");
  const link = dialog.getByTestId("export-jsonl");
  await expect(link).toHaveAttribute("href", `/api/sessions/${session.id}/export?format=jsonl`);
  await expect(dialog.getByTestId("export-with-files")).toBeVisible();
  await expect(dialog).toContainText("Put the attached file (1 KB) inside the Keel file");
  await dialog.getByTestId("export-with-files").click();
  await expect(link).toHaveAttribute("href", `/api/sessions/${session.id}/export?format=jsonl&attachments=1`);
  await shoot(page, "import-07-export-with-files");

  const plain = await (await request.get(`/api/sessions/${session.id}/export?format=jsonl`)).text();
  expect(plain).not.toContain('"blob"');
  expect(JSON.parse(plain.split("\n")[0]!).blobs).toBeUndefined();
  const whole = await (await request.get((await link.getAttribute("href"))!)).text();
  expect(JSON.parse(whole.split("\n")[0]!)).toMatchObject({ blobs: 1 });
  expect(whole.split("\n").filter((l) => l.startsWith('{"blob"'))).toHaveLength(1);
  expect((await request.get(`/api/sessions/${session.id}/export?format=md&attachments=1`)).status()).toBe(400);

  const other = await emptyKeel(join(SCRATCH, `empty-${tag}`));
  try {
    const post = (body: string) => fetch(`${other.url}/api/sessions/import`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body });
    const held = async () => ({
      files: existsSync(join(other.state, "attachments")) ? readdirSync(join(other.state, "attachments")) : [],
      sessions: (((await (await fetch(`${other.url}/api/sessions`)).json()) as any).sessions as any[]).length,
    });
    // A file that cannot be imported is refused whole, as the sender's mistake:
    // no session, nothing stored. Its bytes are not what it says; an event has
    // no data beside a sound file; a file is named as a folder.
    const lines = whole.split("\n");
    const at = lines.findIndex((l) => l.startsWith('{"blob"'));
    const blob = JSON.parse(lines[at]!);
    const flipped = Buffer.from(blob.data, "base64"); flipped[0]! ^= 1;
    const damaged = [...lines.slice(0, at), JSON.stringify({ ...blob, data: flipped.toString("base64") }), ...lines.slice(at + 1)].join("\n");
    const edited = (f: (e: any) => any) => lines.map((l, i) => (i === 1 ? JSON.stringify(f(JSON.parse(l))) : l)).join("\n");
    for (const [file, words] of [
      [damaged, "do not match its digest"],
      [edited(({ data: _, ...e }) => e), "has no data"],
      [edited((e) => ({ ...e, data: { ...e.data, images: e.data.images.map((b: any) => ({ ...b, name: ".." })) } })), "without a usable name"],
      [edited((e) => ({ ...e, data: { ...e.data, images: "budget" } })), "does not list what it carries"],
    ] as const) {
      const refused = await post(file);
      expect([refused.status, ((await refused.json()) as any).error]).toEqual([400, expect.stringContaining(words)]);
      expect(await held()).toEqual({ files: [], sessions: 0 });
    }

    // In that Keel's own import sheet: a damaged file says why it was not imported.
    const asFile = (name: string, text: string) => ({ name, mimeType: "application/x-ndjson", buffer: Buffer.from(text) });
    await page.goto(`${other.url}/`);
    const openSheet = async () => {
      await page.keyboard.press("Control+k");
      await page.getByTestId("palette-input").fill("Import sessions");
      await expect(page.getByRole("option", { name: "Import sessions" })).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("import-sheet")).toBeVisible();
    };
    await openSheet();
    await expect(page.getByTestId("import-keel-file")).toBeVisible();
    const result = page.getByTestId("import-keel-result");
    await page.getByTestId("import-keel-file-input").setInputFiles(asFile("damaged.jsonl", damaged));
    await expect(result).toHaveAttribute("data-state", "failed");
    await expect(result).toContainText("damaged.jsonl was not imported");
    await expect(result).toContainText("do not match its digest");
    await shoot(page, "import-12-keel-file-refused");
    expect(await held()).toEqual({ files: [], sessions: 0 });
    // The ordinary file is imported, and what did not travel with it is said before it opens.
    await page.getByTestId("import-keel-file-input").setInputFiles(asFile("plain.jsonl", plain));
    await expect(result).toHaveAttribute("data-state", "done");
    await expect(result.getByTestId("import-keel-note")).toContainText("not stored on this machine");
    await shoot(page, "import-13-keel-file-imported");
    await result.getByTestId("import-keel-open").click();
    await expect(page).toHaveURL(/\/s\//);
    await expect(page.getByTestId("user-message")).toHaveCount(2);

    // From a terminal, the file with its attached files inside: nothing is missing.
    const path = join(SCRATCH, `empty-${tag}`, "whole.jsonl");
    writeFileSync(path, whole);
    const cli = JSON.parse(execFileSync("bun", ["src/main.ts", "import", "file", path, "--url", other.url, "--json"], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: join(SCRATCH, `empty-${tag}`, "config"), KEEL_STATE_DIR: join(SCRATCH, `empty-${tag}`, "cli-state") } }));
    expect(cli.files_imported).toBe(1);
    expect(cli.notes.join(" ")).not.toContain("not stored on this machine");
    const refs = ((await (await fetch(`${other.url}/api/sessions/${cli.session.id}`)).json()) as any).events.filter((e: any) => e.kind === "user").flatMap((e: any) => e.data.images);
    expect(refs.map((r: any) => r.name)).toEqual([`budget-${tag}.bin`, `דוח-${tag}.bin`]);
    for (const r of refs) {
      const dl = await fetch(`${other.url}/api/attachments/${r.id}?name=${encodeURIComponent(r.name)}&type=${encodeURIComponent(r.media_type)}`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);
      expect(dl.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(r.name)}`);
    }
    expect(readdirSync(join(other.state, "attachments"))).toEqual([budget.id]);
    expect(readdirSync(join(other.state, "attachments", budget.id))).toHaveLength(1);
    // And from the sheet again: with nothing to say, the session opens at once, its files on its prompts.
    await openSheet();
    await page.getByTestId("import-keel-file-input").setInputFiles(asFile("whole.jsonl", whole));
    await expect(page).not.toHaveURL(new RegExp(`/s/${cli.session.id}$`));
    await expect(page.getByTestId("import-sheet")).toHaveCount(0);
    await expect(page.getByTestId("message-file")).toHaveCount(2);
  } finally {
    await other.stop();
    rmSync(join(SCRATCH, `empty-${tag}`), { recursive: true, force: true });
  }
  await request.delete(`/api/sessions/${session.id}`);
});

// A clear travels in a Keel file with its way back: in the copy, Undo returns
// to the copy's own event before the clear, not to an id of the session exported.
test("a clear in a Keel file is undone in its copy", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, title: `Cleared ${Date.now().toString(36)}` } })).json();
  await say(request, session.id, "Name one harbour.");
  const cleared = await (await request.post(`/api/sessions/${session.id}/clear`)).json();
  const source = await eventsOf(request, session.id);
  const file = await (await request.get(`/api/sessions/${session.id}/export?format=jsonl`)).text();
  const made = await (await request.post("/api/sessions/import", { data: file, headers: { "content-type": "application/x-ndjson" } })).json();
  const copy = await eventsOf(request, made.session.id);
  const clear = copy.find((e) => e.kind === "compaction")!;
  // The way back is the copy's event before the clear; no id of the source is left in the copy.
  expect(clear.data.undo_head).toBe(clear.parent);
  expect(clear.data.undo_head).not.toBe(cleared.undo_head_event_id);
  const text = JSON.stringify(copy.map((e) => e.data));
  for (const e of source) expect(text).not.toContain(e.id);

  await page.goto(`/s/${made.session.id}`);
  await page.getByTestId("undo-clear").click();
  await expect(page.getByTestId("undo-clear")).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/api/sessions/${made.session.id}`)).json()).session.head).toBe(clear.parent);
  await request.delete(`/api/sessions/${session.id}`);
  await request.delete(`/api/sessions/${made.session.id}`);
});

// The Keel file holds the branch shown unless every branch is asked for: then
// the copy has the same tree under ids of its own, shows the branch that was
// shown, and the other leaf is one step away.
test("a whole-tree Keel file keeps both leaves and the branch shown", async ({ page, request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const { session } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, title: `Tree ${tag}` } })).json();
  await say(request, session.id, `Shared start ${tag}`);
  const fork = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.head as string;
  await say(request, session.id, `Leaf alpha ${tag}`);
  const alpha = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.head as string;
  // Back to the shared start, a second leaf from there; then the first leaf is shown again.
  await request.post(`/api/sessions/${session.id}/head`, { data: { head_event_id: fork, leaf: false } });
  await say(request, session.id, `Leaf beta ${tag}`);
  await request.post(`/api/sessions/${session.id}/head`, { data: { head_event_id: alpha, leaf: false } });

  // The shape of a tree without its ids: each event by its kind and words, under its parent's.
  const shape = (evs: any[], head: string | null) => {
    const by = new Map(evs.map((e) => [e.id, e]));
    const name = (e: any) => `${e.kind}:${e.data.text ?? e.data.blocks?.map((b: any) => b.text ?? b.type).join("|") ?? e.data.reason ?? ""}`;
    const path = (id: string | null): string => { const e = id ? by.get(id) : undefined; return e ? `${path(e.parent)}/${name(e)}` : ""; };
    return { paths: evs.map((e) => path(e.id)).sort(), head: path(head), leaves: evs.filter((e) => !evs.some((x) => x.parent === e.id)).length };
  };
  const source = await (await request.get(`/api/sessions/${session.id}`)).json();
  const want = shape(source.events, source.session.head);
  expect(want.leaves).toBe(2);
  expect(want.head).toContain(`Leaf alpha ${tag}`);

  // The dialog: the branch file by default, every branch behind a switch.
  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  const dialog = page.getByTestId("export-dialog");
  const link = dialog.getByTestId("export-jsonl");
  await expect(link).toHaveAttribute("href", `/api/sessions/${session.id}/export?format=jsonl`);
  await expect(dialog.getByTestId("export-stays")).toHaveText("1 other branch stays in this session.");
  await dialog.getByTestId("export-tree").click();
  await expect(link).toHaveAttribute("href", `/api/sessions/${session.id}/export?format=jsonl&scope=tree`);
  await expect(link).toContainText("every branch whole");
  await expect(dialog.getByTestId("export-stays")).toHaveCount(0);
  await shoot(page, "import-08-export-tree");
  const treeFile = await (await request.get((await link.getAttribute("href"))!)).text();
  await page.keyboard.press("Escape");

  // The default file is the branch shown: one leaf in its copy.
  const branchFile = await (await request.get(`/api/sessions/${session.id}/export?format=jsonl`)).text();
  expect(JSON.parse(branchFile.split("\n")[0]!)).toMatchObject({ keel_export: 2, scope: "current branch" });
  expect(JSON.parse(treeFile.split("\n")[0]!)).toMatchObject({ keel_export: 3, scope: "tree" });
  expect(branchFile).not.toContain(`Leaf beta ${tag}`);
  const post = async (file: string) => (await (await request.post("/api/sessions/import", { data: file, headers: { "content-type": "application/x-ndjson" } })).json());
  const one = await post(branchFile);
  expect(shape(await eventsOf(request, one.session.id), null).leaves).toBe(1);

  const made = await post(treeFile);
  const copy = await (await request.get(`/api/sessions/${made.session.id}`)).json();
  expect(shape(copy.events, copy.session.head)).toEqual(want);
  const sourceIds = new Set(source.events.map((e: any) => e.id));
  expect(copy.events.some((e: any) => sourceIds.has(e.id) || sourceIds.has(e.parent))).toBe(false);
  expect((await request.get(`/api/sessions/${session.id}/export?format=md&scope=tree`)).status()).toBe(400);

  // In the copy the leaf that was shown is shown, and the other is one step away.
  await page.goto(`/s/${made.session.id}`);
  await expect(page.getByTestId("user-message").last()).toContainText(`Leaf alpha ${tag}`);
  await expect(page.getByTestId("branch-pos")).toHaveText("1/2");
  await page.getByRole("button", { name: "Next version" }).click();
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2");
  await expect(page.getByTestId("user-message").last()).toContainText(`Leaf beta ${tag}`);
  await page.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByTestId("user-message").last()).toContainText(`Leaf alpha ${tag}`);
  for (const id of [session.id, one.session.id, made.session.id]) await request.delete(`/api/sessions/${id}`);
});

// The sheet lists the sessions of every store and imports from each: the
// list comes from the index's columns (a page, a search, a harness tab), the
// copy from the file. No model is called.
test("the import sheet lists every harness and imports from each", async ({ page, request }) => {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = (h: string) => first.harnesses.find((x: any) => x.harness === h)?.store as string;
  test.skip(!store("claude").includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = String(Date.now());
  const cwd = join(SCRATCH, `mixed-${tag}`);
  mkdirSync(cwd, { recursive: true });
  execFileSync("bun", [join(import.meta.dirname, "fixtures/import-stores.ts"), store("claude"), store("codex"), store("keel"), cwd, tag], { encoding: "utf8" });

  // One search across the stores: the three sessions of this run, newest first, and a subagent only when asked for.
  const list = async (q: string) => (await (await request.get(`/api/import/sessions?${q}`)).json());
  const mixed = await list(`q=${tag}&refresh=1`);
  expect(mixed.sessions.map((s: any) => s.harness).sort()).toEqual(["claude", "codex", "keel"]);
  expect(mixed.sessions.map((s: any) => s.updated_ms)).toEqual([...mixed.sessions.map((s: any) => s.updated_ms)].sort((a: number, b: number) => b - a));
  expect(mixed.total).toBe(3);
  expect((await list(`q=${tag}&show=subagents`)).total).toBe(4);
  // Page by page, one row a page: the same three, once each; the cursor of another search is refused.
  const paged: string[] = [];
  for (let cursor: string | undefined, i = 0; i < 5; i++) {
    const r = await list(`q=${tag}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    paged.push(...r.sessions.map((s: any) => s.id));
    if (!(cursor = r.next_cursor)) break;
    if (i === 0) expect((await request.get(`/api/import/sessions?q=other&cursor=${cursor}`)).status()).toBe(400);
  }
  expect(paged).toEqual(mixed.sessions.map((s: any) => s.id));
  // A cursor a caller made up is the caller's mistake, not the daemon's failure.
  const real = JSON.parse(Buffer.from((await list(`q=${tag}&limit=1`)).next_cursor, "base64url").toString());
  real[2] = {};
  expect((await request.get(`/api/import/sessions?q=${tag}&limit=1&cursor=${Buffer.from(JSON.stringify(real)).toString("base64url")}`)).status()).toBe(400);
  const byId = await (await request.get(`/api/import/preview?harness=codex&id=${mixed.sessions.find((s: any) => s.harness === "codex").id}`)).json();
  expect(byId.session.title).toContain("Pick a code word");

  await page.goto("/");
  const sheet = page.getByTestId("import-sheet");
  const rows = sheet.getByTestId("import-row");
  const made: string[] = [];
  for (const [tab, row, text] of [["claude", "Name the quince fixture", "The fruit is quince."], ["codex", "Pick a code word", "The code word is bramble."], ["keel", "Harbour Kythira", "The harbour is Kythira."]] as const) {
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("Import sessions");
    await expect(page.getByRole("option", { name: "Import sessions" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(sheet).toBeVisible();
    await page.getByTestId(`import-tab-${tab}`).click();
    await page.getByTestId("import-search").fill(tag);
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await expect(rows.first()).toContainText(row);
    await rows.first().click();
    await expect(page.getByTestId("import-preview")).toContainText(text);
    await page.getByTestId("import-go").click();
    await expect(page).toHaveURL(/\/s\//);
    await expect(page.getByTestId("assistant-text").last()).toContainText(text);
    made.push(page.url().split("/s/")[1]!);
  }
  // Each is now listed as imported, found again by its harness and id.
  const after = await list(`q=${tag}`);
  expect(after.sessions.map((s: any) => s.imported?.session_id).sort()).toEqual([...made].sort());
  for (const id of made) await request.delete(`/api/sessions/${id}`);

  // A list longer than a page, and a More button whose cursor the daemon no
  // longer takes (a page of an older build held it through an upgrade: a row
  // count): the list is read again from the top and goes on, instead of failing.
  const longDir = join(store("claude"), `-more-${tag}`);
  for (let i = 0; i < 70; i++) claudeFile(longDir, cwd, `40000000-0000-4000-8000-${String(i).padStart(4, "0")}${tag.slice(-8)}`, [{ type: "user", message: { role: "user", content: `more-${tag} number ${i}` } }]);
  expect((await list(`q=more-${tag}&refresh=1`)).total).toBe(70);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await expect(page.getByRole("option", { name: "Import sessions" })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.getByTestId("import-tab-claude").click();
  await page.getByTestId("import-search").fill(`more-${tag}`);
  await expect(rows).toHaveCount(60, { timeout: 20_000 });
  let withCursor = 0;
  await page.route(/\/api\/import\/sessions\?.*cursor=/, (route) => {
    const u = new URL(route.request().url());
    if (withCursor++ === 0) u.searchParams.set("cursor", "60");
    return route.continue({ url: u.toString() });
  });
  await sheet.getByRole("button", { name: "More", exact: true }).click();
  await expect(rows).toHaveCount(70);
  expect(withCursor).toBe(1);
  await page.unroute(/\/api\/import\/sessions\?.*cursor=/);
  rmSync(longDir, { recursive: true, force: true });
});

// The resume line the dialog shows runs as it is pasted, whatever the
// session's folder is called: here a name with a space and an apostrophe. A
// stub stands in for the harness and records where it ran and what it was given.
test("the copied resume command changes to a folder with a space and a quote", async ({ page, request }) => {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  test.skip(!first.harnesses.find((x: any) => x.harness === "claude")?.store.includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const base = join(SCRATCH, `resume-${tag}`);
  const cwd = join(base, "it's a client's folder $HOME");
  const bin = join(base, "bin");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const ran = join(base, "ran.txt");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n{ pwd; printf '%s\\n' "$@"; } > ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  const { session } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, workspace: cwd, title: `Resume ${tag}` } })).json();
  await say(request, session.id, "Name one harbour.");

  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  const dialog = page.getByTestId("export-dialog");
  await dialog.getByTestId("export-claude").click();
  const command = (await dialog.getByTestId("export-command").textContent())!;
  expect(command).toContain("claude --resume ");
  await shoot(page, "import-09-resume-quoted");
  const id = (await dialog.getByTestId("export-path").textContent())!.trim().split("/").pop()!.replace(/\.jsonl$/, "");
  // Pasted into a shell, as it is.
  execFileSync("bash", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  expect(readFileSync(ran, "utf8").trim().split("\n")).toEqual([cwd, "--resume", id]);
  await request.delete(`/api/sessions/${session.id}`);
  rmSync(base, { recursive: true, force: true });
});

// The index says what it is doing: building while a walk of the stores runs,
// complete when it ended, and asking never starts a walk of its own.
test("the import index status follows a walk of the stores", async ({ request }) => {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = first.harnesses.find((x: any) => x.harness === "claude")?.store as string;
  test.skip(!store.includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  // A store large enough for a walk to take a while: every file is read again by a rebuild.
  const tag = Date.now().toString(36);
  const dir = join(store, `-walk-${tag}`);
  mkdirSync(dir, { recursive: true });
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const id = `77777777-0000-4000-8000-${String(i).padStart(12, "0")}`;
    writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ cwd: "/walk", sessionId: id, isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), type: "user", uuid: "u", parentUuid: null, message: { role: "user", content: `walk ${tag} ${i}` } }) + "\n");
  }
  const status = async () => (await (await request.get("/api/import/index")).json()) as { building: boolean; complete: boolean; built_ms: number | null; harnesses: any[] };
  try {
    const started = await (await request.post("/api/import/index", { data: { action: "rebuild" } })).json();
    expect(started).toMatchObject({ building: true, complete: false });
    // While it runs, a reader is told so.
    expect(await status()).toMatchObject({ building: true, complete: false });
    await expect.poll(async () => (await status()).building, { timeout: 60_000, intervals: [50] }).toBe(false);
    const done = await status();
    expect(done).toMatchObject({ building: false, complete: true });
    expect(done.harnesses.find((h) => h.harness === "claude").total).toBeGreaterThanOrEqual(N);
    // Asking again starts no walk: the last one is still the one that ended.
    for (let i = 0; i < 3; i++) expect(await status()).toMatchObject({ building: false, complete: true, built_ms: done.built_ms });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await request.post("/api/import/index", { data: { action: "refresh" } });
  }
});

// A download is named after the session's title, cut to 80 units: a cut that
// falls inside a character outside the basic plane still gives a name a
// browser can read, for the Markdown file and the Keel file alike.
test("an export is named after a title cut inside an emoji", async ({ request }) => {
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  // The emoji's two halves are units 80 and 81 of the title.
  const title = `${"a".repeat(68)} שלום עולם 😀 and the rest of a long title`;
  expect(title.charCodeAt(79)).toBe(0xd83d);
  const { session } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, title } })).json();
  for (const [format, ext] of [["md", "md"], ["jsonl", "jsonl"]] as const) {
    const r = await request.get(`/api/sessions/${session.id}/export?format=${format}`);
    expect(r.status()).toBe(200);
    const star = /filename\*=UTF-8''([^;]+)/.exec(r.headers()["content-disposition"]!)![1]!;
    expect(decodeURIComponent(star)).toBe(`${title.slice(0, 79)}.${ext}`);
    expect(r.headers()["content-disposition"]).toContain(`.${ext}"`);
  }
  await request.delete(`/api/sessions/${session.id}`);
});

// Two copies of one Claude Code session; the original goes on. Update in the
// older copy's Export dialog brings that copy up to date, not the newest one.
// When the copy it is asked for cannot be updated (it went on here), nothing
// is appended to either.
test("Update in a copy's Export dialog updates that copy", async ({ page, request }) => {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = first.harnesses.find((x: any) => x.harness === "claude")?.store as string;
  test.skip(!store.includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  test.skip(!(await scripted(request)), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = String(Date.now());
  const cwd = join(SCRATCH, `copies-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const id = `c0b1e500-0000-4000-8000-${tag.padStart(12, "0")}`;
  const reply = (text: string) => ({ type: "assistant", message: { id: `m-${text}`, role: "assistant", model: "made-up-model", content: [{ type: "text", text }], stop_reason: "end_turn" } });
  const ask = (text: string) => ({ type: "user", message: { role: "user", content: text } });
  const path = claudeFile(join(store, cwd.replace(/[^A-Za-z0-9]/g, "-")), cwd, id, [ask(`Name a fruit ${tag}`), reply("Quince.")]);
  // The original gains a question and an answer, chained after what it holds.
  let records = 2;
  const grow = (q: string, a: string) => {
    for (const r of [ask(q), reply(a)]) {
      appendFileSync(path, JSON.stringify({ cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid: `${id}-${records}`, parentUuid: `${id}-${records - 1}`, ...r }) + "\n");
      records++;
    }
  };
  const copy = async (mode?: string) => (await (await request.post("/api/import", { data: { harness: "claude", id, path, mode, model: SCRIPTED } })).json()).session.id as string;
  const older = await copy();
  const newer = await copy("new");
  const texts = async (sid: string) => (await eventsOf(request, sid)).flatMap((e) => (e.kind === "assistant" ? e.data.blocks.map((b: any) => b.text) : e.kind === "user" ? [e.data.text] : []));
  grow("And its colour?", "Yellow.");

  await page.goto(`/s/${older}`);
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  const dialog = page.getByTestId("export-dialog");
  await expect(dialog.getByTestId("export-origin")).toContainText("the original has gone on since");
  await shoot(page, "import-10-update-this-copy");
  await dialog.getByTestId("export-update").click();
  await expect(dialog.getByTestId("export-origin")).not.toContainText("gone on since");
  await page.keyboard.press("Escape");
  // The page shows what the copy gained without a reload.
  await expect(page.getByTestId("transcript").getByText("Yellow.")).toBeVisible();
  expect(await texts(older)).toEqual([`Name a fruit ${tag}`, "Quince.", "And its colour?", "Yellow."]);
  expect(await texts(newer)).toEqual([`Name a fruit ${tag}`, "Quince."]);

  // The older copy goes on here, the original too: its dialog says so and offers
  // no Update, and asking anyway is refused without the other copy being updated in its place.
  await say(request, older, "And its season?");
  grow("And its shape?", "Round.");
  const before = { older: await texts(older), newer: await texts(newer) };
  await page.reload();
  await page.getByRole("button", { name: "Export or continue elsewhere" }).click();
  await expect(dialog.getByTestId("export-origin")).toContainText("and so has this copy here");
  await expect(dialog.getByTestId("export-update")).toHaveCount(0);
  await shoot(page, "import-11-update-not-offered");
  const asked = await request.post("/api/import", { data: { mode: "update", session_id: older } });
  expect([asked.status(), (await asked.json()).reason]).toEqual([409, "went_on"]);
  expect({ older: await texts(older), newer: await texts(newer) }).toEqual(before);
  // A copy that is not one of this source is not found, whatever else the request names.
  expect((await request.post("/api/import", { data: { mode: "update", session_id: "no-such-copy" } })).status()).toBe(404);

  // An update of many at once reaches a page that shows a copy it updated, without a reload.
  await page.goto(`/s/${newer}`);
  await expect(page.getByTestId("transcript").getByText("Quince.")).toBeVisible();
  const batch = await (await request.post("/api/import/batch", { data: { mode: "update", items: [{ harness: "claude", id, path }] } })).json();
  expect(batch.results[0]).toMatchObject({ ok: true, action: "updated", session_id: newer, imported_events: 4 });
  await expect(page.getByTestId("transcript").getByText("Round.")).toBeVisible();
  for (const sid of [older, newer]) await request.delete(`/api/sessions/${sid}`);
  rmSync(path, { force: true });
});
