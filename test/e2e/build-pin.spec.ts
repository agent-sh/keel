import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startFakeMessages } from "./fixtures/fake-messages.ts";
import { specEnv, TACIT_STANDIN } from "./own-daemon.ts";
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

function daemon(state: string, build?: unknown, extra: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string }> {
  // An environment made from nothing (own-daemon.ts); the MCP servers are the config folder's own.
  const env = specEnv(state, {
    KEEL_RESUME_GAP_MS: "0", KEEL_SCRIPTED_LOG: join(state, "requests.jsonl"), KEEL_SCRIPTED_CACHE: "prefix", TACIT_BIN: TACIT_STANDIN,
    KEEL_TEST_BUILD: build ? JSON.stringify(build) : undefined, ...extra,
  }, join(state, "work"));
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(state, "state"), "--workspace", join(state, "work")], { env, stdio: ["ignore", "pipe", "pipe"] });
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

type Sent = { session: string; purpose: string; system: string; tools: string[]; tools_hash: string };
// A scratch state folder and its daemon, started again as another build by `restart`.
async function rig(name: string, env: Record<string, string> = {}, before?: (state: string) => void) {
  const state = join(ROOT, `${name}-${Date.now()}`);
  for (const d of ["state", "work", "config", "home"]) mkdirSync(join(state, d), { recursive: true });
  before?.(state);
  const log = join(state, "requests.jsonl");
  let d = await daemon(state, undefined, env);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const ended = (id: string) => call(`/api/sessions/${id}`).then((s) => s.events.filter((e: any) => e.kind === "turn_end").length);
  const turn = async (id: string, text: string) => {
    const n = await ended(id);
    await call(`/api/sessions/${id}/messages`, { text });
    await expect.poll(() => ended(id), { timeout: 30_000 }).toBe(n + 1);
  };
  return {
    state, call, turn,
    url: () => d.url,
    // The scripted provider's requests of one session.
    sent: (id: string, purpose = "turn"): Sent[] =>
      (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sent).filter((r) => r.session === id && r.purpose === purpose),
    // A session with a history: three turns, one of them long.
    open: async (model = "scripted:stand-in", texts = ["hello", "script:grow", "hello again"]) => {
      const { session } = await call("/api/sessions", { model });
      await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
      for (const text of texts) await turn(session.id, text);
      return session.id as string;
    },
    restart: async (build: unknown) => {
      d.proc.kill("SIGTERM");
      await exited(d.proc);
      d = await daemon(state, build, env);
    },
    close: async () => {
      d.proc.kill("SIGKILL");
      await exited(d.proc);
      if (test.info().errors.length === 0) rmSync(state, { recursive: true, force: true });
    },
  };
}

test("a session keeps its tools and prompt across an upgrade and takes the new build's at a compaction", async ({ page }) => {
  test.setTimeout(240_000);
  const r = await rig("build-pin");
  const { call, turn, sent, open, restart } = r;
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
    await page.goto(`${r.url()}/s/${asked}`);
    await turn(asked, "hello on build two");
    await page.getByTestId("context-meter").click();
    const pin = page.getByTestId("build-pin");
    await expect(pin).toContainText(`Tools and prompt are from build ${one}`);
    await expect(page.getByTestId("build-pin-waiting")).toContainText("This build (build-two) changed the prompt (core) and the tools (Bash)");
    await expect(page.getByTestId("build-adopt-cost")).toHaveText(/^Rewrites about [\d.]+k? tokens at the next request\.$/);
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
    // A call to the tool that went says why, not only that there is none.
    await turn(urgent, 'script:calls [{"name":"TodoWrite","input":{"todos":[]}}]');
    const results = (await call(`/api/sessions/${urgent}`)).events.filter((e: any) => e.kind === "tool_result").at(-1).data.results;
    expect(results[0].content).toBe("TodoWrite was removed by an upgrade of Keel and is no longer available. Use the tools you have now.");
  } finally {
    await r.close();
  }
});

