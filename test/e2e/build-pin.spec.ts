import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a daemon upgrade does not make a live session pay for its whole
// context again. A session keeps the tools and system prompt it was last
// sent, byte for byte, across the upgrade, and takes the new build's when its
// cache is cold anyway (a compaction here), when the owner asks, or at once
// when waiting would be wrong (a tool the new build removed). The spec runs
// its own daemons on a scratch state folder, on the scripted stand-in, which
// writes each request it gets to a file; the "new build" is KEEL_TEST_BUILD:
// another build id, a line added to the core block, another Bash description.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const LINE = "Build two: check the diff before you say it is done.";
const TWO = { id: "build-two", core: LINE, tools: { Bash: { description: "Runs a shell command, as build two words it." } } };
const THREE = { ...TWO, id: "build-three", tools: { ...TWO.tools, TodoWrite: { remove: true } } };

function daemon(state: string, build?: unknown): Promise<{ proc: ChildProcess; url: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_DRAIN_MS: "300", KEEL_RESUME_GAP_MS: "0",
    KEEL_SCRIPTED_LOG: join(state, "requests.jsonl"), KEEL_SCRIPTED_CACHE: "prefix", KEEL_CONFIG_DIR: join(state, "config"),
    KEEL_IMPORT_HOME: join(state, "home"), KEEL_DESKTOP_NOTIFY: "off", TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
    KEEL_TEST_BUILD: build ? JSON.stringify(build) : undefined,
  };
  delete env.KEEL_MCP_CONFIG;
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

