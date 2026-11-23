import { expect, test, type APIRequestContext } from "./isolate.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a session of another harness is found by what was said in it. The import sheet's
// search reads what the transcripts say too (a reply, a command), not only their titles, folders
// and prompts, and marks a row found that way.
// Run the daemon with KEEL_IMPORT_* at scratch stores (scripts/dev.sh does): this test writes there.

// A Claude Code and a Codex session whose titles and prompts say nothing of what was decided in
// their replies: the reply's words are the test's own tag. Skips where the stores are not scratch ones.
async function stores(request: APIRequestContext) {
  const first = await (await request.get("/api/import/sessions?limit=1")).json();
  const store = (h: string) => first.harnesses.find((x: any) => x.harness === h)?.store as string | undefined;
  test.skip(!store("claude")?.includes("keel-work") || !store("codex")?.includes("keel-work"), "needs scratch import stores (KEEL_IMPORT_*)");
  const tag = `k${Date.now().toString(36)}`;
  const cwd = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `elsewhere-${tag}`);
  mkdirSync(cwd, { recursive: true });
  const t = Date.now() - 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  const cid = `c1a0de00-0000-4000-8000-${String(Date.now()).slice(-12)}`;
  const cdir = join(store("claude")!, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(cdir, { recursive: true });
  const base = { cwd, sessionId: cid, version: "2.1.300", gitBranch: "main", isSidechain: false, userType: "external", entrypoint: "cli" };
  const cpath = join(cdir, `${cid}.jsonl`);
  writeFileSync(cpath, [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: iso(t), message: { role: "user", content: "How should the importer back off?" } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: iso(t + 1000), message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `We settled on a retry budget ${tag} of five attempts.` }], stop_reason: "end_turn" } },
    { type: "ai-title", aiTitle: "Tune the importer", sessionId: cid },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  // A Codex session, the same: the word is only in the reply.
  const xid = `01a2feed-0000-7000-8000-${String(Date.now()).slice(-12)}`;
  const d = new Date();
  const xdir = join(store("codex")!, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(xdir, { recursive: true });
  const line = (i: number, type: string, payload: unknown) => JSON.stringify({ timestamp: iso(t + i), type, payload });
  const xpath = join(xdir, `rollout-${iso(t).slice(0, 19).replace(/:/g, "-")}-${xid}.jsonl`);
  writeFileSync(xpath, [
    line(0, "session_meta", { id: xid, timestamp: iso(t), cwd, originator: "codex_cli_rs", cli_version: "0.169.0", source: "cli" }),
    line(1, "turn_context", { cwd, model: "gpt-6.1-sol" }),
    line(2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Pick a compression for the archive." }] }),
    line(3, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `zstd ${tag} it is: level 19.` }] }),
  ].join("\n") + "\n");
  await request.get("/api/import/sessions?limit=1&refresh=1");
  return { tag, done: () => { rmSync(cpath, { force: true }); rmSync(xpath, { force: true }); } };
}

// The import sheet: the reply's words find the Claude Code session, marked as found in the conversation.
test("the import sheet finds a session by what its replies say", async ({ page, request }) => {
  const { tag, done } = await stores(request);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("Import sessions");
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("import-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("import-tab-claude").click();
  await sheet.getByTestId("import-search").fill(`retry budget ${tag}`);
  // (The count first: the list before the search is applied holds every session.)
  await expect(sheet.getByTestId("import-total")).toHaveText("1 session", { timeout: 15_000 });
  const row = sheet.getByTestId("import-row").filter({ hasText: "Tune the importer" });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("import-in-text")).toHaveText("in the conversation");
  await shoot(page, "search-elsewhere-01-import-sheet");
  await page.keyboard.press("Escape");
  done();
});