test("a session behind too long takes the build's, and every session can take it at once", async ({ page }) => {
  test.setTimeout(240_000);
  const r = await rig("build-age");
  const { call, turn, sent, open, restart } = r;
  try {
    const one = (await call("/api/bootstrap")).build_id as string;
    const [aged, other] = [await open(), await open()];
    await restart(TWO);
    for (const id of [aged, other]) await turn(id, "hello on build two");
    expect(sent(aged).at(-1)!.system).not.toContain(LINE);
    // What taking the build's everywhere would cost: both sessions, with their contexts.
    const pins = await call("/api/build/pins");
    expect(pins.sessions.map((s: any) => s.id).sort()).toEqual([aged, other].sort());
    expect(pins.sessions.every((s: any) => s.warm && s.tokens > 500)).toBe(true);
    expect(pins.tokens).toBe(pins.sessions.reduce((n: number, s: any) => n + s.tokens, 0));
    const state = await call(`/api/sessions/${aged}/build`);
    expect(state.takes_at - state.behind_since).toBe(24 * 3_600_000);

    // The owner shortens the longest a session may stay behind: the next request takes the build's.
    expect((await call("/api/settings", { build_pin: { max_age_hours: 0.0001 } }, "PATCH")).settings.build_pin.max_age_hours).toBe(0.0001);
    await page.waitForTimeout(600);
    await turn(aged, "past the age");
    expect(sent(aged).at(-1)!.system).toContain(LINE);
    expect((await call(`/api/sessions/${aged}/build`)).adoptions[0]).toMatchObject({ reason: "its tools and prompt were more than 0.0001 hours behind", from_build: one, to_build: "build-two", blocks: ["core"], tools: ["Bash"] });
    await call("/api/settings", { build_pin: { max_age_hours: 24 } }, "PATCH");

    // Settings > Daemon: the setting, the sessions still behind and what taking the build's in all of them costs.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${r.url()}/settings/daemon`);
    await expect(page.getByTestId("build-pin-hours")).toHaveValue("24");
    const all = page.getByTestId("build-adopt-all");
    await expect(all).toBeEnabled();
    await expect(page.getByText(/1 open session\. Taking this build's now rewrites about [\d.]+k? tokens/)).toBeVisible();
    await all.scrollIntoViewIfNeeded();
    await shoot(page, "build-pin-settings");
    await all.click();
    await expect(page.getByTestId("confirm")).toContainText(/1 session carries an earlier build's tools or prompt\. Taking this build's rewrites about [\d.]+k? tokens/);
    await shoot(page, "build-pin-all-confirm");
    await page.getByTestId("confirm").getByRole("button", { name: "Use this build's" }).click();
    await expect(page.getByTestId("daemon-panel").getByText("1 session takes this build's tools and prompt at the next request.")).toBeVisible();
    await expect(all).toBeDisabled();
    await expect.poll(async () => (await call(`/api/sessions/${other}/build`)).asked).toBe(true);
    await turn(other, "after all were asked");
    expect(sent(other).at(-1)!.system).toContain(LINE);
    expect((await call(`/api/sessions/${other}/build`)).adoptions[0].reason).toBe("the owner asked");
    expect(await call("/api/build/pins")).toMatchObject({ sessions: [], unknown: 0, asked: 0 });
  } finally {
    await r.close();
  }
});

// On a wire that defers tools the provider puts a loaded tool's definition
// where the conversation references it, so that definition is part of the
// cached prefix from there on. The spec talks to a stand-in for the Messages
// wire that records each request body.
test("a deferred tool the conversation loaded keeps its definition across an upgrade", async () => {
  test.setTimeout(240_000);
  const fake = await startFakeMessages();
  const r = await rig("build-loaded", {}, (state) => {
    writeFileSync(join(state, "config", "providers.toml"),
      `[[endpoint]]\nid = "fanth"\nlabel = "Stand-in"\nwire = "anthropic_messages"\nbase_url = "${fake.url}"\nbilling = "free"\nmodels = ["claude-fake-1"]\n\n[endpoint.model."claude-fake-1"]\ncontext = 200000\noutput = 8000\ntools = true\nimages = false\n`);
    writeFileSync(join(state, "config", "mcp.json"), JSON.stringify({ servers: { echo: { command: "bun", args: [resolve("test/e2e/fixtures/echo-mcp.ts")] } } }));
    writeFileSync(join(state, "work", "AGENTS.md"), "# Rules\n\nAlways answer in one line.\n");
  });
  const { call, turn, open, restart } = r;
  const ready = () => expect.poll(async () => (await call("/api/mcp/servers")).servers.find((s: any) => s.name === "echo")?.state, { timeout: 30_000 }).toBe("ready");
  // The requests of one session, by a word in its prompts.
  const of = (tag: string) => fake.bodies.filter((b) => JSON.stringify(b.messages).includes(tag));
  const def = (b: any, name: string) => b.tools.find((t: any) => t.name === name);
  try {
    await ready();
    // The model loads the echo tool: the tool search answers with a reference to it.
    const id = await open("fanth:claude-fake-1", ["TAG-loaded LOAD-TOOL mcp__echo__echo"]);
    const before = of("TAG-loaded").at(-1)!;
    expect(JSON.stringify(before.messages)).toContain('{"type":"tool_reference","tool_name":"mcp__echo__echo"}');
    expect(def(before, "mcp__echo__echo")).toMatchObject({ defer_loading: true, description: "Echo the given text back, prefixed with 'echo:'." });

    // Another session in the same folder reads the folder's instruction block
    // from the cache: the two prompts differ only in the last block, the
    // session's own (its artifacts folder), which carries no breakpoint.
    await open("fanth:claude-fake-1", ["TAG-second hello"]);
    const [mine, theirs] = [before.system as any[], of("TAG-second").at(-1)!.system as any[]];
    expect(mine.map((b) => !!b.cache_control)).toEqual([true, true, false]);
    expect(mine[1].text).toContain("Always answer in one line.");
    expect(JSON.stringify(mine.slice(0, 2)), "the shared and the folder's blocks are the same bytes").toBe(JSON.stringify(theirs.slice(0, 2)));
    expect([mine[2].text.startsWith("\nArtifacts: "), mine[2].text === theirs[2].text]).toEqual([true, false]);

    // The next build words both of the server's tools another way.
    await restart({ id: "build-two", tools: { mcp__echo__echo: { description: "Echo, as build two words it." }, mcp__echo__add: { description: "Add, as build two words it." } } });
    await ready();
    await turn(id, "TAG-loaded again");
    const after = of("TAG-loaded").at(-1)!;
    expect(def(after, "mcp__echo__echo"), "the loaded tool is sent as it was loaded").toEqual(def(before, "mcp__echo__echo"));
    expect(def(after, "mcp__echo__add").description, "a tool never loaded follows the build").toBe("Add, as build two words it.");
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(JSON.stringify(after.tools.filter((t: any) => !t.defer_loading))).toBe(JSON.stringify(before.tools.filter((t: any) => !t.defer_loading)));
    // A session that loads it on the new build gets the new words.
    const fresh = await open("fanth:claude-fake-1", ["TAG-fresh LOAD-TOOL mcp__echo__echo"]);
    expect(def(of("TAG-fresh").at(-1)!, "mcp__echo__echo").description).toBe("Echo, as build two words it.");
    expect(fresh).not.toBe(id);
  } finally {
    await r.close();
    fake.server.close();
  }
});