test("a session keeps its tools and prompt across an upgrade and takes the new build's at a compaction", async ({ page }) => {
  test.setTimeout(240_000);
  const state = join(ROOT, `build-pin-${Date.now()}`);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  const log = join(state, "requests.jsonl");
  type Sent = { session: string; purpose: string; system: string; tools: string[]; tools_hash: string };
  const sent = (id: string, purpose = "turn"): Sent[] =>
    (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sent).filter((r) => r.session === id && r.purpose === purpose);
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const ended = (id: string) => call(`/api/sessions/${id}`).then((s) => s.events.filter((e: any) => e.kind === "turn_end").length);
  const turn = async (id: string, text: string) => {
    const n = await ended(id);
    await call(`/api/sessions/${id}/messages`, { text });
    await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(n + 1);
  };
  // A session with a history: three turns, one of them long.
  const open = async () => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in" });
    await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
    for (const text of ["hello", "script:grow", "hello again"]) await turn(session.id, text);
    return session.id as string;
  };
  const restart = async (build: unknown) => {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state, build);
  };
  try {
    const one = (await call("/api/bootstrap")).build_id as string;
    const [kept, asked, urgent, auto] = [await open(), await open(), await open(), await open()];
    const before = sent(kept).at(-1)!;
    const autoBefore = sent(auto).at(-1)!;
    expect(before.system).not.toContain(LINE);
    expect((await call(`/api/sessions/${kept}/build`)).pinned).toMatchObject({ build: one });

    // The upgrade. The session's next turn, a tool call included, sends the
    // tools and prompt of the build before, byte for byte, and the call runs.
    await restart(TWO);
    expect((await call("/api/bootstrap")).build_id).toBe("build-two");
    await turn(kept, 'script:calls [{"name":"Bash","input":{"command":"echo pinned-$((40+2))"}}]');
    const after = sent(kept).slice(-2);
    expect(after.map((r) => r.system === before.system), "the prompt after the upgrade is the one before it").toEqual([true, true]);
    expect(after.map((r) => r.tools_hash), "the tool definitions after the upgrade are the ones before it").toEqual([before.tools_hash, before.tools_hash]);
    const said = (await call(`/api/sessions/${kept}`)).events.filter((e: any) => e.kind === "assistant").at(-1).data.blocks[0].text;
    expect(said, "the pinned definition ran this build's Bash").toContain("pinned-42");
    expect((await call(`/api/telemetry?session_id=${kept}`)).breaks, "no cache break across the upgrade").toEqual([]);
    expect(await call(`/api/sessions/${kept}/build`)).toMatchObject({ build: "build-two", pinned: { build: one }, waiting: { blocks: ["core"], tools: ["Bash"] }, known: true, adoptions: [] });

    // A session that starts on the new build carries its tools and prompt.
    const { session: born } = await call("/api/sessions", { model: "scripted:stand-in" });
    await turn(born.id, "hello");
    const fresh = sent(born.id).at(-1)!;
    expect(fresh.system).toContain(LINE);
    expect(fresh.tools_hash).not.toBe(before.tools_hash);
    expect(await call(`/api/sessions/${born.id}/build`)).toMatchObject({ pinned: { build: "build-two" }, waiting: { blocks: [], tools: [] } });

    // The owner sees it in the context popup of the pinned session.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${asked}`);
    await turn(asked, "hello on build two");
    await page.getByTestId("context-meter").click();
    const pin = page.getByTestId("build-pin");
    await expect(pin).toContainText(`Tools and prompt are from build ${one}`);
    await expect(page.getByTestId("build-pin-waiting")).toContainText("This build (build-two) changed the prompt (core) and the tools (Bash)");
    await shoot(page, "build-pin-waiting");

    // A compaction rewrites the prefix anyway. Its own request still reads the
    // old one; the first request after it carries the new build's.
    await call(`/api/sessions/${kept}/compact`, {});
    const summary = sent(kept, "summary").at(-1)!;
    expect([summary.system === before.system, summary.tools_hash]).toEqual([true, before.tools_hash]);
    await turn(kept, "after the compaction");
    const now = sent(kept).at(-1)!;
    expect(now.system).toContain(LINE);
    expect(now.tools_hash, "the tools after the compaction are the new build's").toBe(fresh.tools_hash);
    expect(await call(`/api/sessions/${kept}/build`)).toMatchObject({
      pinned: { build: "build-two" }, waiting: { blocks: [], tools: [] },
      adoptions: [{ reason: "a compaction", from_build: one, to_build: "build-two", blocks: ["core"], tools: ["Bash"] }],
    });
    // The break is the compaction's, and its detail names what the build changed and why it was taken then.
    const breaks = (await call(`/api/telemetry?session_id=${kept}`)).breaks;
    expect(breaks.map((b: any) => [b.cause, b.count])).toEqual([["compaction", 1]]);
    expect(breaks[0].details[0].detail).toBe("tools (Bash); system (core); history; build build-two taken: a compaction");

    // The usual way there: the context crosses its line during a turn. The
    // summary reads the old prefix, and the turn goes on with the new build's.
    await call(`/api/sessions/${auto}`, { settings: { compact_at: 1_000 } }, "PATCH");
    await turn(auto, "over the line");
    expect(sent(auto, "summary").map((r) => [r.system === autoBefore.system, r.tools_hash])).toEqual([[true, autoBefore.tools_hash]]);
    expect([sent(auto).at(-1)!.system.includes(LINE), sent(auto).at(-1)!.tools_hash]).toEqual([true, fresh.tools_hash]);
    expect((await call(`/api/sessions/${auto}/build`)).adoptions.map((a: any) => a.reason)).toEqual(["a compaction"]);

    // The owner asks from the popup: the next request carries the new build's, and the break names the cause.
    await page.getByTestId("build-adopt").click();
    await expect(page.getByTestId("build-pin-taken")).toContainText("Now on this build's tools and prompt (the owner asked)");
    await expect(pin).toHaveCount(0);
    await shoot(page, "build-pin-taken");
    await page.keyboard.press("Escape");
    await turn(asked, "after asking");
    expect(sent(asked).at(-1)!.system).toContain(LINE);
    expect(sent(asked).at(-1)!.tools_hash).toBe(fresh.tools_hash);
    expect((await call(`/api/telemetry?session_id=${asked}`)).breaks.map((b: any) => [b.cause, b.details[0].detail])).toEqual([["prefix_changed", "tools (Bash); system (core); build build-two taken: the owner asked"]]);
    // The command says so when there is nothing left to take.
    await page.getByTestId("composer").fill("/adopt-build");
    await page.getByTestId("composer").press("Enter");
    await expect(page.locator(".k-tip")).toContainText("already uses this build's tools and prompt");

    // A build that removed a tool: a pinned definition it cannot serve is not
    // offered. The session takes the build's tools and prompt at once.
    await restart(THREE);
    await turn(urgent, "hello on build three");
    const cut = sent(urgent).at(-1)!;
    expect(sent(urgent).at(-2)!.tools).toContain("TodoWrite");
    expect(cut.tools).not.toContain("TodoWrite");
    expect(cut.system).toContain(LINE);
    expect((await call(`/api/sessions/${urgent}/build`)).adoptions[0]).toMatchObject({ reason: "TodoWrite is gone from this build", from_build: one, to_build: "build-three", blocks: ["core"] });
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    if (test.info().errors.length === 0) rmSync(state, { recursive: true, force: true });
  }
});
