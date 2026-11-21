// What the e2e cannot see: the messages of a summary request that is the
// first request of a turn, with the hooks that answer a new prompt installed.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { hookRoutes } from "../server/routes/hooks.ts";
import { MEMORY_CAP, START_WAIT_MS, Tacit } from "./tacit.ts";

test("Tacit reuses only the retained transcript of the same version", () => {
  const dir = mkdtempSync(join(tmpdir(), "tacit-transcript-"));
  const store = new Store(dir);
  try {
    const failures: unknown[] = [];
    const tacit = new Tacit(store, new Bus(), { capture: (_: string, error: unknown) => failures.push(error) } as unknown as ErrorTracker, null);
    const s = store.createSession({ model: "fixture:model", workspace: dir });
    const first = store.append(s.id, "user", { text: "First branch" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Synthetic reply" }] });
    const read = (session = s) => readFileSync(tacit.transcript(session), "utf8");
    const stats = tacit.stats().transcript;
    const initial = read();
    const path = tacit.transcriptPath(s);
    expect(initial).toContain("First branch");
    expect(read()).toBe(initial); // exact JSONL bytes, including UUIDs
    expect(stats).toMatchObject({ rebuilt: 1, reused: 1, failed: 0, bytes: { total: Buffer.byteLength(initial) } });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Same original Session object, but the head is now on a sibling branch.
    store.append(s.id, "user", { text: "Fresh branch" }, first.id);
    const fresh = read();
    expect(fresh).toContain("Fresh branch");
    expect(fresh).not.toContain("Synthetic reply");
    expect(stats.rebuilt).toBe(2);
    store.updateSession(s.id, { head: first.id });
    expect(read()).not.toContain("Fresh branch");
    expect(stats.rebuilt).toBe(3);

    const moved = store.updateSession(s.id, { workspace: join(dir, "moved") });
    expect(JSON.parse(read()).cwd).toBe(moved.workspace);
    expect(stats.rebuilt).toBe(4);
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "No stored model" }] });
    const beforeAppend = readFileSync(path, "utf8");
    const beforeModel = read(moved);
    // The branch only grew: the reply is appended under the file's last record,
    // and what was there keeps its bytes (the file is not written whole again).
    expect(stats).toMatchObject({ rebuilt: 4, appended: 1 });
    expect(beforeModel.startsWith(beforeAppend)).toBe(true);
    const records = beforeModel.trim().split("\n").map((l) => JSON.parse(l));
    expect(records.map((r) => r.parentUuid)).toEqual([null, ...records.slice(0, -1).map((r) => r.uuid)]);
    const changedModel = store.updateSession(s.id, { model: "fixture:new-model" });
    const modelUpdated = read(moved);
    expect(beforeModel).toContain('"model":"model"');
    expect(modelUpdated).toContain('"model":"new-model"');
    expect(stats.rebuilt).toBe(5);

    rmSync(path);
    mkdirSync(path); // a failed replacement must leave no cached version or temporary file
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 5, reused: 1, failed: 1 });
    expect(failures).toHaveLength(1);
    expect(readdirSync(join(dir, "transcripts"))).toEqual([`${s.id}.jsonl`]);
    rmSync(path, { recursive: true });
    const restored = read(changedModel);
    expect(restored).toContain('"model":"new-model"');
    expect(restored).not.toBe(modelUpdated);
    expect(read(changedModel)).toBe(restored);
    expect(stats).toMatchObject({ rebuilt: 6, reused: 2 });

    tacit.forget(s.id);
    expect(read(changedModel)).not.toBe(restored);
    tacit.setFlags(s.id, { feed_memory: false });
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 7, reused: 2 });
    tacit.setFlags(s.id, { feed_memory: true });
    read(changedModel);
    expect(stats.rebuilt).toBe(8);
    store.deleteSession(s.id);
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 8, reused: 2 });
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A context over its limit is summarized before the turn's first request. That
// request carries the summary's own ask and none of the new prompt: memory and
// the owner's prompt hooks answer the prompt on the turn request, after the
// summary. (They used to rebuild the summary request from the branch, so the
// model got the prompt with no ask for a summary and went on with the work.)
test("a summary sent before a turn's first request keeps its ask; the prompt's hooks run on the turn request", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "prompt-hooks-"));
  const bin = join(dir, "tacit");
  const context = "é".repeat(MEMORY_CAP + 1);
  writeFileSync(bin, `#!/bin/sh
input=$(cat)
case "$2" in
  prompt) echo MEMORY-FOR-PROMPT ;;
  pre-tool)
    case "$input" in
      *fixture-hit*) printf '%s\\n' '${JSON.stringify({ hookSpecificOutput: { additionalContext: context } })}' ;;
      *fixture-timeout*) exec sleep 3 ;;
      *fixture-failure*) exit 1 ;;
      *fixture-invalid*) echo not-json ;;
      *) echo '{}' ;;
    esac ;;
esac
`, { mode: 0o755 });
  const ownerHooks = process.env.KEEL_HOOKS;
  process.env.KEEL_HOOKS = join(dir, "hooks.json");
  writeFileSync(process.env.KEEL_HOOKS, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "cat > /dev/null; echo HOOK-FOR-PROMPT" }] }] } }));
  const installed = allHooks().length;
  try {
    const store = new Store(dir);
    const bus = new Bus();
    const errors = { capture: (_s: string, e: unknown) => ({ message: String((e as Error).message) }) } as any;
    const asked: any[] = [];
    const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "other", context: 100_000, output: 1_000, efforts: [], billing: "per_token" };
    const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
    const provider = {
      id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
      stream: async (req: any) => {
        asked.push(req);
        return { blocks: [{ type: "text", text: req.purpose === "summary" ? "SUMMARY-OF-IT" : "ok" }], usage, stop: "end_turn", model: "m" };
      },
    };
    const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] } as any;
    const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
    const tacit = new Tacit(store, bus, errors, bin);
    tacit.install();
    hookRoutes({ store, bus, engine, providers, errors, workspace: dir });

    const s = store.createSession({ model: "p:m", workspace: dir });
    store.updateSession(s.id, { settings: { compact_at: 2_000 } });
    store.append(s.id, "user", { text: "go" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "x".repeat(20_000) }], model: "p:m", stop: "end_turn", usage: { ...usage, input: 6_000 } });
    engine.send(s.id, "THE-NEW-PROMPT");
    await engine.idle(s.id);

    expect(asked.map((r) => r.purpose)).toEqual(["summary", "turn"]);
    const [summary, turn] = asked.map((r) => JSON.stringify(r.messages));
    expect(JSON.stringify(asked[0].messages.at(-1).content.at(-1))).toContain("The context is being compacted");
    for (const later of ["THE-NEW-PROMPT", "MEMORY-FOR-PROMPT", "HOOK-FOR-PROMPT"]) expect(summary).not.toContain(later);
    // The turn request: the summary, then the prompt whole with what its hooks added.
    expect(JSON.stringify(asked[1].messages[0])).toContain("SUMMARY-OF-IT");
    expect(turn).not.toContain("x".repeat(20_000));
    for (const here of ["THE-NEW-PROMPT", "MEMORY-FOR-PROMPT", "HOOK-FOR-PROMPT"]) expect(turn).toContain(here);
    expect(store.events(s.id).findLast((e) => e.kind === "turn_end")?.data.reason).toBe("end_turn");

    expect(await tacit.startBlock(s)).toBeNull();
    const path = tacit.transcript(s);
    const transcriptBefore = readFileSync(path);
    const { rebuilt, reused, bytes: { total: bytesBefore } } = tacit.stats().transcript;
    expect(await tacit.preToolBlock(s, "read", {})).toBeNull(); // no Tacit call
    expect(await tacit.preToolBlock(s, "bash", { command: "fixture-hit" })).toBe(context);
    for (const kind of ["empty", "failure", "invalid", "timeout"])
      expect(await tacit.preToolBlock(s, "bash", { command: `fixture-${kind}` })).toBeNull();
    const stats = tacit.stats();
    expect(stats.hooks["prompt"].outcomes.hit).toBe(1);
    expect(stats.hooks["session-start"].outcomes.empty).toBe(2); // told of the summary, then asked here
    expect(stats.hooks["pre-compact"].outcomes.ok).toBe(1);
    const preTool = stats.hooks["pre-tool"];
    // The call that outlasts the tool hook's wait is given up on, not killed: it has not ended yet.
    expect(preTool.outcomes).toEqual({ hit: 1, empty: 1, failure: 2, timeout: 0, ok: 0 });
    expect(preTool.context_bytes).toEqual({ total: MEMORY_CAP * 2, max: MEMORY_CAP * 2 });
    expect(preTool.duration_ms.max).toBeGreaterThan(0);
    expect(preTool.duration_ms.total).toBeGreaterThan(preTool.duration_ms.max);
    expect(stats.transcript.failed).toBe(0);
    expect(stats.transcript.rebuilt - rebuilt).toBe(0);
    expect(stats.transcript.reused - reused).toBe(5);
    expect(stats.transcript.bytes.total - bytesBefore).toBe(0);
    expect(readFileSync(path).equals(transcriptBefore)).toBe(true);
    expect(stats.transcript.duration_ms.total).toBeGreaterThan(0);
    const json = JSON.stringify(stats);
    for (const secret of [context.slice(0, 20), "THE-NEW-PROMPT", "MEMORY-FOR-PROMPT", "fixture-timeout", s.id, dir]) expect(json).not.toContain(secret);
  } finally {
    allHooks().length = installed; // the hooks are process-wide: other test files run without these
    if (ownerHooks === undefined) delete process.env.KEEL_HOOKS;
    else process.env.KEEL_HOOKS = ownerHooks;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the memory hooks against a store that gives a fact once ----------------------
//
// The stand-in answers like the store these hooks are written for: it gives a
// session each fact name once and marks it as given before it prints it, so a
// fact Keel drops is gone for that session; told of a summary or a clear
// (session-start with that source) it forgets what it gave. A prompt or a
// command names facts by words kwN: a prompt gets fact-kwN, a command
// rule-kwN, each `len` characters long. `mode`: slow (nothing is answered
// for 8 s), slowtool (tool calls are not), slowstart and slowstart7 (the
// start block takes 2.5 s and 7 s).
// No e2e can hold a store back for one call and release it for the next.
function standIn(dir: string) {
  const sd = join(dir, "standin");
  mkdirSync(sd, { recursive: true });
  const set = (k: string, v: string | number) => writeFileSync(join(sd, k), String(v));
  set("mode", "ok"); set("len", 40); set("calls", "");
  const bin = join(sd, "store.sh");
  writeFileSync(bin, `#!/bin/bash
dir=${JSON.stringify(sd)}
input=$(cat)
hook=$2
mode=$(cat "$dir/mode"); len=$(cat "$dir/len")
sid=$(sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p' <<<"$input")
src=$(sed -n 's/.*"source":"\\([^"]*\\)".*/\\1/p' <<<"$input")
echo "$hook $sid $src" >> "$dir/calls"
seen="$dir/seen-$sid"; touch "$seen"
pad=$(head -c "$len" /dev/zero | tr '\\0' 'x')
out=""
give() { grep -qx "$1" "$seen" && return; echo "$1" >> "$seen"; out+="- $1: the text of $1 $pad\\n"; }
case "$hook" in
  session-start)
    case "$mode" in slow) exec sleep 8 ;; slowstart) sleep 2.5 ;; slowstart7) sleep 7 ;; esac
    case "$src" in compact|clear) : > "$seen" ;; startup) ;; *) exit 0 ;; esac
    give start-rule; printf '# store: standing rules\\n%b' "$out" ;;
  prompt)
    case "$mode" in slow) exec sleep 8 ;; esac
    q=$(sed -n 's/.*"prompt":"\\(.*\\)","transcript_path.*/\\1/p' <<<"$input")
    for w in $(grep -o 'kw[0-9]*' <<<"$q" | sort -u -V); do give "fact-$w"; done
    [ -n "$out" ] && printf '# store: facts matching this request\\n%b' "$out" ;;
  pre-tool)
    case "$mode" in slow|slowtool) exec sleep 8 ;; esac
    cmd=$(sed -n 's/.*"command":"\\([^"]*\\)".*/\\1/p' <<<"$input")
    for w in $(grep -o 'kw[0-9]*' <<<"$cmd" | sort -u -V); do give "rule-$w"; done
    [ -n "$out" ] && printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"# store: before this step\\\\n%s"}}\\n' "$(printf '%s' "$out" | sed 's/\\\\n$//')" ;;
esac
exit 0
`, { mode: 0o755 });
  const calls = (hook?: string) => readFileSync(join(sd, "calls"), "utf8").trim().split("\n").filter((l) => l && (!hook || l.startsWith(hook + " ")));
  return { bin, set, calls };
}

// An engine with the memory hooks on a store folder. The scripted model runs
// the commands a prompt lists ("tools=1,2" runs `echo kw1`, then `echo kw2`).
function memoryWorld(dir: string, bin: string) {
  const store = new Store(dir);
  const bus = new Bus();
  const captured: string[] = [];
  const errors = { capture: (_s: string, e: unknown) => { captured.push(String((e as Error).message)); return { message: "" }; } } as any;
  const asked: { session: string; at: number; messages: string }[] = [];
  const info = { id: "p:m", provider: "p", model: "m", name: "M", family: "claude", context: 1_000_000, output: 4_000, efforts: [], billing: "per_token" };
  let n = 0;
  const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
  const provider = {
    id: "p", family: "claude", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      if (req.purpose === "summary") return { blocks: [{ type: "text", text: "SUMMARY: the work so far, with no memory in it." }], usage, stop: "end_turn", model: "m" };
      asked.push({ session: req.sessionKey, at: performance.now(), messages: JSON.stringify(req.messages) });
      const isPrompt = (m: any) => m.role === "user" && !JSON.stringify(m.content).includes('"tool_result"');
      const at = req.messages.findLastIndex((m: any) => isPrompt(m) && /tools=/.test(JSON.stringify(m)));
      if (at >= 0 && at === req.messages.findLastIndex(isPrompt)) {
        const plan = /tools=([\d,]+)/.exec(JSON.stringify(req.messages[at]))![1]!.split(",");
        const done = req.messages.slice(at + 1).filter((m: any) => m.role === "assistant").length;
        if (plan[done]) return { blocks: [{ type: "tool_use", id: `c${++n}`, name: "Bash", input: { command: `echo kw${plan[done]}` } }], usage, stop: "tool_use", model: "m" };
      }
      return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] } as any;
  const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
  const tacit = new Tacit(store, bus, errors, bin);
  tacit.install();
  const session = () => {
    return store.createSession({ model: "p:m", workspace: dir }).id;
  };
  // Sends an input; answers with how long its first request took to go.
  const say = async (id: string, text: string, meta?: Record<string, unknown>) => {
    const before = asked.length;
    const t0 = performance.now();
    engine.send(id, text, { meta });
    await engine.idle(id);
    return (asked.slice(before).find((r) => r.session === id)?.at ?? NaN) - t0;
  };
  const last = (id: string) => asked.findLast((r) => r.session === id)!.messages;
  const names = (text: string) => [...new Set([...text.matchAll(/- ((?:fact|rule)-kw\d+|start-rule):/g)].map((m) => m[1]!))];
  const told = (id: string) => store.events(id).filter((e) => e.kind === "note" && e.data.kind === "memory_out").length;
  const copies = (id: string, name: string) => last(id).split(`- ${name}:`).length - 1;
  return { store, bus, engine, tacit, session, say, last, names, told, copies, captured, asked };
}
const until = async (what: () => boolean, ms = 15_000) => { const t = Date.now(); while (!what() && Date.now() - t < ms) await Bun.sleep(25); expect(what()).toBe(true); };
const seq = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
async function inWorld(name: string, run: (w: ReturnType<typeof memoryWorld>, st: ReturnType<typeof standIn>, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", `memory-${name}-`));
  const installed = allHooks().length;
  try {
    const st = standIn(dir);
    await run(memoryWorld(dir, st.bin), st, dir);
  } finally {
    allHooks().length = installed;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("memory across prompts: nothing twice; a report and a wait's wake do not ask; a loop run and a goal's start do", () => inWorld("asks", async (w, st) => {
  const s = w.session();
  await w.say(s, "first kw1");
  await w.say(s, "second kw1 kw2");
  // The fact the context holds is there once; the new one came.
  expect(w.names(w.last(s))).toEqual(["start-rule", "fact-kw1", "fact-kw2"]);
  expect(w.copies(s, "fact-kw1")).toBe(1);
  expect(st.calls("session-start").map((l) => l.split(" ")[2])).toEqual(["startup"]);
  const prompts = () => st.calls("prompt").length;
  // Deliveries: the store is not asked, so it marks nothing as given.
  for (const [text, meta] of [["<agent_report>the kw3 work is done</agent_report>", { kind: "subagent", agent_id: "a" }], ["<wait_fired>kw4</wait_fired>", { kind: "wait" }], ["[harness] The goal is not met yet: kw5", { kind: "goal", goal: "continue" }]] as const) {
    const before = prompts();
    await w.say(s, text, meta);
    expect(prompts()).toBe(before);
  }
  // Requests that are not typed: asked, and their facts are in the turn.
  for (const [text, meta, name] of [["Check the kw6 queue", { kind: "loop", loop_name: "x" }, "fact-kw6"], ["Make kw7 pass", { kind: "goal", goal: "start" }, "fact-kw7"], ["Verify kw8", { kind: "verify_goal" }, "fact-kw8"],
    ["report kw9\n\nsteer kw10", { kind: "wake", parts: [{ kind: "subagent" }, { kind: "steer" }] }, "fact-kw10"]] as const) {
    await w.say(s, text, meta);
    expect(w.names(w.last(s))).toContain(name);
  }
  const { memoryMeter } = await import("./memory-meter.ts");
  const report = memoryMeter(w.store).report({ session: s });
  const prompt = report.paths.find((p) => p.path === "store_prompt")!;
  expect(prompt).toMatchObject({ asked: 9, recalls: 6, skipped: 3, timeouts: 0 });
  expect(JSON.stringify(report)).not.toContain("kw");
}), 30_000);

// The reviewer's probe: one turn whose prompt brings more than a block holds
// and whose 40 tool calls each bring one new fact. Every fact the store gave
// is in the model's context by the end of the turn; with one step only, by
// the next prompt, after a restart too.
test("a fact the store gave is never dropped for size: what a block cannot hold is owed and follows", () => inWorld("owed", async (w, st) => {
  st.set("len", 400);
  const s = w.session();
  const facts = seq(100, 140).map((k) => `fact-kw${k}`); // 41 facts of 400 characters: more than one block
  const rules = seq(1, 40).map((k) => `rule-kw${k}`);
  await w.say(s, `work ${seq(100, 140).map((k) => `kw${k}`).join(" ")} tools=${seq(1, 40).join(",")}`);
  const first = w.asked.find((r) => r.session === s)!.messages;
  // The first request holds what one block holds, and says more follows.
  expect(w.names(first).length).toBeLessThan(41);
  expect(first).toMatch(/\[\d+ more lines follow with the next step: this block is full\]/);
  const end = w.names(w.last(s));
  for (const name of [...facts, ...rules]) expect(end).toContain(name);
  for (const name of [...facts, ...rules]) expect(w.copies(s, name)).toBe(1);
  expect(w.tacit.owed(s)).toBe(0);
  // No block is over the cap.
  for (const m of w.last(s).matchAll(/<memory source=\\"tacit\\"[\s\S]*?<\/memory>/g)) expect(JSON.parse(`"${m[0]}"`).length).toBeLessThanOrEqual(MEMORY_CAP);

  // A turn of one step: what did not fit stays owed, in the state, through a restart.
  const one = w.session();
  await w.say(one, `only ${seq(200, 240).map((k) => `kw${k}`).join(" ")}`);
  const owed = w.tacit.owed(one);
  expect(owed).toBeGreaterThan(0);
  expect(w.names(w.last(one)).length).toBeLessThan(42);
  // A new daemon reads the same state.
  const again = new Tacit(w.store, w.bus, { capture: () => ({ message: "" }) } as any, st.bin);
  expect(again.owed(one)).toBe(owed);
  await w.say(one, "and then?");
  const after = w.names(w.last(one));
  for (const k of seq(200, 240)) expect(after).toContain(`fact-kw${k}`);
  expect(w.tacit.owed(one)).toBe(0);

  // A clear: the store forgets what it gave and would give it again, so what
  // was owed from before does not follow into the fresh context.
  const cleared = w.session();
  await w.say(cleared, `only ${seq(300, 340).map((k) => `kw${k}`).join(" ")}`);
  expect(w.tacit.owed(cleared)).toBeGreaterThan(0);
  w.engine.clear(cleared);
  await w.say(cleared, "fresh kw1");
  expect(w.tacit.owed(cleared)).toBe(0);
  expect(w.names(w.last(cleared))).toEqual(["start-rule", "fact-kw1"]);

  // What may wait for a session is bounded, and a line says what was dropped past it.
  const flooded = w.session();
  const owe = (lines: string[]) => (w.tacit as any).owe(flooded, "prompt", lines);
  owe(seq(1, 12).map((k) => `- big-${k}: ${"z".repeat(9_990)}`));
  const rows = () => w.store.db.query<{ line: string }, [string]>("SELECT line FROM memory_owed WHERE session_id = ? ORDER BY id").all(flooded).map((r) => r.line);
  // Ten of the twelve fit in what ten blocks hold; one line stands for the two that did not.
  expect(rows().length).toBe(11);
  expect(rows().at(-1)).toBe("[2 more lines from memory were dropped: more was waiting than ten blocks hold]");
  owe(["- one-more: x".padEnd(9_000, "x"), "- and-another: y"]);
  expect(rows().filter((l) => l.includes("were dropped")).length).toBe(1);
  expect(rows().at(-1)).toBe("[4 more lines from memory were dropped: more was waiting than ten blocks hold]");
  expect(w.tacit.stats().owed_dropped).toBe(4);
}), 60_000);

// A store that answers prompts and never answers tool calls (the reviewer's
// probe): only tool results stop waiting for it, and only once is it said.
test("a tool hook that hangs stops the waiting for tool hooks only; a probe of its own ends the outage", () => inWorld("kinds", async (w, st) => {
  const a = w.session(), b = w.session();
  st.set("mode", "slowtool");
  const t0 = performance.now();
  await w.say(a, "A1 kw1 tools=50");
  // The prompt's fact came in its turn; the tool's result waited the tool hook's deadline once.
  expect(w.names(w.last(a))).toContain("fact-kw1");
  expect(performance.now() - t0).toBeGreaterThan(800);
  expect(w.told(a)).toBe(1);
  expect(w.tacit.stats().out).toEqual({ ask: false, tool: true });
  // Another session's prompt is waited for as ever, and gets its fact in the turn.
  await w.say(b, "B1 kw2");
  expect(w.names(w.last(b))).toContain("fact-kw2");
  expect(w.told(b)).toBe(0);
  // More turns with tool calls: no wait for the tool hook, prompts in their turn, no second note.
  for (const k of [3, 4, 5]) {
    const t = performance.now();
    await w.say(a, `A kw${k} tools=${50 + k}`);
    expect(performance.now() - t).toBeLessThan(800);
    expect(w.names(w.last(a))).toContain(`fact-kw${k}`);
  }
  expect(w.told(a)).toBe(1);
  expect(w.captured.filter((m) => m.includes("memory store"))).toHaveLength(1);
  // The store answers tool calls again: the probe finds out, with no prompt spent on it.
  st.set("mode", "ok");
  await until(() => !w.tacit.stats().out.tool);
  await w.say(a, "A kw6 tools=60");
  expect(w.names(w.last(a))).toEqual(expect.arrayContaining(["fact-kw6", "rule-kw60"]));
  expect(w.told(a)).toBe(1);
  expect(w.tacit.stats().processes.probes).toBeGreaterThan(0);
}), 60_000);

test("a store that hangs: the deadline once, said once, no wait after; a probe of its own ends it", () => inWorld("hang", async (w, st) => {
  const s = w.session();
  await w.say(s, "first kw1");
  st.set("mode", "slow");
  const waited = await w.say(s, "third kw3");
  expect(waited).toBeGreaterThan(2_000);
  expect(waited).toBeLessThan(4_000);
  const notes = () => w.store.events(s).filter((e) => e.kind === "note" && e.data.kind === "memory_out");
  expect(notes()).toHaveLength(1);
  expect(notes()[0]!.data.model).toBeUndefined(); // a line for the owner, not sent to the model
  expect(w.last(s)).not.toContain("Memory did not answer");
  // Measured as a timeout: the turn waited its full wait and went on without memory.
  const { memoryMeter } = await import("./memory-meter.ts");
  const measured = () => memoryMeter(w.store).report({ session: s }).paths.find((p) => p.path === "store_prompt")!;
  expect(measured()).toMatchObject({ timeouts: 1, late: 0 });
  // The next prompts do not wait; the session's calls go out one at a time;
  // one line in the session, though both its prompts and its tool calls hang.
  for (const k of [4, 5, 6]) expect(await w.say(s, `more kw${k} tools=${k}`)).toBeLessThan(1_000);
  expect(notes()).toHaveLength(1);
  // Not waited for: one call made and still out, the next two not made while it is.
  expect(measured()).toMatchObject({ timeouts: 1, late: 1, skipped: 2 });
  expect(w.captured.filter((m) => m.includes("did not answer in time: turns"))).toHaveLength(1);
  const p = w.tacit.stats().processes;
  expect(p.not_started).toBeGreaterThan(0);
  expect(p.max).toBeLessThanOrEqual(p.limit);
  expect(w.tacit.stats().out).toEqual({ ask: true, tool: true });
  // It answers again: the probe finds out, with no prompt spent on it.
  st.set("mode", "ok");
  await until(() => !w.tacit.stats().out.ask, 30_000);
  expect(w.tacit.stats().processes.probes).toBeGreaterThan(0);
  // So the next prompt is waited for and gets its fact in its own turn.
  await w.say(s, "back kw7");
  expect(w.names(w.last(s))).toContain("fact-kw7");
  expect(w.store.events(s).filter((e) => e.kind === "turn_end").every((e) => e.data.reason === "end_turn")).toBe(true);
}), 90_000);

test("during an outage: the probe stops with nobody asking; a new session's task is asked beside its start call; late answers are kept in the state", () => inWorld("late", async (w, st) => {
  const s = w.session();
  await w.say(s, "first kw1");
  // One hung call counts asking out; its probe starts while the store still hangs.
  st.set("mode", "slow");
  await w.say(s, "hung kw2");
  await until(() => st.calls("prompt").some((l) => l.includes("keel-probe")));
  st.set("mode", "ok");
  // Nobody asks anything: after its wait the probe is not asked again.
  await Bun.sleep(2 * 2_200 + 600);
  expect(w.tacit.stats().processes.probes).toBe(1);
  expect(w.tacit.stats().out.ask).toBe(true);
  // A new session's task while asking is still counted out: its request does
  // not wait, and both its start call and its prompt go to the store.
  const b = w.session();
  expect(await w.say(b, "task kw5", { kind: "task", agent_id: "x" })).toBeLessThan(1_000);
  expect(w.names(w.last(b))).toEqual([]);
  await until(() => st.calls("prompt").some((l) => l.includes(b)) && st.calls("session-start").some((l) => l.includes(b)));
  // What they answer is owed, in the state; an answer within the wait ends the outage.
  await until(() => w.tacit.owed(b) >= 2);
  expect(w.tacit.stats().out.ask).toBe(false);
  // A restart: a new instance on the same state still owes it.
  expect(new Tacit(w.store, w.bus, { capture: () => ({ message: "" }) } as any, st.bin).owed(b)).toBe(w.tacit.owed(b));
  await w.say(b, "next kw4 tools=9");
  expect(w.names(w.last(b))).toEqual(expect.arrayContaining(["start-rule", "fact-kw5", "fact-kw4", "rule-kw9"]));
  for (const name of ["start-rule", "fact-kw5"]) expect(w.copies(b, name)).toBe(1);
  expect(w.tacit.owed(b)).toBe(0);
}), 60_000);

test("a session's first prompt waits for the start block; a start slower than the wait is not killed, and its block follows", () => inWorld("start", async (w, st) => {
  st.set("mode", "slowstart");
  const s = w.session();
  // An agent's task, sent at once: the standing rules are in its first request.
  const waited = await w.say(s, "the task: kw1", { kind: "task", agent_id: "x" });
  expect(waited).toBeGreaterThan(2_300);
  expect(waited).toBeLessThan(START_WAIT_MS);
  expect(w.names(w.asked.find((r) => r.session === s)!.messages)).toEqual(["start-rule", "fact-kw1"]);
  expect(w.told(s)).toBe(0);

  // A start that takes 7 s (a slow sync): the request goes after the wait
  // without the block, and the process is left to finish.
  st.set("mode", "slowstart7");
  const slow = w.session();
  const held = await w.say(slow, "another task: kw2", { kind: "task", agent_id: "y" });
  expect(held).toBeGreaterThanOrEqual(START_WAIT_MS - 50);
  expect(held).toBeLessThan(7_000);
  expect(w.names(w.last(slow))).toEqual(["fact-kw2"]);
  expect(w.told(slow)).toBe(1);
  // It answers after the turn went on: not killed, and its block is owed.
  await until(() => w.tacit.owed(slow) > 0);
  expect(w.tacit.stats().hooks["session-start"].outcomes.timeout).toBe(0);
  st.set("mode", "ok");
  await w.say(slow, "and then kw3");
  expect(w.names(w.last(slow))).toEqual(expect.arrayContaining(["start-rule", "fact-kw2", "fact-kw3"]));
  expect(w.copies(slow, "start-rule")).toBe(1);
}), 60_000);

test("after a summary or a clear the store is told, and what it gave before comes again", () => inWorld("checkpoint", async (w, st) => {
  for (const how of ["summary", "clear"] as const) {
    const s = w.session();
    await w.say(s, "about kw1 please");
    await w.say(s, "kw1 once more");
    expect(w.copies(s, "fact-kw1")).toBe(1);
    if (how === "summary") await w.engine.compactNow(s, { trigger: "owner" });
    else w.engine.clear(s);
    await w.say(s, "and kw1 after it");
    // The context was replaced: the fact and the standing rules are in it again, once.
    expect(w.copies(s, "fact-kw1")).toBe(1);
    expect(w.copies(s, "start-rule")).toBe(1);
    expect(st.calls("session-start").filter((l) => l.includes(s)).map((l) => l.split(" ")[2])).toEqual(["startup", how === "summary" ? "compact" : "clear"]);
    // Told once per checkpoint, not with every prompt.
    await w.say(s, "kw1 again");
    expect(st.calls("session-start").filter((l) => l.includes(s))).toHaveLength(2);
    expect(w.copies(s, "fact-kw1")).toBe(1);
  }
}), 30_000);

test("a deleted session's transcript file goes with it, and one left behind is removed at the next start", () => inWorld("files", async (w, st, dir) => {
  const a = w.session(), b = w.session();
  await w.say(a, "one kw1");
  await w.say(b, "two kw2");
  const file = (id: string) => join(dir, "transcripts", `${id}.jsonl`);
  expect(existsSync(file(a)) && existsSync(file(b))).toBe(true);
  w.store.deleteSession(a); // any path that deletes: the store drops it everywhere
  expect(existsSync(file(a))).toBe(false);
  expect(existsSync(file(b))).toBe(true);
  // Left by a deletion while no daemon ran: gone when the next one starts.
  writeFileSync(file("01aaaaaa-0000-7000-8000-000000000000"), "{}\n");
  const fresh = new Tacit(w.store, w.bus, { capture: () => ({ message: "" }) } as any, st.bin);
  const hooks = allHooks().length;
  fresh.install();
  allHooks().length = hooks;
  expect(readdirSync(join(dir, "transcripts"))).toEqual([`${b}.jsonl`]);
}), 30_000);
