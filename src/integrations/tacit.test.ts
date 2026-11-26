// What the e2e cannot see: the messages of a summary request that is the
// first request of a turn, with the hooks that answer a new prompt installed.
import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { hookRoutes } from "../server/routes/hooks.ts";
import { RECORD_FORMAT } from "./claude-format.ts";
import { MEMORY_CAP, START_WAIT_MS, Tacit } from "./tacit.ts";
import { ownEnv } from "../../test/env.ts";

// The store's deny keys are read from its state folder: a scratch one, never the machine's.
ownEnv({ TACIT_STATE_DIR: mkdtempSync(join(process.env.TMPDIR ?? ".", "tacit-state-")) });

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

test("Tacit reuses only the retained transcript of the same version", () => {
  const dir = mkdtempSync(join(tmpdir(), "tacit-transcript-"));
  const store = new Store(dir);
  try {
    const failures: unknown[] = [];
    const tacit = new Tacit(store, new Bus(), { capture: (_: string, error: unknown) => failures.push(error) } as unknown as ErrorTracker, null);
    const s = store.createSession({ title: "Fixture", model: "fixture:model", workspace: dir });
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

    // Where the file stands is kept beside it: a session that dropped out of memory (archived, or
    // the least recent of many) finds its file again and writes nothing.
    expect(readdirSync(join(dir, "transcripts")).sort()).toEqual([`${s.id}.jsonl`, `${s.id}.mark`]);
    tacit.forget(s.id);
    expect(read(changedModel)).toBe(restored);
    expect(stats).toMatchObject({ rebuilt: 6, reused: 3 });
    // A session kept away from memory has no file to go on from when it is fed again.
    tacit.setFlags(s.id, { feed_memory: false });
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(stats).toMatchObject({ rebuilt: 6, reused: 3 });
    tacit.setFlags(s.id, { feed_memory: true });
    expect(read(changedModel)).not.toBe(restored);
    expect(stats.rebuilt).toBe(7);
    store.deleteSession(s.id);
    expect(existsSync(tacit.transcript(changedModel))).toBe(false);
    expect(readdirSync(join(dir, "transcripts"))).toEqual([]);
    expect(stats).toMatchObject({ rebuilt: 7, reused: 3 });
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A daemon that starts holds no transcript in memory. Each session's file is
// as the last daemon left it, and the mark beside it says up to where: the
// file is found again and only what came since is appended. Without the mark
// every session's transcript was encoded and written whole at its first hook
// after each restart.
test("after a restart a transcript is found as it was left: nothing is written for an unchanged session, and new events are appended", () => {
  const dir = mkdtempSync(join(tmpdir(), "tacit-transcript-restart-"));
  const store = new Store(dir);
  try {
    const errors = { capture: () => ({ message: "" }) } as unknown as ErrorTracker;
    const s = store.createSession({ title: "Fixture", model: "fixture:model", workspace: dir });
    for (let i = 0; i < 40; i++) {
      store.append(s.id, "user", { text: `Prompt ${i}` });
      store.append(s.id, "assistant", { blocks: [{ type: "text", text: `Reply ${i}` }, { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } }] });
      store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x" }] });
    }
    const first = new Tacit(store, new Bus(), errors, null);
    const path = first.transcript(s);
    const before = readFileSync(path);
    expect(first.stats().transcript).toMatchObject({ rebuilt: 1, appended: 0 });

    // The next daemon: the same store and files, nothing in memory.
    const second = new Tacit(store, new Bus(), errors, null);
    const events = spyOn(store, "events");
    expect(second.transcript(s)).toBe(path);
    expect(second.stats().transcript).toMatchObject({ rebuilt: 0, appended: 0, reused: 1 });
    expect(readFileSync(path).equals(before)).toBe(true);
    // What came since is appended under the file's last record; what was there keeps its bytes.
    store.append(s.id, "user", { text: "After the restart" });
    second.transcript(s);
    expect(second.stats().transcript).toMatchObject({ rebuilt: 0, appended: 1, reused: 1 });
    const after = readFileSync(path);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const records = after.toString().trim().split("\n").map((l) => JSON.parse(l));
    expect(records.at(-1).message.content).toBe("After the restart");
    expect(records.map((r) => r.parentUuid)).toEqual([null, ...records.slice(0, -1).map((r) => r.uuid)]);
    // The place to append at is found on the branch the store keeps: no list of every event is made for it.
    expect(events).toHaveBeenCalledTimes(0);
    events.mockRestore();

    // A file changed by anyone else since its mark was written is not appended to: written whole.
    writeFileSync(path, "{}\n");
    const third = new Tacit(store, new Bus(), errors, null);
    third.transcript(s);
    expect(third.stats().transcript).toMatchObject({ rebuilt: 1, appended: 0, reused: 0 });
    expect(readFileSync(path, "utf8")).toContain("After the restart");
    // And a mark that cannot be read is no mark.
    const markPath = join(dir, "transcripts", `${s.id}.mark`);
    writeFileSync(markPath, "{");
    const fourth = new Tacit(store, new Bus(), errors, null);
    fourth.transcript(s);
    expect(fourth.stats().transcript).toMatchObject({ rebuilt: 1 });
    // The mark names the format of the records it stands for, and is written whole (no temporary file stays).
    const kept = JSON.parse(readFileSync(markPath, "utf8"));
    expect(kept.format).toBe(RECORD_FORMAT);
    expect(readdirSync(join(dir, "transcripts")).sort()).toEqual([`${s.id}.jsonl`, `${s.id}.mark`]);
    // A mark from before the format was kept is of the first format, which is not this one: written whole.
    const { format: _f, ...old } = kept;
    writeFileSync(markPath, JSON.stringify(old));
    const fifth = new Tacit(store, new Bus(), errors, null);
    fifth.transcript(s);
    expect(fifth.stats().transcript).toMatchObject({ rebuilt: 1, appended: 0, reused: 0 });
    // A file whose records are of another format is not appended to: written whole, in this one.
    writeFileSync(markPath, JSON.stringify({ ...kept, format: RECORD_FORMAT + 1 }));
    const sixth = new Tacit(store, new Bus(), errors, null);
    sixth.transcript(s);
    expect(sixth.stats().transcript).toMatchObject({ rebuilt: 1, appended: 0, reused: 0 });
    expect(JSON.parse(readFileSync(markPath, "utf8")).format).toBe(RECORD_FORMAT);
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

    // (The session works in a folder of its own: the owner's hooks file is not loaded from a session's folder.)
    mkdirSync(join(dir, "ws"), { recursive: true });
    const s = store.createSession({ title: "Fixture", model: "p:m", workspace: join(dir, "ws") });
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
// rule-kwN (a file named with kwN likewise), each `len` characters long.
// `mode`: slow (nothing is answered for 8 s), slowtool (tool calls are not),
// lagtool (a read, `echo kwN`, is answered as soon as its own result is stored: the test files `result-kwN`;
// any other tool call after 0.4 s), latetool (a tool call is answered after 1.3 s), slowstart and slowstart7
// (the start block takes 2.5 s and 7 s). A file `slow-once` naming a hook
// makes the next call of that hook take 3 s, once. A name listed in `hidden`
// is a fact the store does not hold yet. `toollag` seconds is what a tool
// call's search takes; a file `stale` makes tool calls answer with nothing at
// once (an index that is being rebuilt).
// No e2e can hold a store back for one call and release it for the next.
// The worlds below run the hooks' waits and deadlines at a fraction of their
// length (the rules are the same), and the stand-in's delays with them.
const SPEED = 3;
const T = (ms: number) => ms / SPEED;
const sec = (s: number) => (s / SPEED).toFixed(2);
function standIn(dir: string) {
  const sd = join(dir, "standin");
  mkdirSync(sd, { recursive: true });
  const set = (k: string, v: string | number) => writeFileSync(join(sd, k), String(v));
  set("mode", "ok"); set("len", 40); set("calls", ""); set("hidden", "");
  const bin = join(sd, "store.sh");
  writeFileSync(bin, `#!/bin/bash
# No program is started but this one: a call that forks a dozen helpers is
# scheduled a dozen times, and on a loaded machine that alone outlasts the
# tool hook's wait (0.3 s at this speed).
dir=${JSON.stringify(sd)}
IFS= read -r -d '' input
hook=$2
read -r mode < "$dir/mode"; read -r len < "$dir/len"
sid=; src=
re='"session_id":"([^"]*)"'; [[ $input =~ $re ]] && sid=\${BASH_REMATCH[1]}
re='"source":"([^"]*)"'; [[ $input =~ $re ]] && src=\${BASH_REMATCH[1]}
echo "$hook $sid $src" >> "$dir/calls"
seen="$dir/seen-$sid"; : >> "$seen"
printf -v pad '%*s' "$len" ''; pad=\${pad// /x}
has() { local l; while IFS= read -r l || [[ -n $l ]]; do [[ $l == "$2" ]] && return 0; done < "$1"; return 1; }
# The distinct kw words of a text, in version order (KW).
num() { local k=\${1#kw}; if [[ -z $k ]]; then N=-1; else N=$((10#$k)); fi; }
kws() {
  KW=(); local s=$1 w v i j t b
  while [[ $s =~ kw[0-9]* ]]; do
    w=\${BASH_REMATCH[0]}; s=\${s#*"$w"}
    for v in "\${KW[@]}"; do [[ $v == "$w" ]] && continue 2; done
    KW+=("$w")
  done
  for ((i = 1; i < \${#KW[@]}; i++)); do
    t=\${KW[i]}; num "$t"; b=$N
    for ((j = i - 1; j >= 0; j--)); do num "\${KW[j]}"; ((N > b)) || break; KW[j + 1]=\${KW[j]}; done
    KW[j + 1]=$t
  done
}
out=""
give() { has "$dir/hidden" "$1" && return; has "$seen" "$1" && return; echo "$1" >> "$seen"; out+="- $1: the text of $1 $pad\\n"; }
if [ "$sid" != keel-probe ] && [ -f "$dir/slow-once" ]; then read -r once < "$dir/slow-once"; if [ "$once" = "$hook" ]; then rm -f "$dir/slow-once"; sleep ${sec(3)}; fi; fi
case "$hook" in
  session-start)
    case "$mode" in slow) exec sleep ${sec(8)} ;; slowstart) sleep ${sec(2.5)} ;; slowstart7) sleep ${sec(7)} ;; esac
    case "$src" in compact|clear) : > "$seen" ;; startup) ;; *) exit 0 ;; esac
    give start-rule; printf '# store: standing rules\\n%b' "$out" ;;
  prompt)
    case "$mode" in slow) exec sleep ${sec(8)} ;; lagprompt) sleep ${sec(1.8)} ;; esac
    q=; re='"prompt":"(.*)","transcript_path'; [[ $input =~ $re ]] && q=\${BASH_REMATCH[1]}
    kws "$q"
    for w in "\${KW[@]}"; do give "fact-$w"; done
    [ -n "$out" ] && printf '# store: facts matching this request\\n%b' "$out" ;;
  pre-tool)
    [ -f "$dir/stale" ] && exit 0
    case "$mode" in slow|slowtool) exec sleep ${sec(8)} ;; esac
    cmd=; file=; re='"command":"([^"]*)"'; [[ $input =~ $re ]] && cmd=\${BASH_REMATCH[1]}
    re='"file_path":"([^"]*)"'; [[ $input =~ $re ]] && file=\${BASH_REMATCH[1]}
    # A read answers after its own result is stored (the test files it as result-NAME): a lag counted from the
    # call's start is over before a read that a loaded machine runs slowly has ended. (A request waits for the
    # answer only as long as the hook's wait counts from the call's start: a read slower than that leaves its
    # answer late and owed, which the tests that read allow.)
    re='^echo (kw[0-9]+)$'
    if [ "$mode" = lagtool ] && [[ $cmd =~ $re ]]; then for ((n = 0; n < 1000; n++)); do [ -f "$dir/result-\${BASH_REMATCH[1]}" ] && break; sleep 0.01; done
    elif [ "$mode" = lagtool ]; then sleep ${sec(0.4)}; fi
    [ "$mode" = latetool ] && sleep ${sec(1.3)}
    # A command with "denyme" is stopped once a session, as the store's pre-tool hook stops one a rule forbids.
    if [[ "$cmd" == *denyme* ]] && ! grep -qx deny "$seen"; then
      echo deny >> "$seen"
      printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"tacit stopped this command once, before it ran: a rule of this owner is keyed to it.\\n- rule-denyme (past mistake): never run denyme.\\nIf the command is still right given this, run it again unchanged: tacit does not stop it again for these."}}'
      exit 0
    fi
    kws "$cmd $file"
    for w in "\${KW[@]}"; do give "rule-$w"; done
    [ -n "$out" ] && printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"# store: before this step\\\\n%s"}}\\n' "\${out%\\\\n}" ;;
esac
exit 0
`, { mode: 0o755 });
  const calls = (hook?: string) => readFileSync(join(sd, "calls"), "utf8").trim().split("\n").filter((l) => l && (!hook || l.startsWith(hook + " ")));
  return { bin, set, calls };
}

// An engine with the memory hooks on a store folder. The scripted model runs
// the calls a prompt lists: "tools=1,r2,w3,g4" runs `touch kw1` (a command that
// changes something), `echo kw2` (a read), then writes out/kw3.txt (in no
// checkout) and repo/kw4.txt (in one).
function memoryWorld(dir: string, bin: string, rules?: { quietAfter: number; sampleEvery: number }) {
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
      // "cmd=<base64>": one call of exactly that command.
      const given = req.messages.findLastIndex((m: any) => isPrompt(m) && /cmd=/.test(JSON.stringify(m)));
      if (given >= 0 && given === req.messages.findLastIndex(isPrompt) && !req.messages.slice(given + 1).some((m: any) => m.role === "assistant"))
        return { blocks: [{ type: "tool_use", id: `c${++n}`, name: "Bash", input: { command: Buffer.from(/cmd=([\w+/=]+)/.exec(JSON.stringify(req.messages[given]))![1]!, "base64").toString() } }], usage, stop: "tool_use", model: "m" };
      const at = req.messages.findLastIndex((m: any) => isPrompt(m) && /tools=/.test(JSON.stringify(m)));
      if (at >= 0 && at === req.messages.findLastIndex(isPrompt)) {
        // The newest list: after a summary one message holds the earlier prompts' words too.
        const plan = [...JSON.stringify(req.messages[at]).matchAll(/tools=([\w,+]+)/g)].at(-1)![1]!.split(",");
        const done = req.messages.slice(at + 1).filter((m: any) => m.role === "assistant").length;
        const step = plan[done];
        if (step) {
          // "r1+r2": the calls of one step, side by side.
          const blocks = step.split("+").map((one) => {
            const k = one.replace(/^\D/, "");
            const call = one[0] === "w" || one[0] === "g"
              ? { name: "Write", input: { file_path: join(dir, one[0] === "g" ? "repo" : "out", `kw${k}.txt`), content: "x" } }
              : { name: "Bash", input: { command: one[0] === "r" ? `echo kw${k}` : `touch kw${k}` } };
            return { type: "tool_use", id: `c${++n}`, ...call };
          });
          return { blocks, usage, stop: "tool_use", model: "m" };
        }
      }
      return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "m" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info] } as any;
  mkdirSync(join(dir, "repo", ".git"), { recursive: true });
  const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
  const tacit = new Tacit(store, bus, errors, bin, SPEED, rules);
  tacit.install();
  // A stored tool result releases the store's answer for the read that made it (see the stand-in's lagtool).
  bus.on((f) => {
    if (f.t !== "event" || f.event.kind !== "tool_result") return;
    for (const m of JSON.stringify(f.event.data.results).matchAll(/kw\d+/g)) writeFileSync(join(dir, "standin", `result-${m[0]}`), "");
  });
  const session = () => {
    return store.createSession({ title: "Fixture", model: "p:m", workspace: dir }).id;
  };
  // Sends an input; answers with how long its first request took to go.
  const say = async (id: string, text: string, meta?: Record<string, unknown>) => {
    const before = asked.length;
    const t0 = performance.now();
    engine.send(id, text, { meta });
    await engine.idle(id);
    return (asked.slice(before).find((r) => r.session === id)?.at ?? NaN) - t0;
  };
  // One turn that runs exactly this shell command.
  const run = (id: string, command: string) => say(id, `cmd=${Buffer.from(command).toString("base64")}`);
  const last = (id: string) => asked.findLast((r) => r.session === id)!.messages;
  const names = (text: string) => [...new Set([...text.matchAll(/- ((?:fact|rule)-kw\d+|start-rule):/g)].map((m) => m[1]!))];
  const told = (id: string) => store.events(id).filter((e) => e.kind === "note" && e.data.kind === "memory_out").length;
  const copies = (id: string, name: string) => last(id).split(`- ${name}:`).length - 1;
  return { store, bus, engine, tacit, session, say, run, last, names, told, copies, captured, asked };
}
// The errors the memory hooks file (other modules' hooks, left registered by
// earlier test files of a whole run, report into the same collector).
const memoryError = (m: string) => m.includes("memory store");
const until = async (what: () => boolean, ms = 15_000) => { const t = Date.now(); while (!what() && Date.now() - t < ms) await Bun.sleep(25); expect(what()).toBe(true); };
// A probe is asked again only while calls of its kind are being made (a test below shows it stops with nobody
// asking). How long a loaded machine takes between the last call of a test and the store's coming back is not
// the test's to guess, so the test asks again itself: a call starts a probe that is not running, and a call
// after a probe's start is what lets the next one be asked. Then the store answers.
async function askAgain(w: ReturnType<typeof memoryWorld>, session: string, words: string[]) {
  const probes = () => w.tacit.stats().processes.probes;
  const p0 = probes();
  await w.say(session, words[0]!);
  await until(() => probes() > p0, 30_000);
  await w.say(session, words[1]!);
}
const seq = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
async function inWorld(name: string, run: (w: ReturnType<typeof memoryWorld>, st: ReturnType<typeof standIn>, dir: string) => Promise<void>, rules?: { quietAfter: number; sampleEvery: number }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", `memory-${name}-`));
  const installed = allHooks().length;
  try {
    const st = standIn(dir);
    await run(memoryWorld(dir, st.bin, rules), st, dir);
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
  // Requests that are not typed: asked beside their request, not waited for; their facts come with the next request.
  for (const [text, meta, name] of [["Check the kw6 queue", { kind: "loop", loop_name: "x" }, "fact-kw6"], ["Make kw7 pass", { kind: "goal", goal: "start" }, "fact-kw7"], ["Verify kw8", { kind: "verify_goal" }, "fact-kw8"],
    ["report kw9\n\nsteer kw10", { kind: "wake", parts: [{ kind: "subagent" }, { kind: "steer" }] }, "fact-kw10"]] as const) {
    await w.say(s, text, meta);
    expect(w.names(w.last(s))).not.toContain(name);
    await until(() => w.tacit.owed(s) > 0);
    await w.say(s, "and then");
    expect(w.names(w.last(s))).toContain(name);
  }
  const { memoryMeter } = await import("./memory-meter.ts");
  const report = memoryMeter(w.store).report({ session: s });
  const prompt = report.paths.find((p) => p.path === "store_prompt")!;
  expect(prompt).toMatchObject({ asked: 13, recalls: 2, later: 4, empty: 4, skipped: 3, timeouts: 0 });
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
test("a tool hook that hangs stops the waiting for tool hooks only, after two in a row; a probe of its own ends the outage", () => inWorld("kinds", async (w, st) => {
  const a = w.session(), b = w.session();
  st.set("mode", "slowtool");
  const t0 = performance.now();
  await w.say(a, "A1 kw1 tools=50");
  // The prompt's fact came in its turn; the result of a call that changes
  // something waited the tool hook's wait. One late call: counted, no outage, nothing said.
  expect(w.names(w.last(a))).toContain("fact-kw1");
  expect(performance.now() - t0).toBeGreaterThan(T(800));
  expect(w.told(a)).toBe(0);
  expect(w.tacit.stats().out).toEqual({ ask: false, tool: false });
  expect(w.tacit.stats().hooks["pre-tool"].late).toBe(1);
  expect(w.captured.filter(memoryError)).toEqual([]);
  // The next one in a row: an outage of tool calls, said once.
  await w.say(a, "A1b kw11 tools=51");
  expect(w.told(a)).toBe(1);
  expect(w.tacit.stats().out).toEqual({ ask: false, tool: true });
  // Another session's prompt is waited for as ever, and gets its fact in the turn.
  await w.say(b, "B1 kw2");
  expect(w.names(w.last(b))).toContain("fact-kw2");
  expect(w.told(b)).toBe(0);
  // More turns with tool calls: no wait for the tool hook, prompts in their turn, no second note.
  const { memoryMeter: meter } = await import("./memory-meter.ts");
  const held = () => meter(w.store).report({ session: a }).paths.find((p) => p.path === "store_tool")!.wait_ms;
  for (const k of [3, 4, 5]) {
    const before = held();
    await w.say(a, `A kw${k} tools=${52 + k}`);
    expect(held() - before).toBeLessThan(T(400));
    expect(w.names(w.last(a))).toContain(`fact-kw${k}`);
  }
  expect(w.told(a)).toBe(1);
  expect(w.captured.filter((m) => m.includes("memory store"))).toHaveLength(1);
  // The store answers tool calls again: the probe finds out, with no prompt spent on it.
  await askAgain(w, a, ["A kw12 tools=58", "A kw13 tools=59"]);
  st.set("mode", "ok");
  await until(() => !w.tacit.stats().out.tool);
  await w.say(a, "A kw6 tools=60");
  expect(w.names(w.last(a))).toEqual(expect.arrayContaining(["fact-kw6", "rule-kw60"]));
  expect(w.told(a)).toBe(1);
  expect(w.tacit.stats().processes.probes).toBeGreaterThan(0);
}), 60_000);

// One call slower than a turn waits, among calls that answer: a loaded
// machine, not an outage. Counted, its answer still arrives, and nothing is
// filed or said. (The reviewer's case: one slow call opened a spell twice.)
test("one slow call is no outage: no error, no note, its answer still follows; a store that hangs is one outage", () => inWorld("spell", async (w, st) => {
  const s = w.session();
  await w.say(s, "first kw1 tools=1");
  // A prompt that takes 3 s once: the turn goes on after its wait.
  st.set("slow-once", "prompt");
  const waited = await w.say(s, "slow kw2");
  expect(waited).toBeLessThan(T(1_000));
  expect(w.names(w.last(s))).not.toContain("fact-kw2");
  // The call is late once the hook's wait is over, not when the request stopped holding for it.
  await until(() => w.tacit.stats().hooks.prompt.late === 1);
  expect(w.tacit.stats().out).toEqual({ ask: false, tool: false });
  expect(w.told(s)).toBe(0);
  expect(w.captured.filter(memoryError)).toEqual([]);
  expect(w.tacit.stats().processes.probes).toBe(0);
  // Its answer came after the turn went on: owed, and in the next request.
  await until(() => w.tacit.owed(s) > 0);
  await w.say(s, "fast kw3 tools=3"); // waited for as ever, and answered
  expect(w.names(w.last(s))).toEqual(expect.arrayContaining(["fact-kw2", "fact-kw3", "rule-kw3"]));
  // The same for one slow tool call among fast ones.
  st.set("slow-once", "pre-tool");
  await w.say(s, "slow tool kw4 tools=4");
  expect(w.tacit.stats().hooks["pre-tool"].late).toBe(1);
  await until(() => w.tacit.owed(s) > 0);
  await w.say(s, "after kw5 tools=5");
  expect(w.names(w.last(s))).toEqual(expect.arrayContaining(["rule-kw4", "rule-kw5"]));
  expect(w.tacit.stats().out).toEqual({ ask: false, tool: false });
  expect(w.told(s)).toBe(0);
  expect(w.captured.filter(memoryError)).toEqual([]);
  // A slow call, an answer in time, a slow call: still no two in a row.
  st.set("slow-once", "prompt");
  await w.say(s, "slow again kw6");
  await until(() => w.tacit.stats().hooks.prompt.late === 2);
  expect(w.tacit.stats().out.ask).toBe(false);
  expect(w.told(s)).toBe(0);
  await w.say(s, "answered kw61");
  expect(w.names(w.last(s))).toContain("fact-kw61");

  // A store that really hangs: two prompts in a row go unanswered, and that is one outage, one error, one note.
  st.set("mode", "slow");
  await w.say(s, "hang kw7");
  await until(() => w.tacit.stats().hooks.prompt.late === 3);
  expect(w.tacit.stats().out.ask).toBe(false);
  await w.say(s, "hang kw8");
  await until(() => w.tacit.stats().out.ask);
  for (const k of [9, 10]) expect(await w.say(s, `hang kw${k}`)).toBeLessThan(T(1_000));
  expect(w.told(s)).toBe(1);
  expect(w.captured.filter((m) => m.includes("did not answer in time"))).toHaveLength(1);
}), 90_000);

test("a store that hangs: two waits, then an outage said once and no wait after; a probe of its own ends it", () => inWorld("hang", async (w, st) => {
  const s = w.session();
  await w.say(s, "first kw1");
  st.set("mode", "slow");
  const waited = await w.say(s, "third kw3");
  expect(waited).toBeLessThan(T(1_000));
  await until(() => w.tacit.stats().hooks.prompt.late === 1);
  const notes = () => w.store.events(s).filter((e) => e.kind === "note" && e.data.kind === "memory_out");
  // One call not answered in time is counted, and measured as a timeout: no outage yet, nothing said.
  expect(notes()).toHaveLength(0);
  const { memoryMeter } = await import("./memory-meter.ts");
  const measured = () => memoryMeter(w.store).report({ session: s }).paths.find((p) => p.path === "store_prompt")!;
  expect(measured()).toMatchObject({ timeouts: 1, late: 0 });
  // The second in a row: the outage, said once, in a line for the owner that the model is not sent.
  expect(await w.say(s, "more kw4 tools=4")).toBeLessThan(T(1_000) + T(900) * 2);
  await until(() => notes().length === 1);
  expect(notes()[0]!.data.model).toBeUndefined();
  expect(w.last(s)).not.toContain("Memory did not answer");
  // From here prompts do not wait; the session's calls go out one at a time;
  // one line in the session, though both its prompts and its tool calls hang.
  for (const k of [5, 6, 7]) expect(await w.say(s, `more kw${k} tools=${k}`)).toBeLessThan(T(1_000));
  expect(notes()).toHaveLength(1);
  // Two waited for, then one made and still out, the next two not made while it is.
  expect(measured()).toMatchObject({ timeouts: 2, late: 1, skipped: 2 });
  expect(w.captured.filter((m) => m.includes("did not answer in time: turns"))).toHaveLength(1);
  const p = w.tacit.stats().processes;
  expect(p.not_started).toBeGreaterThan(0);
  expect(p.max).toBeLessThanOrEqual(p.limit);
  expect(w.tacit.stats().out).toEqual({ ask: true, tool: true });
  // It answers again: the probe finds out, with no prompt spent on it.
  await askAgain(w, s, ["more kw9 tools=9", "more kw10 tools=10"]);
  st.set("mode", "ok");
  await until(() => !w.tacit.stats().out.ask, 30_000);
  expect(w.tacit.stats().processes.probes).toBeGreaterThan(0);
  // So the next prompt is waited for and gets its fact in its own turn.
  await w.say(s, "back kw8");
  expect(w.names(w.last(s))).toContain("fact-kw8");
  expect(w.store.events(s).filter((e) => e.kind === "turn_end").every((e) => e.data.reason === "end_turn")).toBe(true);
}), 90_000);

test("during an outage: the probe stops with nobody asking; a new session's task is asked beside its start call; late answers are kept in the state", () => inWorld("late", async (w, st) => {
  const s = w.session();
  await w.say(s, "first kw1");
  // Two hung calls in a row count asking out; its probe starts while the store still hangs.
  st.set("mode", "slow");
  await w.say(s, "hung kw2");
  await w.say(s, "hung kw22");
  await until(() => st.calls("prompt").some((l) => l.includes("keel-probe")));
  st.set("mode", "ok");
  // Nobody asks anything: after its wait the probe is not asked again.
  await Bun.sleep(2 * 2_200 + 600);
  expect(w.tacit.stats().processes.probes).toBe(1);
  expect(w.tacit.stats().out.ask).toBe(true);
  // A new session's task while asking is still counted out: its request does
  // not wait, and both its start call and its prompt go to the store.
  const b = w.session();
  expect(await w.say(b, "task kw5", { kind: "task", agent_id: "x" })).toBeLessThan(T(1_000));
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

// Before a tool. Two things bind it: no rule the store would have given is
// lost, and a rule about an action is in the request the model answers by
// acting, when the store answers in time.
test("before a tool: a change is always asked; a file in no checkout never; a rule that comes with a read is in the next request", () => inWorld("tools", async (w, st, dir) => {
  const s = w.session();
  const asked = () => st.calls("pre-tool").filter((l) => l.includes(s)).length;
  const tools = () => w.tacit.stats().tools;
  // A call that changes something is asked every time, whatever the store answered before.
  await w.say(s, "one tools=1");
  expect(w.names(w.last(s))).toContain("rule-kw1");
  await w.say(s, "two tools=1,1,1");
  expect(asked()).toBe(4);
  // The store gains a rule for a change it had nothing for: the very next such call gets it, in its result.
  st.set("hidden", "rule-kw7");
  await w.say(s, "three tools=7");
  st.set("hidden", "");
  await w.say(s, "four tools=7");
  expect(asked()).toBe(6);
  expect(w.names(w.last(s))).toContain("rule-kw7");
  const results = () => w.store.events(s).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data.results));
  expect(results().at(-1)).toContain("rule-kw7");
  // The same for a read: asked every time. The store gains a rule after a
  // read got nothing; the same read, a moment later, brings it, and it is in
  // the request the model answers by making the change.
  st.set("hidden", "rule-kw8");
  await w.say(s, "read tools=r8");
  st.set("hidden", "");
  const from8 = w.asked.filter((r) => r.session === s).length;
  await w.say(s, "again tools=r8,8");
  expect(asked()).toBe(9);
  expect(w.names(w.asked.filter((r) => r.session === s)[from8 + 1]!.messages)).toContain("rule-kw8");

  // A file in no checkout: the store answers an edit only from the file's repository. Never asked.
  // (Unless the test's own folder sits in a checkout, where it is asked like any other.)
  const { inCheckout } = await import("./tacit-tools.ts");
  const before = asked();
  await w.say(s, "five tools=w20,w21,g22");
  if (!inCheckout(dir, "out/x")) {
    expect(asked()).toBe(before + 1);
    expect(tools().never_answered).toBe(2);
  }
  expect(w.names(w.last(s))).toContain("rule-kw22");
  expect(w.names(w.last(s))).not.toContain("rule-kw20");

  // The store's own steps (its command line in a shell) are always passed to it.
  const nav = w.session();
  for (let i = 0; i < 3; i++) await w.run(nav, "true; tacit fact some-name");
  expect(st.calls("pre-tool").filter((l) => l.includes(nav)).length).toBe(3);

  // A read that brings the rule about the change that follows it (the store
  // gives a script's rule when the script is read, and marks it given), with
  // a store that takes 0.4 s. The read's result is not held; the request the
  // model answers by making the change waits for the answer and carries the rule.
  st.set("mode", "lagtool");
  const read = w.session();
  await w.say(read, "warm tools=r90");
  const from = w.asked.filter((r) => r.session === read).length;
  await w.say(read, "notice tools=r30,31,r32");
  const reqs = w.asked.filter((r) => r.session === read).slice(from);
  // Request 1 asks for the read; request 2 is answered by the change; request 3 by the next read.
  expect(w.names(reqs[0]!.messages)).not.toContain("rule-kw30");
  expect(w.names(reqs[1]!.messages)).toContain("rule-kw30");
  expect(w.names(reqs[2]!.messages)).toEqual(expect.arrayContaining(["rule-kw30", "rule-kw31"]));
  expect(w.names(reqs[3]!.messages)).toContain("rule-kw32");
  // The read's rule came as a note beside its result, the change's in its own result; each once.
  const of = (id: string) => w.store.events(id).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data.results));
  expect(of(read).some((r) => r.includes("rule-kw30"))).toBe(false);
  expect(of(read).some((r) => r.includes("rule-kw31"))).toBe(true);
  for (const k of [30, 31, 32]) expect(w.copies(read, `rule-kw${k}`)).toBe(1);
  expect(tools().request_waits).toBeGreaterThanOrEqual(2);
  expect(w.tacit.owed(read)).toBe(0);

  // A tool hook slower than a turn waits, and only reads: the next request
  // waits the hook's wait for each, twice in a row is an outage, said once.
  st.set("mode", "latetool");
  const only = w.session();
  const t0 = performance.now(), waits0 = tools().request_waits;
  await w.say(only, "reads tools=r70,r71,r72,r73");
  expect(w.tacit.stats().out.tool).toBe(true);
  // Two requests waited, then none.
  expect(performance.now() - t0).toBeGreaterThan(T(1_600));
  expect(tools().request_waits - waits0).toBe(2);
  expect(w.told(only)).toBe(1);
  expect(w.captured.filter((m) => m.includes("did not answer a tool call in time"))).toHaveLength(1);
}), 120_000);

// What reaches a request from owed lines. On its own tool result each answer
// would have had a block to itself, so in the note of the next request each
// has one too; and a line longer than a block comes through in parts, whole.
test("the answers of one step's reads each get a block of their own; a line longer than two blocks comes through whole", () => inWorld("blocks", async (w, st) => {
  const s = w.session();
  await w.say(s, "start");
  // Three reads in one step, each with a rule of 6,000 characters, from a
  // store that answers after the reads are done: none is in a result.
  st.set("len", 6000);
  st.set("mode", "lagtool");
  const from = w.asked.filter((r) => r.session === s).length;
  const calls = () => w.tacit.stats().hooks["pre-tool"];
  const ended = () => Object.values(calls().outcomes).reduce((a, b) => a + b, 0);
  const [endedBefore, lateBefore] = [ended(), calls().late];
  await w.say(s, "reads tools=r1+r2+r3");
  st.set("mode", "ok");
  // The store's three answers are in. (The request after the reads waits for each as long as a tool call is
  // waited for and goes on; three store processes at once on a loaded machine can take longer than that, and
  // the last answer then comes after the turn: it is waited for here, not assumed to have come.)
  for (const t0 = performance.now(); ended() < endedBefore + 3 && performance.now() - t0 < 30_000;) await Bun.sleep(10);
  expect(ended()).toBe(endedBefore + 3);
  const next = w.asked.filter((r) => r.session === s)[from + 1]!.messages;
  const rules = ["rule-kw1", "rule-kw2", "rule-kw3"];
  expect(w.store.events(s).filter((e) => e.kind === "tool_result").some((e) => JSON.stringify(e.data.results).includes("rule-kw"))).toBe(false);
  // Answered within the wait, all three are in the request after the reads. One that came later is owed:
  // it is in that request or waits for the next one, never lost.
  if (calls().late === lateBefore) {
    expect(w.names(next)).toEqual(expect.arrayContaining(rules));
    expect(w.tacit.owed(s)).toBe(0);
  } else if (!rules.every((r) => w.names(next).includes(r))) expect(w.tacit.owed(s)).toBeGreaterThan(0);
  // A fact of 25,000 characters: its start in the prompt's block, the rest with the next requests, all of it.
  st.set("len", 25000);
  await w.say(s, "long kw9");
  // The store builds 25,000 characters in a program of its own: slower than the request holds for the recall
  // of a typed prompt (the hold's fraction of a second here), so the answer is in that request or comes after
  // it and is owed. Either way it is here before the rest is asked for.
  await until(() => w.last(s).includes("fact-kw9") || w.tacit.owed(s) > 0, 30_000);
  for (let i = 0; i < 6 && w.tacit.owed(s); i++) await w.say(s, "go on");
  expect(w.tacit.owed(s)).toBe(0);
  // Each rule reached the model, once.
  expect(w.names(w.last(s))).toEqual(expect.arrayContaining(rules));
  for (const r of rules) expect(w.copies(s, r)).toBe(1);
  const xs = (w.last(s).match(/x{100,}/g) ?? []).reduce((n, m) => n + m.length, 0);
  expect(xs).toBe(3 * 6000 + 25000);
}), 60_000);

// A store that is late now and then never misses twice in a row. It is said
// all the same, once per session, while a quarter of its last calls were late.
// (Fed with late and answered calls directly: real waits on a loaded machine
// make an answered call late now and then, which is what this rule is for.)
test("a store that is slow every few calls opens no outage and is said once per session while it lasts", () => inWorld("degraded", async (w) => {
  const s = w.session();
  await w.say(s, "start");
  const t = w.tacit as any;
  const late = () => t.miss("tool", "pre-tool", s);
  const answered = () => t.ended("tool", "empty", true, s);
  const slow = () => w.store.events(s).filter((e) => e.kind === "note" && e.data.kind === "memory_slow");
  // Twenty calls, every fourth late: no two in a row.
  for (let i = 0; i < 20; i++) {
    if (i === 19) expect(w.tacit.stats().degraded.tool).toBe(false);
    if (i % 4 === 3) late(); else answered();
  }
  expect(w.tacit.stats().out.tool).toBe(false);
  expect(w.captured.filter(memoryError)).toEqual([]);
  expect(w.tacit.stats().hooks["pre-tool"].late).toBe(5);
  expect(w.tacit.stats().degraded.tool).toBe(true);
  // Said at the late call that made it a quarter of the last twenty: a line for the owner, once.
  expect(slow()).toHaveLength(1);
  expect(slow()[0]!.data.model).toBeUndefined();
  expect(String(slow()[0]!.data.text)).toContain("5 of its last 20");
  // Not said again while it lasts, whatever the other kind of call does meanwhile.
  answered(); late(); t.ended("ask", "hit", true, s); answered(); late();
  expect(slow()).toHaveLength(1);
  expect(w.told(s)).toBe(0);
  // It answers again for a while: no longer said to be slow, and said anew if it comes back.
  for (let i = 0; i < 20; i++) answered();
  expect(w.tacit.stats().degraded.tool).toBe(false);
  for (let i = 0; i < 20; i++) { if (i % 3 === 2) late(); else answered(); }
  expect(slow()).toHaveLength(2);
  // Two in a row are an outage, as ever.
  late(); late();
  expect(w.tacit.stats().out.tool).toBe(true);
}), 30_000);

test("a session's first prompt waits for the start block; a start slower than the wait is not killed, and its block follows", () => inWorld("start", async (w, st) => {
  st.set("mode", "slowstart");
  const s = w.session();
  // An agent's task, sent at once: the standing rules are in its first request.
  const waited = await w.say(s, "the task: kw1", { kind: "task", agent_id: "x" });
  expect(waited).toBeGreaterThan(T(2_300));
  expect(waited).toBeLessThan(T(START_WAIT_MS));
  expect(w.names(w.asked.find((r) => r.session === s)!.messages)).toEqual(["start-rule", "fact-kw1"]);
  expect(w.told(s)).toBe(0);

  // A start that takes longer than the wait (a slow sync): the request goes after the wait
  // without the block, and the process is left to finish.
  st.set("mode", "slowstart7");
  const slow = w.session();
  const held = await w.say(slow, "another task: kw2", { kind: "task", agent_id: "y" });
  expect(held).toBeGreaterThanOrEqual(T(START_WAIT_MS) - 50);
  expect(held).toBeLessThan(T(7_000));
  expect(w.names(w.last(slow))).toEqual(["fact-kw2"]);
  // One late call: counted, not an outage, nothing said.
  expect(w.tacit.stats().hooks["session-start"].late).toBe(1);
  expect(w.told(slow)).toBe(0);
  expect(w.tacit.stats().out.ask).toBe(false);
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

test("what a session was given is kept by name, only for names the store gives a fact, and goes with the session", () => inWorld("given", async (w) => {
  const s = w.session();
  await w.say(s, "first kw1");
  const rows = () => w.store.db.query<{ name: string; hook: string; path: string }, [string]>("SELECT name, hook, path FROM memory_given WHERE session_id = ? ORDER BY id").all(s);
  expect(rows()).toEqual([{ name: "start-rule", hook: "session-start", path: "store_start" }, { name: "fact-kw1", hook: "prompt", path: "store_prompt" }]);
  expect(w.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM memory_given WHERE session_id = ? AND used IS NULL").get(s)!.n).toBe(0);
  // A line of another shape has its text where a name would be: it gets no row.
  const { memoryMeter, factOf } = await import("./memory-meter.ts");
  const meter = memoryMeter(w.store);
  meter.record(s, "store_prompt", { outcome: "added", text: "x", facts: [factOf("- The deploy token X lives in the vault at corp: never paste it"), factOf("- Has_Upper.dot: text"), factOf("- good-name: text")], by: { hook: "prompt" } });
  expect(rows().map((r) => r.name)).toEqual(["start-rule", "fact-kw1", "good-name"]);
  expect(meter.openGiven(s).size).toBe(1);
  // The rows go with their session, a part at a time between other work (never one statement over all of them
  // on the loop), and a block recorded for a session that is gone writes none and throws nothing.
  const many = w.store.db.query("INSERT INTO memory_given (session_id, ts, recall, path, hook, name, tokens) VALUES (?, 1, 1, 'store_prompt', 'prompt', 'filler', 1)");
  w.store.db.transaction(() => { for (let i = 0; i < 1200; i++) many.run(s); })();
  w.store.deleteSession(s);
  expect(rows().length).toBe(1203); // nothing went with the delete itself
  await until(() => rows().length === 0);
  meter.record(s, "store_owed", { outcome: "added", text: "x", facts: [factOf("- good-name: text")], by: { hook: "prompt" } });
  expect(rows()).toEqual([]);
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
  writeFileSync(join(dir, "transcripts", "01aaaaaa-0000-7000-8000-000000000001.mark"), "{}");
  const fresh = new Tacit(w.store, w.bus, { capture: () => ({ message: "" }) } as any, st.bin);
  const hooks = allHooks().length;
  fresh.install();
  allHooks().length = hooks;
  // (The kept session's file and the mark beside it stay.)
  expect(readdirSync(join(dir, "transcripts")).sort()).toEqual([`${b}.jsonl`, `${b}.mark`]);
}), 30_000);

// A long session's transcript written whole (its first one, or after its model
// changed) is encoded and written in slices before the hook asks for it, the
// loop given back between them: in one piece it held the loop for seconds.
test("a long session's transcript is written whole in slices: the same records, the loop free in between", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-tacit-slices-"));
  const store = new Store(dir);
  try {
    const errors = { capture: () => {} } as unknown as ErrorTracker;
    const s = store.createSession({ title: "Fixture", model: "fixture:model", workspace: dir });
    const fill = (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        if (i % 3 === 0) store.append(s.id, "user", { text: `prompt ${i}` });
        else if (i % 3 === 1) store.append(s.id, "assistant", { blocks: [{ type: "text", text: `reply ${i}` }, { type: "tool_use", id: `c${i}`, name: "Bash", input: { command: `echo ${i}` } }], model: "fixture:model", stop: "tool_use" });
        else store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: `c${i - 1}`, content: `out ${i}` }] });
        if (i === 400) store.append(s.id, "compaction", { mode: "summary", summary: "what came before" });
      }
    };
    fill(0, 900);
    // The records without their random ids: each names the place of the record it hangs under.
    const shape = (text: string) => {
      const rows = text.trimEnd().split("\n").map((l) => JSON.parse(l));
      const at = new Map(rows.map((r, i) => [r.uuid, i]));
      return rows.map((r) => ({ ...r, uuid: undefined, parentUuid: r.parentUuid === null ? null : at.get(r.parentUuid) }));
    };
    const tacit = new Tacit(store, new Bus(), errors, null);
    const path = tacit.transcriptPath(s);
    let turns = 0, done = false;
    const tick = () => { if (!done) { turns++; setImmediate(tick); } };
    setImmediate(tick);
    const writing = (tacit as any).warmTranscript(store.session(s.id)!) as Promise<void>;
    // Stored while the slices are written: it is in the file all the same.
    store.append(s.id, "user", { text: "stored meanwhile" });
    await writing;
    done = true;
    expect(turns).toBeGreaterThanOrEqual(3); // four slices of 256 events
    expect(tacit.stats().transcript).toMatchObject({ rebuilt: 1, reused: 0, appended: 0, failed: 0 });
    const sliced = readFileSync(path, "utf8");
    // The hook's own call finds the file as it is: nothing is written again.
    expect(tacit.transcript(store.session(s.id)!)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(sliced);
    expect(tacit.stats().transcript).toMatchObject({ rebuilt: 1, reused: 1 });
    expect(readdirSync(join(dir, "transcripts")).sort()).toEqual([`${s.id}.jsonl`, `${s.id}.mark`]);
    // The same records as the one-piece write gives.
    rmSync(path);
    rmSync(join(dir, "transcripts", `${s.id}.mark`));
    const plain = new Tacit(store, new Bus(), errors, null);
    const whole = readFileSync(plain.transcript(store.session(s.id)!), "utf8");
    expect(shape(sliced)).toEqual(shape(whole));
    expect(sliced).toContain("stored meanwhile");
    // What comes after is appended to it, as to any transcript.
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "after the slices" }], model: "fixture:model", stop: "end_turn" });
    await (plain as any).warmTranscript(store.session(s.id)!);
    plain.transcript(store.session(s.id)!);
    expect(plain.stats().transcript).toMatchObject({ rebuilt: 1, appended: 1 });
    // A session that shows another branch while its slices are written publishes nothing; the hook's call writes it in one piece.
    const third = new Tacit(store, new Bus(), errors, null);
    rmSync(path);
    rmSync(join(dir, "transcripts", `${s.id}.mark`));
    const first = store.lineage(s.id)[0]!;
    const cut = (third as any).writeWhole(s.id) as Promise<boolean>;
    await new Promise<void>((r) => setImmediate(r)); // its first slice is written
    store.append(s.id, "user", { text: "another branch" }, first.id);
    expect(await cut).toBe(false);
    expect(readdirSync(join(dir, "transcripts"))).toEqual([]);
    expect(readFileSync(third.transcript(store.session(s.id)!), "utf8")).toContain("another branch");
    expect(third.stats().transcript).toMatchObject({ rebuilt: 1, failed: 0 });
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A long branch with no transcript yet (an import): written whole in one
// piece it was encoded on the loop, megabytes at once. In parts it is the
// same file, the loop turns while it is written, and the call that hands the
// path out finds it and appends only what came since.
test("a long branch's first transcript is written in parts: the same bytes, the loop turning, then found and appended to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tacit-transcript-parts-"));
  const store = new Store(dir);
  try {
    const errors = { capture: () => ({ message: "" }) } as unknown as ErrorTracker;
    const s = store.createSession({ title: "Fixture", model: "fixture:model", workspace: dir });
    for (let i = 0; i < 900; i++) {
      store.append(s.id, "user", { text: `Prompt ${i}` });
      store.append(s.id, "assistant", { blocks: [{ type: "thinking", thinking: "t".repeat(200), signature: "sig" }, { type: "text", text: `Reply ${i}` }, { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `ls ${i}` } }] });
      store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(1500) }] });
    }
    // In one piece, as before: what the file must be.
    const whole = new Tacit(store, new Bus(), errors, null);
    const path = whole.transcript(s);
    // (Record ids and times are made as a record is: the two files are compared without them.)
    const shape = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l)).map((r, i, all) => ({ ...r, uuid: i, parentUuid: r.parentUuid === null ? null : all.findIndex((x) => x.uuid === r.parentUuid) }));
    const want = shape(readFileSync(path, "utf8"));
    expect(want.length).toBeGreaterThan(2700);
    rmSync(path);
    rmSync(join(dir, "transcripts", `${s.id}.mark`), { force: true });

    const parts = new Tacit(store, new Bus(), errors, null);
    // (Counted by a job that runs once each turn of the loop, not by a clock: eleven parts, a turn after each.)
    let turns = 0, writing = true;
    const turn = () => { turns++; if (writing) setImmediate(turn); };
    setImmediate(turn);
    await parts.transcriptInParts(s);
    writing = false;
    expect(turns).toBeGreaterThanOrEqual(10);
    const got = shape(readFileSync(path, "utf8"));
    expect(got).toEqual(want);
    // Each record follows the one before it, across the parts.
    expect(got.map((r) => r.parentUuid)).toEqual([null, ...got.slice(0, -1).map((r) => r.uuid)]);
    expect(parts.stats().transcript).toMatchObject({ rebuilt: 1, appended: 0, reused: 0 });
    // The call that hands the path out writes nothing more; an event that came since is appended.
    expect(parts.transcript(s)).toBe(path);
    expect(parts.stats().transcript).toMatchObject({ rebuilt: 1, appended: 0, reused: 1 });
    store.append(s.id, "user", { text: "After the parts" });
    await parts.transcriptInParts(s);
    parts.transcript(s);
    expect(parts.stats().transcript).toMatchObject({ rebuilt: 1, appended: 1, reused: 1 });
    expect(JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).message.content).toBe("After the parts");
    expect(readdirSync(join(dir, "transcripts")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // A short branch is left to the call itself.
    const short = store.createSession({ title: "Fixture", model: "fixture:model", workspace: dir });
    store.append(short.id, "user", { text: "hi" });
    await parts.transcriptInParts(short);
    expect(existsSync(join(dir, "transcripts", `${short.id}.jsonl`))).toBe(false);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A call that never reached its end (here: refused after it was asked about) leaves nothing that a
// call of another session with the same id picks up; a run_code program's own calls get no block.
test("a memory block goes only to the call it was asked for, and never to a program's own call", () => inWorld("scope", async (w) => {
  const a = w.store.session(w.session())!, b = w.store.session(w.session())!;
  const h = allHooks().find((x) => x.beforeTool && x.afterTool && x.turnEnd)!;
  const call = (id: string, command: string, ctx: any = {}) => ({ id, tool: { name: "Bash" } as any, input: { command }, ctx });
  await h.beforeTool!(a, call("same-id", "touch kw1") as any);
  await h.toolFailed?.(a, call("same-id", "touch kw1") as any, { type: "tool_result", tool_use_id: "same-id", content: "" } as any, new Error("refused"));
  const res: any = { type: "tool_result", tool_use_id: "same-id", content: "1\tx" };
  await h.afterTool!(b, { id: "same-id", tool: { name: "Read" } as any, input: { file_path: "/x" }, ctx: {} } as any, res);
  expect(res.content).toBe("1\tx");
  // A call made inside a run_code program.
  const nested = call("inner", "touch kw2", { nestedIn: "outer" });
  await h.beforeTool!(a, nested as any);
  const out: any = { type: "tool_result", tool_use_id: "inner", content: '{"a":1}' };
  await h.afterTool!(a, nested as any, out);
  expect(out.content).toBe('{"a":1}');
}), 60_000);

test("a kind of tool call the store has nothing for is asked only now and then, unwaited; one fact and it is asked in full again", () => inWorld("quiet", async (w, st, dir) => {
  const s = w.session();
  const asked = (id: string) => st.calls("pre-tool").filter((l) => l.includes(id)).length;
  // A call of a quiet kind is asked beside its tool and not waited for, so the stand-in's log
  // reaches a count a moment after the call returns: wait for the count, then it must be exactly it.
  // (A call that is not asked adds nothing: the count is then checked at once, after the one before it.)
  const asks = async (id: string, n: number) => { await until(() => asked(id) >= n); expect(asked(id)).toBe(n); };
  // Three shell commands answered with nothing: the kind is quiet.
  for (let i = 0; i < 3; i++) await w.run(s, "touch plain");
  await asks(s, 3);
  // Then one call in two is asked, and the result of a change is not held for it.
  for (let i = 0; i < 4; i++) await w.run(s, "touch plain");
  await asks(s, 5);
  expect(w.tacit.stats().tools).toMatchObject({ quiet_skipped: 2, quiet_asked: 2 });
  await until(() => w.tacit.stats().quiet[0]?.quiet === 5);
  expect(w.tacit.stats().quiet).toEqual([{ kind: "shell", quiet: 5 }]);
  // A program is asked once to learn whether the store answers its calls (a rule tied to `git push`
  // comes with the first `git` call). Then its calls are asked only in the sample while the store
  // answers none of them, whatever the command's words or the session.
  await w.run(s, "git push origin");
  await asks(s, 6);
  await w.run(s, "git push origin");
  await asks(s, 6);
  await w.run(s, "git push origin main"); // the one call in two the count asks
  await asks(s, 7);
  await w.run(s, "git push origin x");
  await asks(s, 7);
  // A new session's first call of a program is not asked for being its first: this one is a program
  // never asked (asked to learn it), the next one is of a program the store answered nothing for.
  const t = w.session();
  await w.run(t, "echo plain");
  await asks(t, 1);
  await w.run(t, "touch plain");
  await asks(t, 1);
  // A call that names the store is asked in full.
  await w.run(t, "tacit fact some-name");
  await asks(t, 2);
  // Another kind is asked in full, its own count.
  await w.say(t, "edit tools=g5");
  expect(w.names(w.last(t))).toContain("rule-kw5");
  // The store starts answering the quiet kind: the next asked call gets its rule, a step later
  // (nothing waited for it), and the kind is asked in full again.
  let got = false;
  for (let i = 0; i < 3 && !got; i++) { await w.run(t, `cd . && touch kw9`); await w.say(t, "next"); got = w.names(w.last(t)).includes("rule-kw9"); }
  expect(got).toBe(true);
  await until(() => !w.tacit.stats().quiet.length);
  const before = asked(t);
  await w.run(t, "touch plain");
  await w.run(t, "touch plain");
  await asks(t, before + 2);
  // How each kind answered is kept: a daemon that starts again goes on from it.
  await w.run(t, "touch plain");
  // The store answered a `touch` call: a new session's `touch` call is asked when its kind is quiet,
  // and a `git` call, which it never answered, is not. The families are kept too.
  await until(() => w.tacit.stats().quiet[0]?.quiet === 3);
  const u = w.session();
  await w.run(u, "touch plain");
  await asks(u, 1);
  await w.run(u, "git push elsewhere");
  await asks(u, 1);
  // The answer came with `cd . && touch kw9`: it speaks for `touch`, which its rule is about, not for the `cd` before it.
  await w.run(u, "touch plain");
  await asks(u, 2);
  await w.run(u, "cd .");
  await asks(u, 2);
  const again = new Tacit(w.store, w.bus, { capture: () => ({}) } as any, st.bin, SPEED, { quietAfter: 3, sampleEvery: 2 });
  expect(again.stats().quiet).toEqual([{ kind: "shell", quiet: 3 }]);
  // The time of the hook processes is in the meter, for the asks nobody waited for as for the rest.
  const proc = () => w.store.db.query<{ asked: number; ms: number; unwaited: number }, []>("SELECT COUNT(*) AS asked, COALESCE(SUM(proc_ms), 0) AS ms, COALESCE(SUM(wait_ms = 0 AND proc_ms > 0), 0) AS unwaited FROM telemetry_memory WHERE path = 'store_tool' AND outcome != 'skipped'").get()!;
  await until(() => proc().unwaited > 0);
  expect(proc().ms).toBeGreaterThan(0);
  void dir;
}, { quietAfter: 3, sampleEvery: 2 }), 120_000);

// An agent is a session another one started. It gets no start block (its parent's standing rules and
// titles it cannot open), and its brief is asked beside its first request, not waited for: what the
// store returns for it joins the next request. The owner's typed prompt is the one that waits.
test("an agent gets no start block, and its brief is asked unwaited; the owner's typed prompt waits", () => inWorld("agents", async (w, st) => {
  const owner = w.session(), agent = w.session();
  if (!w.store.columnExists("sessions", "parent_id")) w.store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  w.store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(owner, agent);
  // The typed prompt waits for the store (its answer is quick, so it is in the first request).
  await w.say(owner, "typed kw1");
  expect(w.names(w.last(owner))).toEqual(expect.arrayContaining(["start-rule", "fact-kw1"]));
  st.set("mode", "lagprompt");
  // The brief does not: the first request goes at once and the fact is in the one after the tool call.
  expect(await w.say(agent, "kw5 tools=1", { kind: "task", agent_id: "x" })).toBeLessThan(T(1_000));
  const mine = w.asked.filter((r) => r.session === agent);
  expect(mine[0]!.messages).not.toContain("fact-kw5");
  await until(() => w.tacit.owed(agent) > 0);
  await w.say(agent, "next", { kind: "steer", agent_id: "x" });
  expect(w.names(w.last(agent))).toContain("fact-kw5");
  expect(w.names(w.last(agent))).not.toContain("start-rule");
  expect(st.calls("session-start").filter((l) => l.includes(agent))).toEqual([]);
  expect(st.calls("prompt").filter((l) => l.includes(agent)).length).toBeGreaterThan(0);
  const { memoryMeter } = await import("./memory-meter.ts");
  const report = () => Object.fromEntries(memoryMeter(w.store).report({ session: agent }).paths.map((p) => [p.path, p]));
  await until(() => report().store_prompt?.asked === 2);
  const paths = report();
  expect(paths.store_start).toBeUndefined();
  expect(paths.store_prompt).toMatchObject({ asked: 2, later: 1, empty: 1 });
  expect(paths.store_prompt!.wait_ms).toBeLessThan(T(500));
  expect(paths.store_prompt!.proc_ms).toBeGreaterThan(0);
}), 60_000);

// The recall of a typed prompt holds the turn's first request for PROMPT_HOLD_MS at most, though the store's
// answer may take up to the hook's wait before it counts as late: past the hold the request goes without it,
// the answer is owed and joins the next request, and the store is not called slow for it.
test("a typed prompt's recall holds the first request for the hold at most; its late answer joins the next request", () => inWorld("hold", async (w, st) => {
  const s = w.session();
  await w.say(s, "warm kw1");
  st.set("mode", "lagprompt");
  const before = w.asked.filter((r) => r.session === s).length;
  const took = await w.say(s, "typed kw2");
  const mine = w.asked.filter((r) => r.session === s).slice(before);
  expect(mine[0]!.messages).not.toContain("fact-kw2");
  // The stand-in takes 1.8 s (0.6 s here); a request that waited for it took at least that.
  expect(took).toBeLessThan(T(1_700));
  await until(() => w.tacit.owed(s) > 0);
  st.set("mode", "ok");
  await w.say(s, "next kw3");
  expect(w.names(w.last(s))).toEqual(expect.arrayContaining(["fact-kw2", "fact-kw3"]));
  // It answered within the hook's wait: no late call, no outage, however many.
  st.set("mode", "lagprompt");
  await w.say(s, "typed kw4");
  await w.say(s, "typed kw5");
  expect(w.tacit.stats().out.ask).toBe(false);
  const { memoryMeter } = await import("./memory-meter.ts");
  const row = memoryMeter(w.store).report({ session: s }).paths.find((p) => p.path === "store_prompt")!;
  expect(row.timeouts).toBeGreaterThan(0);
}), 60_000);

// Since 0.9.38 the store's pre-tool hook answers with a deny (once a session, for a shell command a fact
// forbids), never with context. The commands it can stop are the keys of its deny file: a call that starts
// with one waits for the hook and is refused with the rule; any other is asked beside its tool, and a deny
// that comes after it ran is told with its result.
test("a shell command a stored rule forbids is refused with the rule; a deny that comes after the command ran is told with its result", () => inWorld("deny", async (w, _st, dir) => {
  const before = process.env.TACIT_STATE_DIR;
  process.env.TACIT_STATE_DIR = join(dir, "tacit-state");
  mkdirSync(process.env.TACIT_STATE_DIR, { recursive: true });
  writeFileSync(join(process.env.TACIT_STATE_DIR, "deny-keys.json"), JSON.stringify({ built: "2026-11-24T00:00:00Z", facts: [{ key: ["touch", "denyme-2", "--all"], name: "never-touch-denyme" }] }));
  try {
    const s = w.session(), t = w.session();
    // A command the store cannot stop: asked beside the call, which runs; the rule comes with its result.
    await w.run(s, "touch denyme-1");
    expect(existsSync(join(dir, "denyme-1"))).toBe(true);
    expect(w.last(s)).toContain("never run denyme");
    expect(w.last(s)).not.toContain("tacit stopped this command once");
    expect(w.tacit.stats().tools.deny_waits).toMatchObject({ n: 0, denied: 0 });
    // The shell kind goes quiet (nothing came for three calls): a command a key names is asked in full all the same.
    for (let i = 0; i < 4; i++) await w.run(s, "echo plain");
    await until(() => (w.tacit.stats().quiet[0]?.quiet ?? 0) >= 3);
    // A command the key names: the call waits for the store, and is refused with its own words.
    await w.run(t, "touch denyme-2 here");
    expect(existsSync(join(dir, "denyme-2"))).toBe(false);
    expect(w.last(t)).toContain("tacit stopped this command once");
    expect(w.last(t)).toContain("never run denyme");
    expect(w.tacit.stats().tools.deny_waits).toMatchObject({ n: 1, denied: 1, timeouts: 0 });
    // The store does not stop it again: run unchanged, it runs (and waited for the answer again).
    await w.run(t, "touch denyme-2 here");
    expect(existsSync(join(dir, "denyme-2"))).toBe(true);
    expect(w.tacit.stats().tools.deny_waits).toMatchObject({ n: 2, denied: 1 });
    // A command no key names does not wait.
    await w.run(t, "echo plain");
    expect(w.tacit.stats().tools.deny_waits.n).toBe(2);
    // The meter has the refusal as a recall.
    expect(w.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_memory WHERE path = 'store_tool' AND outcome = 'added'").get()!.n).toBeGreaterThanOrEqual(2);
  } finally {
    if (before === undefined) delete process.env.TACIT_STATE_DIR; else process.env.TACIT_STATE_DIR = before;
  }
}, { quietAfter: 3, sampleEvery: 1000 }), 60_000);

// A session another harness runs is only shown here (src/core/outside.ts): the store hears nothing of it,
// not when it appears, not when it is archived, and its switches say so. A session of Keel's beside it is the control.
test("an outside session sends nothing to the memory store: no start, no pre-compact on archive, both switches off", () => inWorld("outside", async (w, st, dir) => {
  const mark = { harness: "claude" as const, source_id: "src-1", state: "working" as const, since: Date.now(), files: 0, failures: 0 };
  const out = w.store.createSession({ title: "Elsewhere CANARY", model: "p:m", workspace: dir });
  w.store.updateSession(out.id, { outside: mark });
  w.store.append(out.id, "user", { text: "CANARY words typed in the other harness" });
  const mine = w.session();
  expect(w.tacit.flags(out.id)).toEqual({ use_memory: false, feed_memory: false });
  expect(w.tacit.flags(mine)).toEqual({ use_memory: true, feed_memory: true });
  // Its first frame (a fresh session with no events would ask for its start) and its archive (a dream of it).
  const fresh = w.store.createSession({ title: "Elsewhere too", model: "p:m", workspace: dir });
  w.bus.emit({ t: "session", session: w.store.updateSession(fresh.id, { outside: mark }) });
  w.bus.emit({ t: "session", session: w.store.updateSession(out.id, { archived: true }) });
  w.store.append(mine, "user", { text: "mine" });
  w.bus.emit({ t: "session", session: w.store.updateSession(mine, { archived: true }) });
  await until(() => st.calls("pre-compact").some((l) => l.includes(mine)));
  const all = st.calls();
  expect(all.filter((l) => l.includes(out.id) || l.includes(fresh.id))).toEqual([]);
  expect(existsSync(join(w.store.stateDir, "transcripts", `${out.id}.jsonl`))).toBe(false);
  expect(w.tacit.transcriptPath(w.store.session(out.id)!)).not.toContain(out.id);
}), 30_000);
