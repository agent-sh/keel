// The command line, end to end: the compiled binary, a real daemon it starts
// (`keel serve`) or runs inside itself (`keel run` with none answering), and
// the scripted stand-in model, so every path is deterministic and free.
// Run: bun test ./test/cli   (builds dist-cli/keel first)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRATCH = join(process.env.HOME!, ".cache/keel-work/bun/cli-test");
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
  KEEL_BROWSER: "true",
};

type Ran = { code: number; out: string; err: string };
async function keel(args: string[], o: { state: string; stdin?: string; cwd?: string; signalAfterMs?: number } ): Promise<Ran> {
  const p = Bun.spawn([BIN, ...args], {
    cwd: o.cwd ?? WS,
    env: { ...ENV, KEEL_STATE_DIR: o.state },
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
  const b = Bun.spawnSync(["bun", "scripts/build.ts", BIN], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (b.exitCode !== 0) throw new Error(`build failed: ${b.stderr}`);
}, 120_000);

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
    expect(json(harnesses.out).map((h: any) => h.harness).sort()).toEqual(["claude", "codex", "keel"]);
    const badSub = await k(["import", "nope"]);
    expect(badSub.code).toBe(3);
  }, 60_000);
});
