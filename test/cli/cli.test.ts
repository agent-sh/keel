// The command line, end to end: the compiled binary, a real daemon it starts
// (`keel serve`) or runs inside itself (`keel run` with none answering), and
// the scripted stand-in model, so every path is deterministic and free.
// Run: bun test ./test/cli   (builds the binary first)
// Each run works in a folder of its own, so two runs at once do not collide:
// KEEL_CLI_SCRATCH names it (default: one per process, removed at the end).
// KEEL_CLI_BIN runs a binary built before instead of building one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRATCH = process.env.KEEL_CLI_SCRATCH || join(process.env.HOME!, ".cache/keel-work/bun", `cli-test-${process.pid}`);
const BIN = join(SCRATCH, "keel");
const WS = join(SCRATCH, "ws");
const ENV = {
  ...process.env,
  KEEL_SCRIPTED_PROVIDER: "1",
  KEEL_DEFAULT_MODEL: "scripted:stand-in",
  KEEL_URL: "",
  KEEL_IMPORT_CLAUDE_DIR: join(SCRATCH, "claude"),
  KEEL_IMPORT_CODEX_DIR: join(SCRATCH, "codex"),
  KEEL_IMPORT_KEEL_DB: join(SCRATCH, "none.db"),
  KEEL_IMPORT_AGY_DIR: join(SCRATCH, "agy"),
  KEEL_BROWSER: "true",
  KEEL_PHONE_SOCKET: join(SCRATCH, "phone.sock"), // never the owner's Hermes gateway
};

type Ran = { code: number; out: string; err: string };
async function keel(args: string[], o: { state: string; stdin?: string; cwd?: string; signalAfterMs?: number; env?: Record<string, string> } ): Promise<Ran> {
  const p = Bun.spawn([BIN, ...args], {
    cwd: o.cwd ?? WS,
    env: { ...ENV, KEEL_STATE_DIR: o.state, ...o.env },
    stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (o.signalAfterMs) setTimeout(() => p.kill("SIGINT"), o.signalAfterMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const json = (s: string) => JSON.parse(s);
const lines = (s: string) => s.trim().split("\n").filter(Boolean).map(json);

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  if (process.env.KEEL_CLI_BIN) return symlinkSync(process.env.KEEL_CLI_BIN, BIN);
  const b = Bun.spawnSync(["bun", "scripts/build.ts", BIN], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (b.exitCode !== 0) throw new Error(`build failed: ${b.stderr}`);
}, 120_000);
// A run's own default folder goes with it; a named one is the caller's to keep.
afterAll(() => { if (!process.env.KEEL_CLI_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true }); });

describe("help, usage and completion", () => {
  const state = join(SCRATCH, "state-help");
  test("help per command, a short usage for an unknown one, bash completion", async () => {
    const top = await keel(["--help"], { state });
    expect(top.code).toBe(0);
    for (const c of ["run", "send", "sessions", "show", "stop", "resume", "import", "completion"]) expect(top.out).toContain(`  ${c} `);
    const runHelp = await keel(["run", "--help"], { state });
    expect(runHelp.code).toBe(0);
    expect(runHelp.out).toContain("--output-format");
    const unknown = await keel(["frobnicate"], { state });
    expect(unknown.code).toBe(3);
    expect(unknown.err).toContain("unknown command");
    const bad = await keel(["run", "--bogus"], { state });
    expect(bad.code).toBe(3);
    expect(bad.err).toContain("keel run [PROMPT]");

    const script = await keel(["completion", "bash"], { state });
    expect(script.code).toBe(0);
    writeFileSync(join(SCRATCH, "completion.bash"), script.out);
    const probe = Bun.spawnSync(["bash", "-c", `PATH=${SCRATCH}:$PATH; source ${SCRATCH}/completion.bash; COMP_WORDS=(keel ru); COMP_CWORD=1; _keel; echo "\${COMPREPLY[@]}"; COMP_WORDS=(keel run --output-f); COMP_CWORD=2; _keel; echo "\${COMPREPLY[@]}"`], { env: { ...ENV, KEEL_STATE_DIR: state } });
    const [words, flags] = probe.stdout.toString().trim().split("\n");
    expect(words).toContain("run");
    expect(flags).toBe("--output-format");
  });
});

describe("an address another program answers on", () => {
  const state = join(SCRATCH, "state-other");
  test("is said to be no Keel daemon, not shown as the daemon's refusal", async () => {
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ error: "Not found" }, { status: 404 }) });
    try {
      const url = `http://127.0.0.1:${other.port}`;
      for (const args of [["status"], ["restart", "--no-wait"], ["sessions"]]) {
        const r = await keel([...args, "--url", url], { state });
        expect(r.code).not.toBe(0);
        expect(r.err).toContain(`no Keel daemon answers at ${url}`);
        expect(r.err).not.toContain("Not found");
      }
    } finally {
      other.stop(true);
    }
  });
});

