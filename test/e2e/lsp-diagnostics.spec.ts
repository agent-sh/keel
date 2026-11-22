import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const turnsDone = async (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

// The text of each tool result of a session, in order: what the model was given.
const results = async (request: APIRequestContext, id: string): Promise<string[]> => {
  const r = await (await request.get(`/api/sessions/${id}`)).json();
  return r.events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results)
    .map((x: any) => (typeof x.content === "string" ? x.content : x.content.map((b: any) => b.text ?? "").join("\n")));
};
const calls = (list: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(list)}`;
const scripted = HAIKU.startsWith("scripted:");
const base = () => join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");

// Feature: diagnostics after an edit. The model edits a TypeScript file so
// that a type error appears: the edit's own result carries it (what the model
// reads) and the tool card shows it (what the owner reads); the edit that
// fixes it says so; an edit that changes neither adds nothing. The server is
// the workspace's own TypeScript, started at the first edit inside the
// session's sandbox, listed in Settings and booked to the session in Resources.
test("an edit's type error reaches the model and the tool card, and its fix", async ({ page, request }) => {
  test.skip(!scripted, "the edits are handed to the scripted model exactly");
  const modules = resolve("node_modules");
  const ts = JSON.parse(readFileSync(join(modules, "typescript/package.json"), "utf8")).version as string;
  test.skip(Number(ts.split(".")[0]) < 7, "the workspace's TypeScript is its own language server from version 7");
  const ws = join(base(), `lsp-${Date.now()}`);
  mkdirSync(join(ws, "src"), { recursive: true });
  symlinkSync(modules, join(ws, "node_modules"));
  writeFileSync(join(ws, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "esnext", target: "esnext", moduleResolution: "bundler", types: [] }, include: ["src"] }));
  writeFileSync(join(ws, "src/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  execFileSync("git", ["init", "-q"], { cwd: ws });

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const sandboxed = (await (await request.get("/api/permissions/settings")).json()).sandbox.available as boolean;
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", ...(sandboxed ? { sandbox: "workspace-write", network: false } : { sandbox: "off" }) } });
  const file = join(ws, "src/math.ts");

  // Turn 1: read it, then an edit that changes nothing a compiler minds, then the edit that breaks a type.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([
    { name: "Read", input: { file_path: file } },
    { name: "Edit", input: { file_path: file, old_string: "return a + b;", new_string: "return b + a;" } },
    { name: "Edit", input: { file_path: file, old_string: "return b + a;", new_string: 'return "sum" + a + b;' } },
  ]) } });
  await turnsDone(request, session.id, 1);
  const first = await results(request, session.id);
  expect(first).toHaveLength(3);
  expect(first[1]).not.toContain("<diagnostics"); // a clean edit pays nothing
  expect(first[2]).toContain('<diagnostics server="typescript">\n1 new error.\nsrc/math.ts:2:3 error TS2322 Type \'string\' is not assignable to type \'number\'.\n</diagnostics>');

  await page.goto(`/s/${session.id}`);
  const cards = page.locator('[data-testid="tool-call"][data-tool="Edit"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).getByTestId("tool-diagnostics")).toHaveCount(0);
  const row = cards.nth(1).getByTestId("tool-diagnostics");
  await expect(row).toHaveAttribute("data-state", "errors");
  await expect(row.getByTestId("tool-diagnostics-head")).toContainText("1 new error");
  await expect(row.getByTestId("tool-diagnostic")).toContainText("src/math.ts:2:3");
  await expect(row.getByTestId("tool-diagnostic")).toContainText("TS2322");
  // The block is the card's line, not raw text in the result shown.
  await expect(cards.nth(1)).not.toContainText("<diagnostics");
  await shoot(page, "lsp-01-error");

  // Turn 2: the fix.
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([
    { name: "Edit", input: { file_path: file, old_string: 'return "sum" + a + b;', new_string: "return a + b;" } },
  ]) } });
  await turnsDone(request, session.id, 2);
  expect((await results(request, session.id))[3]).toContain('<diagnostics server="typescript">\n1 fixed, no errors left.\n</diagnostics>');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(2).getByTestId("tool-diagnostics")).toHaveAttribute("data-state", "fixed");
  await expect(cards.nth(2).getByTestId("tool-diagnostics-head")).toContainText("1 fixed, no errors left");
  await shoot(page, "lsp-02-fixed");

  // The server: one, started by this session, confined as its commands are, a process of the session.
  const view = await (await request.get(`/api/lsp?cwd=${encodeURIComponent(ws)}`)).json();
  const tsServer = view.servers.find((s: any) => s.id === "typescript");
  expect(tsServer.found.from).toBe("workspace");
  expect(tsServer.running).toHaveLength(1);
  const run = tsServer.running[0];
  expect(run).toMatchObject({ state: "running", root: ws, started_by: session.id, pull: true });
  if (sandboxed) {
    expect(run.sandbox).toBe("workspace-write, no network");
    expect(run.argv.join(" ")).toMatch(/bwrap .*--unshare-net .*--bind \S+lsp-\d+ .* -- \S+tsc --lsp --stdio$/);
  }
  expect(view.stats).toMatchObject({ edits: 3, answered: 3, timed_out: 0, errors: 1, fixed: 1 });
  expect(view.stats.tokens).toBeGreaterThan(20);
  expect(view.stats.tokens).toBeLessThan(120);
  const res = await (await request.get(`/api/resources?refresh=1&session_id=${session.id}`)).json();
  expect(res.processes.some((p: any) => p.kind === "lsp" && p.session_id === session.id)).toBe(true);
  // Each wait is a span of its turn: the server, how long, what it found.
  const traces = (await (await request.get(`/api/debug/traces?session_id=${session.id}`)).json()).traces as any[];
  const spans = (await Promise.all(traces.map(async (t) => (await (await request.get(`/api/debug/traces/${t.trace_id}`)).json()).spans as any[]))).flat()
    .filter((s) => s.kind === "wait" && s.name === "diagnostics");
  expect(spans).toHaveLength(3);
  expect(spans.map((s) => s.attrs.errors).sort()).toEqual([0, 0, 1]);
  expect(spans.every((s) => s.attrs.server === "typescript" || s.attrs.server === "")).toBe(true);
  expect(spans.find((s) => s.attrs.errors === 1).attrs).toMatchObject({ timed_out: false, late: false, count: 1 });

  // Settings: the server, running, with where and how.
  await page.goto("/settings/lsp");
  await expect(page.getByTestId("toolkit-folder")).toContainText(ws.split("/").pop()!);
  const entry = page.locator('[data-testid="lsp-server"][data-name="TypeScript"]');
  await expect(entry).toHaveAttribute("data-state", "running");
  await entry.click();
  await expect(page.getByTestId("lsp-running")).toHaveAttribute("data-state", "running");
  if (sandboxed) await expect(page.getByTestId("lsp-sandbox")).toHaveText("workspace-write, no network");
  await expect(page.getByTestId("lsp-stats")).toContainText("1 error, 0 warnings, 1 fixed");
  await page.getByText("The command as it runs").click();
  if (sandboxed) await expect(page.getByTestId("lsp-argv")).toContainText("--unshare-net");
  await shoot(page, "lsp-03-settings");

  // Off for this folder: the next edit that breaks a type adds nothing, and the server ends.
  await page.getByTestId("lsp-folder-mode").getByTestId("seg-off").click();
  await expect.poll(async () => (await (await request.get(`/api/lsp?cwd=${encodeURIComponent(ws)}`)).json()).in_force).toBe("off");
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([
    { name: "Edit", input: { file_path: file, old_string: "return a + b;", new_string: 'return "off" + a + b;' } },
  ]) } });
  await turnsDone(request, session.id, 3);
  expect((await results(request, session.id))[4]).not.toContain("<diagnostics");
  await request.patch("/api/settings", { data: { diagnostics: { workspaces: { [ws]: null } } } });
  await request.delete(`/api/sessions/${session.id}`);
});

// A server that is slow, floods or dies never holds an edit: the wait is
// bounded, the late answer rides on the next call on the file, and a failed
// server is paused before it is started again.
test("a slow, a flooding and a crashing server: the edit is never held", async ({ page, request }) => {
  test.skip(!scripted, "the edits are handed to the scripted model exactly");
  const ws = join(base(), `lsp-standin-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const standin = resolve("test/e2e/fixtures/lsp-standin.ts");
  const server = (mode: string, ext: string) => ({ command: ["bun", standin, mode, "1500"], extensions: { [ext]: "plaintext" } });
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  expect((await request.patch("/api/settings", { data: { diagnostics: { wait_ms: 400, servers: { "standin-slow": server("slow", ".slow"), "standin-flood": server("flood", ".flood"), "standin-crash": server("crash", ".crash") } } } })).ok()).toBe(true);
  try {
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    const write = (name: string, content: string) => ({ name: "Write", input: { file_path: join(ws, name), content } });

    // Slow: the result says the file is not checked yet; the answer comes with the next read of it.
    const t0 = Date.now();
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([
      write("a.slow", "fine\nthis line is an ERROR\n"),
      { name: "Bash", input: { command: "sleep 2.5; echo waited" } },
      { name: "Read", input: { file_path: join(ws, "a.slow") } },
    ]) } });
    await turnsDone(request, session.id, 1);
    const slow = await results(request, session.id);
    expect(slow[0]).toContain('<diagnostics server="standin-slow">\nNot checked yet: a.slow (the language server has not answered).');
    expect(slow[1]).not.toContain("<diagnostics"); // a command's result carries no file's diagnostics
    expect(slow[2]).toContain("From an earlier edit (the language server answered after its result was written): 1 new error.\na.slow:2:17 error STAND1 the line says ERROR");
    expect(Date.now() - t0).toBeLessThan(15_000);

    // Flood and crash: nothing is added, the edit is not held, each failure is in the errors table once.
    const t1 = Date.now();
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: calls([write("a.flood", "an ERROR\n"), write("a.crash", "an ERROR\n"), write("b.crash", "an ERROR\n")]) } });
    await turnsDone(request, session.id, 2);
    expect(Date.now() - t1).toBeLessThan(10_000);
    const rest = (await results(request, session.id)).slice(3);
    expect(rest).toHaveLength(3);
    for (const r of rest) expect(r).not.toContain("1 new error");
    const failures = async () => ((await (await request.get("/api/errors")).json()).errors as any[]).slice(0, -errorsBefore || undefined).map((e) => String(e.message)).filter((m) => m.startsWith("language server standin-"));
    await expect.poll(async () => (await failures()).some((m) => /standin-flood failed: it flooded: \d+ messages/.test(m)), { timeout: 20_000 }).toBe(true);
    expect((await failures()).filter((m) => m.includes("standin-crash"))).toHaveLength(1); // the second file found it paused, and did not start it again
    const view = await (await request.get(`/api/lsp?cwd=${encodeURIComponent(ws)}`)).json();
    const crash = view.servers.find((s: any) => s.id === "standin-crash").running[0];
    expect(crash.state).toBe("failed");
    expect(crash.error).toContain("it exited with code 3");
    expect(crash.retry_in_ms).toBeGreaterThan(0);
    // No stand-in is left running by the flood: it was ended.
    expect(view.servers.find((s: any) => s.id === "standin-flood").running[0].pid).toBeUndefined();

    await page.goto("/settings/lsp");
    await page.locator('[data-testid="lsp-server"][data-name="standin-crash"]').click();
    await expect(page.getByTestId("lsp-running")).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("lsp-run-error")).toContainText("it exited with code 3");
    await shoot(page, "lsp-04-failed");
    await request.delete(`/api/sessions/${session.id}`);
  } finally {
    await request.patch("/api/settings", { data: { diagnostics: { servers: { "standin-slow": null, "standin-flood": null, "standin-crash": null } } } });
    expect(existsSync(ws)).toBe(true);
  }
});