describe("keel run with no daemon", () => {
  const state = join(SCRATCH, "state-headless");
  test("prints the answer, a result object, or stream lines, and exits by the outcome", async () => {
    const text = await keel(["-p", "hello"], { state });
    expect(text.code).toBe(0);
    expect(text.out).toBe("Scripted reply.\n");

    const one = await keel(["run", "--output-format", "json", "again"], { state });
    expect(one.code).toBe(0);
    const r = json(one.out);
    expect(r).toMatchObject({ type: "result", subtype: "success", is_error: false, result: "Scripted reply.", outcome: "success", num_turns: 1, on_ask: "deny" });
    expect(r.total_cost_usd).toBeGreaterThan(0);

    // Piped input next to a prompt is context; partial text streams.
    const stream = await keel(["run", "--stream-json", "--include-partial-messages", "sum it up"], { state, stdin: "the piped context\n" });
    expect(stream.code).toBe(0);
    const ls = lines(stream.out);
    expect(ls[0]).toMatchObject({ type: "system", subtype: "init", model: "scripted:stand-in" });
    expect(ls.find((l) => l.type === "user").message.content[0].text).toContain("<stdin>\nthe piped context\n</stdin>");
    expect(ls.some((l) => l.type === "stream_event" && l.event.delta.type === "text_delta")).toBe(true);
    expect(ls.some((l) => l.type === "assistant")).toBe(true);
    expect(ls.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // The workbench's session continues later: --continue picks the newest of the folder.
    const cont = await keel(["run", "-c", "--output-format", "json", "one more"], { state });
    expect(json(cont.out).session_id).toBe(ls[0].session_id);

    // A card nobody can answer is refused, and the turn goes on.
    const ask = await keel(["-p", "--permission-mode", "ask", "script:long-tool"], { state });
    expect(ask.code).toBe(0);
    expect(ask.out).toBe("Finished after the tool.\n");
    expect(ask.err).toContain("refused 1");
    const exitAsk = await keel(["-p", "--on-ask", "exit", "x"], { state });
    expect(exitAsk.code).toBe(3);

    const slow = await keel(["run", "--output-format", "json", "--timeout", "1", "script:slow"], { state });
    expect(slow.code).toBe(124);
    expect(json(slow.out)).toMatchObject({ subtype: "timeout", timed_out: true });

    const sig = await keel(["-p", "script:slow"], { state, signalAfterMs: 1200 });
    expect(sig.code).toBe(130);

    const none = await keel(["-p"], { state });
    expect(none.code).toBe(3);
  }, 60_000);
});

describe("client commands against a running daemon", () => {
  const state = join(SCRATCH, "state-daemon");
  let daemon: Bun.Subprocess<"ignore", "pipe", "ignore">;
  const k = (args: string[], o: { stdin?: string; signalAfterMs?: number } = {}) => keel(args, { state, ...o });

  beforeAll(async () => {
    daemon = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
    const reader = daemon.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
  }, 30_000);
  afterAll(() => daemon?.kill("SIGTERM"));

  test("run, approve, resume, idempotency", async () => {
    // The daemon is found from the state folder alone.
    expect(json(readFileSync(join(state, "daemon.lock"), "utf8")).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const quick = await k(["run", "--json", "hi"]);
    expect(quick.code).toBe(0);
    const id = json(quick.out).session_id;

    const again = await k(["run", "--json", "--idempotency-key", "k1", "keyed"]);
    const replay = await k(["run", "--json", "--idempotency-key", "k1", "keyed"]);
    expect(json(replay.out)).toMatchObject({ session_id: json(again.out).session_id, replayed: true });
    // The same key with another prompt is refused, and nothing is sent.
    const reused = await k(["run", "--json", "--idempotency-key", "k1", "not keyed"]);
    expect([reused.code, reused.err]).toEqual([3, expect.stringContaining("different request")]);

    // A run's result is its own turn's, also when later turns are read in the same batch.
    const own = json((await k(["run", "--json", "--idempotency-key", "q1", "first"])).out).session_id;
    const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    await fetch(`${url}/api/sessions/${own}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "script:refuse", mode: "queue" }) });
    expect((await k(["run", "--wait", "--json", "-r", own, "last"])).code).toBe(0);
    const mine = await k(["run", "--wait", "--json", "--idempotency-key", "q1", "first"]);
    expect([mine.code, json(mine.out)]).toEqual([0, expect.objectContaining({ replayed: true, num_turns: 1, outcome: "success", result: "Scripted reply." })]);

    // A refused run changes nothing: no new session (also on a keyed retry),
    // no new model on the session it named.
    const before = json((await k(["sessions", "--json"])).out).length;
    for (let i = 0; i < 2; i++) expect((await k(["run", "--json", "--idempotency-key", "bad", "--effort", "max", "nope"])).code).not.toBe(0);
    const bad = await k(["run", "--json", "-r", id, "-m", "scripted:stand-in-backup", "--effort", "max", "nope"]);
    expect(bad.code).not.toBe(0);
    const after = json((await k(["sessions", "--json"])).out);
    expect(after.length).toBe(before);
    expect(after.find((x: any) => x.id === id).model).toBe("scripted:stand-in");

    // A card is left open for the owner: exit 2, then keel approve answers it.
    const ask = await k(["run", "--wait", "--json", "--permission-mode", "ask", "script:long-tool"]);
    expect(ask.code).toBe(2);
    const res = json(ask.out);
    expect(res).toMatchObject({ subtype: "needs_input", outcome: "action_required", pending_approvals: 1 });
    const list = await k(["approve", res.session_id.slice(0, 18), "--list", "--json"]);
    expect(json(list.out).approvals[0]).toMatchObject({ tool: "Bash", state: "pending" });
    const deny = await k(["approve", res.session_id, "--deny", "--answer", "not now"]);
    expect(deny.code).toBe(0);
    const follow = await k(["resume", res.session_id, "-p", "then what"]);
    expect(follow.code).toBe(0);
    expect(follow.out).toBe("Scripted reply.\n");

    const shown = await k(["show", id]);
    expect(shown.out).toContain("> hi");
    expect(shown.out).toContain("Scripted reply.");
    const logs = await k(["logs", res.session_id, "--json"]);
    expect(lines(logs.out).some((l) => l.type === "user" && l.message.content[0].text === "then what")).toBe(true);
  }, 60_000);

  test("sessions, search, send with files, stop, export, models, open, import", async () => {
    const list = await k(["sessions", "--json"]);
    const all = json(list.out);
    expect(all.length).toBeGreaterThan(2);
    const ids = await k(["ls", "--ids"]);
    expect(ids.out.trim().split("\n")).toEqual(all.map((s: any) => s.id));
    const found = await k(["sessions", "then what", "--json"]);
    expect(json(found.out).length).toBeGreaterThan(0);
    // --tail 0 is none of the history; --all is the archived ones too, not instead.
    expect(json((await k(["show", all[0].id, "--json", "--tail", "0"])).out).events).toEqual([]);
    expect((await k(["logs", all[0].id, "--tail", "0"])).out).toBe("");
    const base = json(readFileSync(join(state, "daemon.lock"), "utf8")).url;
    const old = json((await k(["run", "--json", "to be archived"])).out).session_id;
    await fetch(`${base}/api/sessions/${old}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
    const every = json((await k(["sessions", "--all", "--json"])).out).map((s: any) => s.id);
    expect(every).toEqual(expect.arrayContaining([...all.map((s: any) => s.id), old]));
    expect(json((await k(["sessions", "--json"])).out).map((s: any) => s.id)).not.toContain(old);

    // Without an id a prompt goes to the session the owner used in the last minute.
    const toLast = await k(["send", "--json", "where does this go"]);
    expect(json(toLast.out).session_id).toBe(json(found.out)[0].id);
    const fresh = await k(["send", "--new", "--json", "new prompt", "--wait"]);
    expect(fresh.code).toBe(0);
    const sid = json(fresh.out).session_id;

    // An image waits in the draft; the next prompt carries it and empties the draft.
    const png = join(SCRATCH, "dot.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const drafted = await k(["send", sid, "--attach", png, "--json"]);
    expect(json(drafted.out).draft.attachments).toBe(1);
    const notes = join(SCRATCH, "notes.txt");
    writeFileSync(notes, "a text file\n");
    const refused = await k(["send", sid, "--attach", notes]);
    expect(refused.code).toBe(3);
    const sent = await k(["send", sid, "look at these", "--attach", notes, "--wait"]);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("Scripted reply.");
    const shown = await k(["show", sid, "--json"]);
    const prompt = json(shown.out).events.findLast((e: any) => e.kind === "user");
    expect(prompt.data.images.map((b: any) => b.type).sort()).toEqual(["attachment", "image"]);

    const stopped = await k(["stop", sid, "--json"]);
    expect(json(stopped.out)).toMatchObject({ ok: true, was_running: false });

    const exp = await k(["export", sid, "--format", "claude_code"]);
    expect(exp.code).toBe(0);
    expect(exp.out).toMatch(/^wrote ".*\.jsonl"\ndirectory ".*"\nresume "claude --resume [\w-]+"\n$/);

    const models = await k(["models", "--json"]);
    expect(json(models.out).models.map((m: any) => m.id)).toContain("scripted:stand-in");
    const byName = await k(["run", "--json", "-m", "stand-in-backup", "--new-is-not-a-flag"]);
    expect(byName.code).toBe(3);
    const picked = await k(["run", "--wait", "--json", "-m", "stand-in-backup", "who answers"]);
    expect(json(picked.out).result).toBe("The backup model took the request.");

    const opened = await k(["open", "--print-url", "--json"]);
    expect(json(opened.out).url).toContain("/s/");

    const harnesses = await k(["import", "harnesses", "--json"]);
    expect(harnesses.code).toBe(0);
    expect(json(harnesses.out).map((h: any) => h.harness).sort()).toEqual(["agy", "claude", "codex", "hermes", "keel"]);
    const badSub = await k(["import", "nope"]);
    expect(badSub.code).toBe(3);

    // keel rules: the standing rules, and how the gate would judge a sample.
    const none = await k(["rules"]);
    expect(none.code).toBe(0);
    const safe = await k(["rules", "check", "git status", "--mode", "ask", "--json"]);
    expect(json(safe.out)).toMatchObject({ decision: "allow", tool: "shell", mode: "ask" });
    const risky = await k(["rules", "check", "rm -rf build", "--mode", "ask", "--json"]);
    expect(json(risky.out).decision).toBe("ask");
    const ro = await k(["rules", "check", "notes.txt", "--tool", "edit", "--mode", "read-only"]);
    expect(ro.out).toMatch(/^deny: edit notes\.txt/);
    const badMode = await k(["rules", "check", "ls", "--mode", "yolo"]);
    expect(badMode.code).toBe(3);
  }, 60_000);
});

// A daemon of its own for a group of tests, and plain calls to its API.
async function daemonAt(state: string) {
  const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
  const reader = d.stdout.getReader();
  let seen = "";
  while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
  reader.releaseLock();
  const url = json(readFileSync(join(state, "daemon.lock"), "utf8")).url as string;
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    (await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
  const idle = async (id: string) => {
    for (let i = 0; i < 300; i++) { const st = await api(`/api/cli/state/${id}`); if (!st.running && (st.queue === 0 || st.held)) return; await Bun.sleep(50); }
    throw new Error(`${id} did not come to rest`);
  };
  return { d, url, api, idle };
}

// An address in front of the daemon: every HTTP call passes `on`, which may
// answer itself or act before the daemon does. It opens no WebSocket, so a
// command that follows a session through it reads the stored events only.
function front(target: string, on: (method: string, path: string) => Promise<Response | void> | Response | void = () => {}) {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 60, fetch: async (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/ws") return new Response("no socket here", { status: 404 });
    const own = await on(req.method, u.pathname);
    if (own) return own;
    const r = await fetch(target + u.pathname + u.search, { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" }, body: req.method === "GET" ? undefined : await req.arrayBuffer() });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  } });
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) };
}

const DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("a prompt next to other work in its session", () => {
  const state = join(SCRATCH, "state-scoped");
  let dm: Awaited<ReturnType<typeof daemonAt>>;
  const k = (args: string[], o: { stdin?: string; cwd?: string } = {}) => keel(args, { state, ...o });
  beforeAll(async () => { dm = await daemonAt(state); }, 30_000);
  afterAll(() => dm?.d.kill("SIGTERM"));

  test("send takes out of the draft exactly what it sent", async () => {
    const { api, idle, url } = dm;
    // A session at rest whose draft holds words and an image.
    const drafted = async (text: string, name: string) => {
      const sid = json((await k(["send", "--new", "--json", "start", "--wait"])).out).session_id as string;
      const put = (text: string, name: string) => api(`/api/sessions/${sid}/draft`, { text, images: [{ name, mime: "image/png", data: DOT }] });
      await put(text, name);
      const now = async () => {
        const d = await api(`/api/sessions/${sid}/draft`);
        const sent = (await api(`/api/sessions/${sid}/events`)).events.filter((e: any) => e.kind === "user").slice(1).map((e: any) => [e.data.text, e.data.images?.length ?? 0]);
        return { sent, draft: [d.text, d.attachments.map((a: any) => a.name)] };
      };
      return { sid, put, now };
    };
    const kept = { sent: [], draft: ["first words", ["one.png"]] };

    // More is written after the command read the draft and before its prompt is accepted: it stays.
    const a = await drafted("first words", "one.png");
    const late = front(url, async (method, path) => { if (method === "POST" && path.endsWith("/messages")) await a.put("later words", "two.png"); });
    const sent = await k(["send", a.sid, "and this", "--url", late.url]);
    late.stop();
    await idle(a.sid);

    // An image of the draft that cannot be read: nothing is sent, nothing is dropped.
    const b = await drafted("first words", "one.png");
    const broken = front(url, (method, path) => (method === "GET" && path.includes("/draft/files/") ? Response.json({ error: "disk error" }, { status: 500 }) : undefined));
    const unread = await k(["send", b.sid, "with the image", "--url", broken.url]);
    broken.stop();
    await idle(b.sid);

    // A prompt the daemon refuses: the draft is as it was, and the command says so.
    const c = await drafted("first words", "one.png");
    const closed = front(url, (method, path) => (method === "POST" && path.endsWith("/messages") ? Response.json({ error: "the daemon is stopping and takes no new work" }, { status: 503 }) : undefined));
    const refused = await k(["send", c.sid, "not now", "--url", closed.url]);
    closed.stop();

    expect({
      late: [sent.code, sent.err, await a.now()],
      unread: [unread.code, unread.err, await b.now()],
      refused: [refused.code, refused.err, await c.now()],
    }).toEqual({
      late: [0, "", { sent: [["first words\n\nand this", 1]], draft: ["later words", ["two.png"]] }],
      unread: [3, expect.stringContaining("one.png could not be read (HTTP 500): nothing was sent and the draft is as it was"), kept],
      refused: [3, expect.stringContaining("takes no new work: nothing was sent and the draft is as it was"), kept],
    });
  }, 60_000);

  test("a command shows the output of the prompt it sent, and no other's", async () => {
    const { api, idle, url } = dm;
    const GROW = `Growing. ${"dolor sit amet ".repeat(280)}`.trim();
    const said = async (sid: string) => (await api(`/api/sessions/${sid}/events`)).events.filter((e: any) => e.kind === "assistant").map((e: any) => e.data.blocks.map((b: any) => b.text ?? "").join(""));
    // A session whose first prompt streams its reply for a couple of seconds.
    const streaming = async () => {
      const sid = (await api("/api/sessions", { model: "scripted:stand-in", workspace: WS })).session.id as string;
      await api(`/api/sessions/${sid}/messages`, { text: "script:render" });
      return sid;
    };
    const seen: Record<string, unknown> = {};
    const partial = (out: string) => {
      const ls = lines(out);
      return {
        prompts: ls.filter((l) => l.type === "user").map((l) => l.message.content[0].text),
        replies: ls.filter((l) => l.type === "assistant").map((l) => l.message.content[0].text),
        streamed: ls.filter((l) => l.type === "stream_event").map((l) => l.event.delta.text).join(""),
        result: ls.at(-1).result,
      };
    };
    const noSocket = front(url);
    for (const [name, via] of [["socket", []], ["polling", ["--url", noSocket.url]]] as const) {
      // The first command stays for the work of its own prompt; the second's prompt runs behind it.
      const a = (await api("/api/sessions", { model: "scripted:stand-in", workspace: WS })).session.id as string;
      const first = k(["run", "-r", a, "--output-format", "json", "script:render", ...via]);
      for (let i = 0; i < 100 && !(await api(`/api/cli/state/${a}`)).running; i++) await Bun.sleep(20);
      const sent = await k(["send", a, "script:grow", "--queue", "--wait", ...via]);
      const own = json((await first).out);
      seen[`${name} send`] = [sent.code, sent.out, own.num_turns, own.result === (await said(a))[0].trim()];

      const b = await streaming();
      const run = await k(["run", "-r", b, "--queue", "--stream-json", "--include-partial-messages", "script:grow", ...via]);
      seen[`${name} run`] = [run.code, partial(run.out)];
      await idle(b);
    }
    noSocket.stop();
    // A reply already streaming when the command connects is printed once, whole.
    const direct = await k(["send", "--new", "script:render", "--wait"]);
    const whole = (await said(json((await k(["sessions", "--json", "-n", "1"])).out)[0].id))[0];
    seen.direct = [direct.code, direct.out === `${whole}\n`];

    const stream = (streamed: string) => [0, { prompts: ["script:grow"], replies: [GROW], streamed, result: GROW }];
    expect(seen).toEqual({
      "socket send": [0, `${GROW}\n`, 1, true],
      "socket run": stream(GROW),
      "polling send": [0, `${GROW}\n`, 1, true],
      "polling run": stream(""),
      direct: [0, true],
    });
  }, 90_000);
});

// A secret's value reaches the command that uses it and nothing else: not the
// job's record, its log or the routes, before or after the daemon restarts
// under a running job (the next daemon adopts it, with an empty vault).
describe("a secret in a background job across a restart", () => {
  const state = join(SCRATCH, "state-secret");
  const serve = async () => {
    const d = Bun.spawn([BIN, "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", WS], { cwd: WS, env: ENV, stdout: "pipe", stderr: "ignore" });
    const reader = d.stdout.getReader();
    let seen = "";
    while (!seen.includes("listening")) seen += new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    return { d, url: json(readFileSync(join(state, "daemon.lock"), "utf8")).url as string };
  };
  test("no value in any file of the state folder or any job route", async () => {
    let { d, url } = await serve();
    const api = async (path: string, init?: RequestInit) => (await fetch(url + path, { ...init, headers: { "content-type": "application/json" } })).json() as Promise<any>;
    const turns = async (id: string, n: number) => {
      for (let i = 0; i < 200; i++) { const s = await api(`/api/sessions/${id}`); if (!s.running && s.events.filter((e: any) => e.kind === "turn_end").length >= n) return; await Bun.sleep(100); }
      throw new Error(`turn ${n} did not end`);
    };
    const token = `ghp_${crypto.randomUUID().replace(/-/g, "")}Ab12`.slice(0, 40);
    const { session } = await api("/api/sessions", { method: "POST", body: JSON.stringify({ model: "scripted:stand-in", workspace: WS }) });
    await api(`/api/sessions/${session.id}/permissions`, { method: "PUT", body: JSON.stringify({ mode: "full-auto" }) });
    await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: `Keep this for later: ${token}` }) });
    await turns(session.id, 1);
    const sec = (await api("/api/secrets")).secrets.find((s: any) => s.sessions.includes(session.id));
    await api(`/api/secrets/${sec.id}`, { method: "PATCH", body: JSON.stringify({ name: "CLI_SECRET" }) });
    // The command and its description name the placeholder; the command prints the value, split by a pause.
    const call = { name: "Bash", input: { command: 'test "[value of $CLI_SECRET]" = "$CLI_SECRET" && echo "same"; printf %s "${CLI_SECRET:0:9}"; sleep 2; echo "${CLI_SECRET:9}"', description: "check [value of $CLI_SECRET]", run_in_background: true } };
    await api(`/api/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ text: `script:calls ${JSON.stringify([call])}` }) });
    await turns(session.id, 2);
    d.kill("SIGTERM");
    await d.exited;
    ({ d, url } = await serve());
    try {
      let jobs: any[] = [];
      for (let i = 0; i < 100; i++) { jobs = (await api(`/api/sessions/${session.id}/jobs`)).jobs; if (jobs.length && jobs.every((j) => !j.running)) break; await Bun.sleep(100); }
      expect(jobs.length).toBe(1);
      const answers = [JSON.stringify(jobs), JSON.stringify(await api(`/api/sessions/${session.id}/terminal`)), JSON.stringify(await api(`/api/sessions/${session.id}`)),
        JSON.stringify(await api(`/api/sessions/${session.id}/jobs/${jobs[0].id}/log`)), JSON.stringify(await api(`/api/sessions/${session.id}/terminal/${jobs[0].id}/log`))];
      expect(answers[3]).toContain("same\\n[value of $CLI_SECRET]");
      expect(jobs[0].description).toBe("check [value of $CLI_SECRET]");
      for (const a of answers) expect(a).not.toContain(token);
      const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(join(p, f.name)) : f.isFile() ? [join(p, f.name)] : []));
      expect(walk(state).filter((f) => readFileSync(f).includes(token))).toEqual([]);
    } finally { d.kill("SIGTERM"); await d.exited; }
  }, 60_000);
});
