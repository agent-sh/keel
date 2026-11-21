#!/usr/bin/env bun
// The memory system's efficiency, measured on generated data only: what each
// recall path adds to a turn, whether the reply uses it, what is recalled
// again, what it costs before the first request, and what a slow or failing
// store does to a turn. `bun scripts/bench/memory.ts` prints the tables;
// `--json FILE` also writes the numbers.
//
// Nothing here reads a real store, session or model. The external store is a
// generated stand-in script (facts and rules made up below, answered by word
// overlap, in the block format the hook returns); the helper's records are
// generated; the model is a scripted one that names a fact in its reply when
// the turn's task needs that fact and the context holds it. Everything runs
// in one process on a scratch state folder that is removed at the end.
//
// The paths measured:
//   external store, session start   one block with the first prompt
//   external store, per prompt      one block per prompt
//   external store, per tool call   a block appended to a call's result
//   helper records                  the <remembered> block of a helper prompt
// A fact counts as used when the reply of the turn that got it names it;
// as repeated when the same line was already added earlier in the session
// and is still in the context; as lost when the store gave it to the session
// (a store that gives a fact once will not give it again) and no request of
// the session ever carried it. Lost must be 0: saving tokens or time never
// costs a fact. A last section measures the before-a-tool path on a working
// session: tool calls, calls made to the store, the store's process time,
// the time tool results were held for it, rules delivered and rules lost. For the helper's records, a relevance check asks about a known
// record by words of its text and counts how often that record is recalled.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.HOME + "/.cache", "keel-bench-memory-"));
process.env.KEEL_CONFIG_DIR = join(root, "config");
process.env.KEEL_DESKTOP_NOTIFY = "off";
mkdirSync(process.env.KEEL_CONFIG_DIR, { recursive: true });

const src = (p: string) => join(import.meta.dir, "../../src", p);
const { Store } = await import(src("core/store.ts"));
const { Bus } = await import(src("core/bus.ts"));
const { Engine } = await import(src("engine/turn.ts"));
const { allHooks } = await import(src("engine/hooks.ts"));
const { bytesPerToken } = await import(src("engine/compact.ts"));
const { lineage } = await import(src("core/tree.ts"));
const { Tacit } = await import(src("integrations/tacit.ts"));
const { Helper } = await import(src("helper/helper.ts"));
// The daemon's own content-free measurement of the same runs, where this tree has it.
const meterOf: ((store: unknown) => { report(f?: { session?: string }): any }) | null = await import(src("integrations/memory-meter.ts")).then((m) => m.memoryMeter, () => null);
function metered(store: unknown, sessionId: string) {
  const r = meterOf?.(store).report({ session: sessionId });
  if (!r) return;
  console.log("  as the daemon measured it (Settings > Usage): " + r.paths.map((p: any) => `${p.path} asked ${p.asked}, added ${p.recalls} (${p.facts} facts, ${p.tokens} tokens), named in reply ${p.used} of ${p.facts_checked}, not added again ${p.repeats}, carried to a later step ${p.cut}, not asked ${p.skipped}, waited ${Math.round(p.wait_ms)} ms`).join("; "));
  return r;
}

// --- generated data -------------------------------------------------------------

let seed = 20240611;
// Math.imul: a plain multiply leaves the integers and the sequence falls into a short cycle.
const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 8) % n;
const SYL = ["zor", "vel", "min", "ta", "quo", "ren", "dax", "ilo", "pem", "bra", "sut", "ko", "wyn", "fa", "gri", "lum", "ost", "ejo"];
const made = new Set<string>();
function word(): string {
  for (;;) {
    const w = SYL[rnd(SYL.length)]! + SYL[rnd(SYL.length)]! + SYL[rnd(SYL.length)]! + SYL[rnd(SYL.length)]!;
    if (!made.has(w)) { made.add(w); return w; }
  }
}
// Words many facts and many prompts share: what makes a word match noisy.
const COMMON = ["deploy", "config", "service", "build", "release", "branch", "review", "server", "report", "budget", "client", "invoice", "meeting", "deadline", "backup", "queue"];
const common = () => COMMON[rnd(COMMON.length)]!;

type Fact = { name: string; text: string; words: string[] };
const facts: Fact[] = Array.from({ length: 400 }, () => {
  const a = word(), b = word();
  return { name: `${a}-${b}`, text: `For ${a} ${b}, use the ${word()} setting during ${common()} and ${common()}`, words: [a, b] };
});
const rules = Array.from({ length: 10 }, () => `- RULE ${word()}-${word()}: Always ${word()} the ${common()} before a ${common()}`);
// Rules pushed before a tool call whose command holds the trigger word.
const pushes = Array.from({ length: 6 }, () => ({ trigger: word(), name: `${word()}-rule`, text: `Run ${word()} only with the ${common()} flag` }));

type Input = { ref: string; text: string; who: "owner" | "report" | "wake" | "loop" | "harness"; target?: string; tools: string[] };
const meta = (i: Input) => (i.who === "owner" ? undefined : i.who === "report" ? { kind: "subagent", agent_id: "a1" } : i.who === "wake" ? { kind: "wait", wait_id: "w1" } : i.who === "loop" ? { kind: "loop", loop_id: "l1" } : { origin: "harness" });

// One session of work: the owner asks about a fact (some of them a second
// time, later), agents report, waits wake it, a loop runs, the harness speaks.
function sessionInputs(n: number, name: (f: Fact) => string): Input[] {
  const out: Input[] = [];
  const asked: Fact[] = [];
  for (let i = 0; i < n; i++) {
    const ref = `q${i}`;
    const tools = Array.from({ length: [0, 0, 1, 2, 3][rnd(5)]! }, () => (rnd(2) ? `echo ${pushes[rnd(pushes.length)]!.trigger} ${common()}` : `echo ${common()}`));
    const roll = i === 0 ? 0 : rnd(10);
    if (roll < 6) {
      const again = asked.length > 2 && rnd(3) === 0;
      const f = again ? asked[rnd(asked.length)]! : facts[rnd(facts.length)]!;
      if (!again) asked.push(f);
      out.push({ ref, who: "owner", target: f.name, tools, text: `How should ${name(f)} be set for the ${common()} ${common()}? Check the ${common()} too. (ref ${ref})` });
    } else if (roll < 8) {
      out.push({ ref, who: "report", tools: [], text: `<agent_report status="done">\nThe ${common()} ${common()} task finished; the ${common()} passed and the ${common()} is ready.\n</agent_report> (ref ${ref})` });
    } else if (roll < 9) {
      out.push({ ref, who: rnd(2) ? "wake" : "loop", tools, text: `[harness] A wait ended: the ${common()} ${common()} is done. Go on with the ${common()}. (ref ${ref})` });
    } else {
      out.push({ ref, who: "harness", tools: [], text: `[harness] The previous turn was stopped before it finished. Continue where it left off. (ref ${ref})` });
    }
  }
  return out;
}

// The stand-in for the external store: a shell script answering the hook
// calls from the generated files. `once`: it keeps what it gave a session and
// never gives it twice (a store with a memory of its own); without it every
// call is answered alone. The file `mode` makes it slow or failing.
function writeStore(dir: string, once: boolean): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "facts.tsv"), facts.map((f) => `${f.name}\t${f.text}`).join("\n") + "\n");
  writeFileSync(join(dir, "rules.txt"), `# store: this owner's standing rules\n${rules.join("\n")}\n`);
  writeFileSync(join(dir, "pushes.tsv"), pushes.map((p) => `${p.trigger}\t${p.name}\t${p.text}`).join("\n") + "\n");
  writeFileSync(join(dir, "mode"), "ok");
  writeFileSync(join(dir, "match.awk"), `
BEGIN { FS = "\\t"; n = split(tolower(q), w, /[^a-z0-9]+/); for (i = 1; i <= n; i++) if (length(w[i]) > 3) want[w[i]] = 1
  while ((getline line < seen) > 0) had[line] = 1 }
{ m = split(tolower($1 " " $2), t, /[^a-z0-9]+/); s = 0; delete got
  for (i = 1; i <= m; i++) if ((t[i] in want) && !(t[i] in got)) { got[t[i]] = 1; s++ }
  if (s && !($1 in had)) { c++; score[c] = s; name[c] = $1; text[c] = $2 } }
END { for (k = 1; k <= 3; k++) { best = 0; for (i = 1; i <= c; i++) if (score[i] > score[best]) best = i
    if (!best) break
    if (k == 1) print "# store: facts matching this request"
    print "- " name[best] ": " text[best]; if (once) print name[best] >> seen; score[best] = 0 } }
`);
  const bin = join(dir, "store.sh");
  writeFileSync(bin, `#!/bin/sh
dir=${JSON.stringify(dir)}
input=$(cat)
mode=$(cat "$dir/mode")
echo "$2" >> "$dir/calls"
case "$mode" in slow) sleep 8 ;; down) exit 1 ;; esac
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p')
seen="$dir/seen-$sid"; touch "$seen"
case "$2" in
  session-start) cat "$dir/rules.txt" ;;
  prompt)
    q=$(printf '%s' "$input" | sed -n 's/.*"prompt":"\\(.*\\)","transcript_path.*/\\1/p')
    awk -v q="$q" -v seen="$seen" -v once=${once ? 1 : 0} -f "$dir/match.awk" "$dir/facts.tsv" ;;
  pre-tool)
    cmd=$(printf '%s' "$input" | sed -n 's/.*"command":"\\([^"]*\\)".*/\\1/p')
    awk -F '\\t' -v cmd="$cmd" -v seen="$seen" -v once=${once ? 1 : 0} 'BEGIN { while ((getline line < seen) > 0) had[line] = 1 }
      index(cmd, $1) && !($2 in had) { printf "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PreToolUse\\",\\"additionalContext\\":\\"# store: before this step\\\\n- %s: %s\\"}}\\n", $2, $3; if (once) print $2 >> seen; exit }' "$dir/pushes.tsv" ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

// --- one world: a store, an engine, the hooks, a scripted model ---------------------

type Sent = { session: string; at: number; system: string; messages: string[]; purpose: string };
const MODEL = "bench:scripted";

function world(name: string, storeBin: string | null) {
  const dir = join(root, name);
  mkdirSync(join(dir, "ws"), { recursive: true });
  const store = new Store(dir);
  const bus = new Bus();
  const failures: string[] = [];
  const errors = { capture: (_s: string, e: unknown) => { failures.push(String((e as Error)?.message ?? e)); return { message: String(e) }; } } as any;
  const sent: Sent[] = [];
  const plans = new Map<string, Input>();
  const info = { id: MODEL, provider: "bench", model: "scripted", name: "Scripted", family: "claude", context: 1_000_000, output: 4_000, efforts: [], billing: "per_token" };
  const provider = {
    id: "bench", family: "claude", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => {
      sent.push({ session: req.sessionKey, at: performance.now(), system: req.system, messages: req.messages.map((m: any) => JSON.stringify(m)), purpose: req.purpose ?? "turn" });
      const all = JSON.stringify(req.messages);
      const ref = [...all.matchAll(/\(ref (q\d+)\)/g)].at(-1)?.[1] ?? "";
      const plan = plans.get(`${req.sessionKey}:${ref}`);
      const usage = { input: 10, output: 10, cache_read: 0, cache_write: 0 };
      const at = req.messages.findLastIndex((m: any) => m.role === "user" && JSON.stringify(m).includes(`(ref ${ref})`));
      const done = req.messages.slice(at + 1).filter((m: any) => m.role === "assistant").length;
      const next = plan?.tools[done];
      // "write:<path>" writes that file; anything else is a shell command.
      if (next) return { blocks: [next.startsWith("write:") ? { type: "tool_use", id: `c-${ref}-${done}`, name: "Write", input: { file_path: next.slice(6), content: "x\n" } } : { type: "tool_use", id: `c-${ref}-${done}`, name: "Bash", input: { command: next } }], usage, stop: "tool_use", model: "scripted" };
      // The reply names what the task needed, when the context holds it.
      const said: string[] = [];
      if (plan?.target && all.includes(`- ${plan.target}`)) said.push(`Per ${plan.target}: set as it says.`);
      for (const p of pushes) if (plan?.tools.some((c) => c.includes(p.trigger)) && all.includes(`- ${p.name}:`)) said.push(`Followed ${p.name}.`);
      return { blocks: [{ type: "text", text: said.join(" ") || "Done." }], usage, stop: "end_turn", model: "scripted" };
    },
  };
  const providers = { resolve: async () => ({ provider, info }), models: async () => [info], current: () => [info], defaultModel: async () => MODEL } as any;
  const hooksBefore = allHooks().length;
  const engine = new Engine(store, bus, providers, errors, join(dir, "spill"));
  const tacit = new Tacit(store, bus, errors, storeBin);
  tacit.install();
  const mail = { id: "none", label: "none", available: () => false, account: () => undefined, can: { modify: false, send: false, calendar: false }, search: async () => [], read: async () => { throw new Error("no mail"); }, modify: async () => {}, send: async () => ({ id: "" }), events: async () => [] };
  const helper = new Helper({ store, bus, engine, providers, errors, workspace: join(dir, "ws") } as any, mail as any);
  helper.install();
  const run = async (sessionId: string, inputs: Input[]) => {
    const waits: number[] = [];
    for (const i of inputs) {
      plans.set(`${sessionId}:${i.ref}`, i);
      const before = sent.length;
      const t0 = performance.now();
      engine.send(sessionId, i.text, { meta: meta(i) });
      await engine.idle(sessionId);
      const first = sent.slice(before).find((s) => s.session === sessionId);
      waits.push(first ? first.at - t0 : NaN);
    }
    return waits;
  };
  const close = () => { helper.stop(); allHooks().length = hooksBefore; store.db.close(); };
  return { dir, store, engine, tacit, helper, sent, failures, run, close };
}

// --- what a session's events say memory added ---------------------------------------

type Added = { path: string; turn: number; who: Input["who"]; bytes: number; entries: string[] };
const PATHS = ["external store, session start", "external store, per prompt", "external store, per tool call", "helper records"];
const entriesOf = (text: string) => text.split("\n").filter((l) => l.startsWith("- "));
const nameOf = (line: string) => line.replace(/^- (RULE )?/, "").split(":")[0]!.replace(/\s+\([^)]*\)$/, "").trim();

function addedBy(store: any, sessionId: string, inputs: Input[]): { added: Added[]; replies: string[] } {
  const events = lineage(store.events(sessionId), store.session(sessionId)?.head ?? null);
  const added: Added[] = [];
  const replies: string[] = [];
  let turn = -1;
  for (const e of events) {
    if (e.kind === "user" && /\(ref q\d+\)/.test(String(e.data.text ?? ""))) { turn++; replies[turn] = ""; continue; }
    const who = inputs[turn]?.who ?? "owner";
    if (e.kind === "assistant") replies[turn] += e.data.blocks.map((b: any) => (b.type === "text" ? b.text : JSON.stringify(b.input ?? ""))).join("\n") + "\n";
    const texts: [string, string][] = [];
    if (e.kind === "note" && e.data.memory) texts.push(["note", String(e.data.text)]);
    if (e.kind === "tool_result") for (const r of e.data.results) texts.push(["tool", typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text ?? "").join("\n")]);
    for (const [, text] of texts) {
      for (const m of text.matchAll(/<memory source="tacit" hook="([a-z-]+)">\n[\s\S]*?<\/memory>/g)) {
        const path = m[1] === "session-start" ? PATHS[0]! : m[1] === "prompt" ? PATHS[1]! : PATHS[2]!;
        added.push({ path, turn, who, bytes: Buffer.byteLength(m[0]), entries: entriesOf(m[0]) });
      }
      for (const m of text.matchAll(/<remembered>\n[\s\S]*?<\/remembered>/g)) added.push({ path: PATHS[3]!, turn, who, bytes: Buffer.byteLength(m[0]), entries: entriesOf(m[0]) });
    }
  }
  return { added, replies };
}

type Row = { path: string; blocks: number; facts: number; tokens: number; tokens_per_turn: number; used: number; repeated: number; other_blocks: number; other_tokens: number; other_used: number };
function rows(added: Added[], replies: string[], turns: number): Row[] {
  const bpt = bytesPerToken(MODEL);
  const seen = new Set<string>();
  const out: Row[] = [];
  const marks = added.map((a) => a.entries.map((line) => {
    const again = seen.has(line);
    seen.add(line);
    const name = nameOf(line);
    return { again, used: !again && (replies[a.turn] ?? "").includes(name) };
  }));
  for (const path of PATHS) {
    const idx = added.map((a, i) => (a.path === path ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    const sum = (f: (i: number) => number) => idx.reduce((n, i) => n + f(i), 0);
    const other = idx.filter((i) => added[i]!.who !== "owner");
    const tokens = Math.round(sum((i) => added[i]!.bytes) / bpt);
    out.push({
      path, blocks: idx.length, facts: sum((i) => added[i]!.entries.length), tokens, tokens_per_turn: Math.round(tokens / turns),
      used: sum((i) => marks[i]!.filter((m) => m.used).length), repeated: sum((i) => marks[i]!.filter((m) => m.again).length),
      other_blocks: other.length, other_tokens: Math.round(other.reduce((n, i) => n + added[i]!.bytes, 0) / bpt), other_used: other.reduce((n, i) => n + marks[i]!.filter((m) => m.used).length, 0),
    });
  }
  return out;
}

// Each turn request starts with the bytes of the one before it, and the system prompt never changes.
function prefix(sent: Sent[], sessionId: string) {
  const turns = sent.filter((s) => s.session === sessionId && s.purpose === "turn");
  let changed = 0, system = 0;
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1]!, b = turns[i]!;
    if (a.system !== b.system) system++;
    // The last message of a request may grow (a note joins the prompt it follows); the ones before it are frozen.
    const frozen = a.messages.slice(0, -1);
    if (frozen.some((m, k) => b.messages[k] !== m)) changed++;
    else if (!b.messages[frozen.length]?.startsWith(a.messages.at(-1)!.slice(0, -2))) changed++;
  }
  return { requests: turns.length, changed, system };
}

const pct = (v: number[], q: number) => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]! : NaN; };
const ms = (n: number) => (Number.isFinite(n) ? (n >= 100 ? `${Math.round(n)}` : n.toFixed(1)) : "-");

function table(title: string, list: Row[]) {
  console.log(`\n${title}`);
  const head = ["path", "blocks", "facts", "tokens", "tok/turn", "used", "repeated", "on input not the owner's: blocks", "tokens", "used"];
  const body = list.map((r) => [r.path, r.blocks, r.facts, r.tokens, r.tokens_per_turn, `${r.used} (${r.facts ? Math.round((100 * r.used) / r.facts) : 0}%)`, r.repeated, r.other_blocks, r.other_tokens, r.other_used].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  for (const line of [head, ...body]) console.log("  " + line.map((c, i) => (i ? c.padStart(w[i]!) : c.padEnd(w[i]!))).join("  "));
}

// --- the runs ------------------------------------------------------------------------

const TURNS = 40;
const result: Record<string, unknown> = { turns: TURNS, bytes_per_token: bytesPerToken(MODEL) };
console.log(`Memory efficiency on generated data: ${TURNS} inputs a session, ${facts.length} facts in the external store, tokens at ${bytesPerToken(MODEL)} bytes a token`);

// 1. The external store, answering every call alone (it keeps no memory of what it gave) and once per session.
for (const once of [false, true]) {
  seed = 99;
  const w = world(once ? "ext-once" : "ext-plain", writeStore(join(root, once ? "store-once" : "store-plain"), once));
  const inputs = sessionInputs(TURNS, (f) => f.words.join(" "));
  const s = w.store.createSession({ model: MODEL, workspace: join(w.dir, "ws") });
  const waits = await w.run(s.id, inputs);
  const { added, replies } = addedBy(w.store, s.id, inputs);
  const r = rows(added, replies, TURNS);
  table(`External store that ${once ? "gives a session each fact once" : "answers every call alone"}`, r);
  const p = prefix(w.sent, s.id);
  console.log(`  cache prefix: ${p.requests} turn requests, ${p.changed} changed bytes of an earlier message, the system prompt changed ${p.system} times (memory is in the messages, after the prompt)`);
  // What the store marked as given to the session against what a request carried.
  let lost: number | null = null;
  if (once) {
    const given = readFileSync(join(root, "store-once", `seen-${s.id}`), "utf8").trim().split("\n").filter(Boolean);
    const reached = new Set(added.flatMap((a) => a.entries.map(nameOf)));
    lost = given.filter((g) => !reached.has(g)).length;
    console.log(`  facts the store gave this session: ${given.length}; never in a request (lost): ${lost}`);
  }
  // The same inputs with memory off: what the hooks add before a turn's first request.
  seed = 99;
  const off = w.store.createSession({ model: MODEL, workspace: join(w.dir, "ws") });
  w.tacit.setFlags(off.id, { use_memory: false });
  const base = await w.run(off.id, sessionInputs(TURNS, (f) => f.words.join(" ")));
  const st = w.tacit.stats();
  const t = st.transcript;
  console.log(`  before a turn's first request: ${ms(pct(waits, 0.5))} ms median with memory, ${ms(pct(base, 0.5))} ms without (max ${ms(pct(waits, 1))} / ${ms(pct(base, 1))})`);
  console.log(`  store calls: ${Object.entries(st.hooks).map(([h, x]: [string, any]) => `${h} ${Object.values(x.outcomes as Record<string, number>).reduce((a, b) => a + b, 0)}`).join(", ")}; transcript written whole ${t.rebuilt} times, appended to ${t.appended ?? 0} times, ${ms(t.duration_ms.total)} ms and ${Math.round(t.bytes.total / 1024)} KB in all`);
  const m = metered(w.store, s.id);
  result[once ? "external_once" : "external_plain"] = { metered: m, rows: r, prefix: p, lost, first_request_ms: { with_p50: pct(waits, 0.5), without_p50: pct(base, 0.5), with_max: pct(waits, 1) }, calls: st.hooks, transcript: t, errors: w.failures.length };
  w.close();
}

// 2. A long session: what the transcript the store reads costs per call.
{
  const w = world("long", writeStore(join(root, "store-long"), true));
  const s = w.store.createSession({ model: MODEL, workspace: join(w.dir, "ws") });
  for (let i = 0; i < 1500; i++) {
    w.store.append(s.id, "user", { text: `Earlier prompt ${i} about the ${common()} ${common()}` });
    w.store.append(s.id, "assistant", { blocks: [{ type: "text", text: `Earlier reply ${i}. ${"The work went on as planned. ".repeat(20)}` }], model: MODEL, stop: "end_turn", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } });
  }
  seed = 5;
  const inputs = sessionInputs(6, (f) => f.words.join(" ")).map((i) => ({ ...i, who: "owner" as const, tools: [`echo ${common()}`, `echo ${common()}`] }));
  const waits = await w.run(s.id, inputs);
  const t = w.tacit.stats().transcript;
  console.log(`\nA session of 3,000 earlier events, 6 prompts with 2 tool calls each`);
  console.log(`  transcript written whole ${t.rebuilt} times, appended to ${t.appended ?? 0} times (${t.reused} reused): ${ms(t.duration_ms.total)} ms and ${Math.round(t.bytes.total / 1024)} KB written in all, ${ms(t.duration_ms.max)} ms the longest`);
  console.log(`  before a turn's first request: ${ms(pct(waits, 0.5))} ms median`);
  result.long_session = { transcript: t, first_request_p50_ms: pct(waits, 0.5) };
  w.close();
}

// 2b. A store that returns more than a block holds: 300 new facts a prompt, 60 a tool call, each given once.
{
  const dir = join(root, "store-verbose");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "n"), "0");
  writeFileSync(join(dir, "given"), "");
  writeFileSync(join(dir, "facts.tsv"), Array.from({ length: 6000 }, (_, i) => `v${i}-${word()}\tThe ${word()} ${common()} is kept with the ${word()} ${common()} for ${word()}`).join("\n") + "\n");
  const bin = join(dir, "store.sh");
  writeFileSync(bin, `#!/bin/sh
dir=${JSON.stringify(dir)}
cat > /dev/null
n=$(cat "$dir/n")
case "$2" in
  prompt) echo $((n + 300)) > "$dir/n"; echo "# store: facts matching this request"; awk -F '\\t' -v a="$n" -v g="$dir/given" 'NR > a && NR <= a + 300 { print "- " $1 ": " $2; print $1 >> g }' "$dir/facts.tsv" ;;
  pre-tool) echo $((n + 60)) > "$dir/n"; printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"# store: before this step'; awk -F '\\t' -v a="$n" -v g="$dir/given" 'NR > a && NR <= a + 60 { printf "\\\\n- %s: %s", $1, $2; print $1 >> g }' "$dir/facts.tsv"; printf '"}}\\n' ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  const w = world("verbose", bin);
  const s = w.store.createSession({ model: MODEL, workspace: join(w.dir, "ws") });
  seed = 3;
  const inputs = sessionInputs(4, (f) => f.words.join(" ")).map((i) => ({ ...i, who: "owner" as const, tools: [`echo ${common()}`, `echo ${common()}`, `echo ${common()}`] }));
  await w.run(s.id, inputs);
  const { added } = addedBy(w.store, s.id, inputs);
  const given = readFileSync(join(dir, "given"), "utf8").trim().split("\n").filter(Boolean);
  const reached = new Set(added.flatMap((a) => a.entries.map(nameOf)));
  const lost = given.filter((g) => !reached.has(g)).length;
  const perTurn = inputs.map((_, t) => added.filter((a) => a.turn === t).reduce((n, a) => n + a.bytes, 0));
  const largest = Math.max(0, ...added.map((a) => a.bytes));
  const halves = added.filter((a) => a.entries.some((l) => !/: The \S+ \S+ is kept with the \S+ \S+ for \S+$/.test(l))).length;
  const owed = (w.tacit as any).owed ? (w.tacit as any).owed(s.id) : null;
  console.log(`\nStore that returns 300 new facts a prompt and 60 a tool call, each once: 4 prompts with 3 tool calls each`);
  console.log(`  facts the store gave: ${given.length}; never in a request (lost): ${lost}${owed === null ? "" : `; still owed in the state at the end: ${owed} lines`}`);
  console.log(`  memory added per turn: ${perTurn.map((b) => Math.round(b / bytesPerToken(MODEL))).join(", ")} tokens; largest block ${largest} bytes; blocks ending in half a fact: ${halves} of ${added.length}`);
  const m = metered(w.store, s.id);
  result.verbose = { metered: m, given: given.length, lost, owed, per_turn_bytes: perTurn, largest_block_bytes: largest, half_facts: halves, blocks: added.length };
  w.close();
}

// 3. A store that does not answer, and one that fails.
for (const mode of ["slow", "down"]) {
  const store = join(root, `store-${mode}`);
  const w = world(mode, writeStore(store, true));
  writeFileSync(join(store, "mode"), mode);
  const s = w.store.createSession({ model: MODEL, workspace: join(w.dir, "ws") });
  seed = 11;
  const inputs = sessionInputs(4, (f) => f.words.join(" ")).map((i) => ({ ...i, who: "owner" as const, tools: [`echo ${common()}`, `echo ${common()}`] }));
  const t0 = performance.now();
  const waits = await w.run(s.id, inputs);
  const total = performance.now() - t0;
  const events = w.store.events(s.id);
  const ends = events.filter((e: any) => e.kind === "turn_end").map((e: any) => e.data.reason);
  const told = events.filter((e: any) => e.kind === "note" && !e.data.model && /memory/i.test(String(e.data.text ?? ""))).length;
  const calls = readFileSync(join(store, "calls"), "utf8").trim().split("\n").length;
  console.log(`\nStore that ${mode === "slow" ? "does not answer (8 s a call)" : "fails every call"}: 4 prompts with 2 tool calls each`);
  console.log(`  before the first request: ${waits.map(ms).join(", ")} ms; the 4 turns took ${ms(total)} ms in all and ended ${[...new Set(ends)].join(", ")}`);
  const procs = (w.tacit.stats() as any).processes;
  console.log(`  store calls started ${calls}; the session was told ${told} time${told === 1 ? "" : "s"}; errors recorded ${w.failures.length}${procs ? `; hook processes at once: ${procs.max} at most (limit ${procs.limit}), calls not made while one was out: ${procs.not_started}, probes: ${procs.probes}` : ""}`);
  result[`store_${mode}`] = { first_request_ms: waits, total_ms: total, ends, told, calls, errors: w.failures.length, processes: procs ?? null };
  w.close();
}

// 4. The helper's own records.
{
  const w = world("helper", null);
  // Records: labels as reference data, people, decisions and facts sharing common words, standing preferences.
  const people = Array.from({ length: 60 }, () => { const a = word(); return { key: `person.${a}`, alias: a, value: `${a} handles the ${common()} ${common()} and wants a ${common()} every week`, kind: "person" }; });
  const notes = Array.from({ length: 240 }, () => { const a = word(), b = word(); return { key: `fact.${a}-${b}`, alias: `${a} ${b}`, value: `The ${a} ${b} ${common()} is kept with the ${common()} ${common()}`, kind: rnd(3) ? "fact" : "decision" }; });
  const prefs = Array.from({ length: 12 }, () => ({ key: `pref.${word()}`, alias: undefined, value: `Keep the ${common()} ${word()} short`, kind: rnd(2) ? "preference" : "commitment" }));
  const labels = Array.from({ length: 2000 }, (_, i) => ({ key: `mail.label.label_${i}`, value: `${word()}/${word()}`, kind: "reference", topics: ["labels"] }));
  w.helper.records.put([...people, ...notes, ...prefs].map((r) => ({ key: r.key, value: r.value, kind: r.kind, aliases: r.alias ? [r.alias] : [] })), "helper");
  w.helper.records.put(labels, "import", true);
  const pool: Fact[] = [...people, ...notes].map((r) => ({ name: r.key, text: r.value, words: [r.alias!] }));
  seed = 42;
  const inputs: Input[] = [];
  const asked: Fact[] = [];
  for (let i = 0; i < TURNS; i++) {
    const ref = `q${i}`;
    const roll = i === 0 ? 0 : rnd(10);
    if (roll < 6) {
      const again = asked.length > 2 && rnd(3) === 0;
      const f = again ? asked[rnd(asked.length)]! : pool[rnd(pool.length)]!;
      if (!again) asked.push(f);
      inputs.push({ ref, who: "owner", target: f.name, tools: [], text: `What do we know about ${f.words[0]}? I need it for the ${common()} ${common()}. (ref ${ref})` });
    } else if (roll < 9) {
      const f = pool[rnd(pool.length)]!;
      inputs.push({ ref, who: "wake", target: rnd(2) ? f.name : undefined, tools: [], text: `[helper digest] What happened since you last heard:\n- a session finished the ${common()} ${common()}\n- mail about the ${common()}${inputs.length % 2 ? ` from ${f.words[0]}` : ""}\nDecide whether the owner must act. (ref ${ref})` });
    } else {
      inputs.push({ ref, who: "harness", tools: [], text: `[harness] The previous turn was stopped before it finished. Continue where it left off. (ref ${ref})` });
    }
  }
  // A digest that names nobody needs no record.
  for (const i of inputs) if (i.who === "wake" && i.target && !i.text.includes(` from ${pool.find((f) => f.name === i.target)!.words[0]}`)) i.target = undefined;
  const s = w.store.createSession({ title: "Helper", model: MODEL, workspace: join(w.dir, "ws"), settings: { helper: true } });
  const waits = await w.run(s.id, inputs);
  const { added, replies } = addedBy(w.store, s.id, inputs);
  const r = rows(added, replies, TURNS);
  table(`Helper records: ${w.helper.records.index.size} records (2,000 of them reference labels)`, r);
  const p = prefix(w.sent, s.id);
  console.log(`  cache prefix: ${p.requests} turn requests, ${p.changed} changed bytes of an earlier message, the system prompt changed ${p.system} times`);
  console.log(`  before a turn's first request: ${ms(pct(waits, 0.5))} ms median (max ${ms(pct(waits, 1))})`);
  const m = metered(w.store, s.id);
  result.helper = { metered: m, rows: r, prefix: p, first_request_p50_ms: pct(waits, 0.5), errors: w.failures.length };
  w.close();
}

// 5. Helper recall, relevance: is the record a prompt is about recalled? Records
// whose words follow a skewed spread (a few words in most records, most words
// in few), and prompts made of three words of one record's text and two
// other words. Never by the record's name: that is a hash lookup either way.
{
  const { RecordIndex } = await import(src("helper/records.ts"));
  const { RECALL_CHARS } = await import(src("helper/helper.ts"));
  seed = 77;
  const vocab = Array.from({ length: 600 }, () => word());
  // Word i is drawn about 1/(i+1) as often as the first.
  const weights = vocab.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const draw = () => { let x = (rnd(1_000_000) / 1_000_000) * total; for (let i = 0; i < vocab.length; i++) if ((x -= weights[i]!) <= 0) return vocab[i]!; return vocab.at(-1)!; };
  const some = (n: number) => { const out = new Set<string>(); while (out.size < n) out.add(draw()); return [...out]; };
  const recs = Array.from({ length: 1500 }, (_, i) => ({ key: `note.${word()}-${i}`, value: some(8).join(" "), kind: "fact", aliases: [], topics: [], source: "helper", ts: 0, updated: i, used: 0 }));
  const ix = new RecordIndex(recs);
  const N = 300;
  let right = 0, count = 0, chars = 0, first = 0;
  for (let q = 0; q < N; q++) {
    const r = recs[rnd(recs.length)]!;
    const words = r.value.split(" ");
    const picked = new Set<string>();
    while (picked.size < 3) picked.add(words[rnd(words.length)]!);
    const text = `What about ${[...picked, ...some(2)].join(" ")}?`;
    const got = ix.recall(text, new Set(), RECALL_CHARS).records as { key: string; value: string }[];
    if (got.some((x) => x.key === r.key)) right++;
    if (got[0]?.key === r.key) first++;
    count += got.length;
    chars += got.reduce((n, x) => n + x.key.length + x.value.length + 4, 0);
  }
  console.log(`\nHelper recall, relevance: ${N} prompts of three words from one record's text among ${recs.length} records`);
  console.log(`  the record asked about is recalled: ${right} of ${N} (${Math.round((100 * right) / N)}%), first in ${first}; records recalled a prompt: ${(count / N).toFixed(1)}; tokens a prompt: ${Math.round(chars / N / bytesPerToken(MODEL))}`);
  result.relevance = { prompts: N, records: recs.length, right, first, records_per_prompt: count / N, tokens_per_prompt: chars / N / bytesPerToken(MODEL) };
}

// 6. Before a tool. A working session: every turn reads (the same status and
// listing each turn, files, searches), changes things (a stamp touched each
// turn, files written by a redirect), writes files in its checkout and
// scratch files outside any checkout. The stand-in's before-a-tool path
// takes 0.2 s (the store's own work, not process start) and has a rule for a
// few commands and files, each given once.
{
  const dir = join(root, "store-tools");
  mkdirSync(dir, { recursive: true });
  seed = 31;
  const triggers = Array.from({ length: 6 }, () => word());
  writeFileSync(join(dir, "rules.tsv"), triggers.map((t, i) => `${t}\trule-${i}-${t}\tWhen ${t} is touched, ${word()} the ${common()} first`).join("\n") + "\n");
  writeFileSync(join(dir, "calls"), "");
  const bin = join(dir, "store.sh");
  writeFileSync(bin, `#!/bin/sh
dir=${JSON.stringify(dir)}
input=$(cat)
echo "$2" >> "$dir/calls"
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p')
seen="$dir/seen-$sid"; touch "$seen"
case "$2" in
  session-start) echo "# store: this owner's standing rules"; echo "- RULE base-rule: Always check the queue before a release" ;;
  pre-tool)
    sleep 0.2
    INPUT="$input" awk -F '\\t' -v seen="$seen" 'BEGIN { while ((getline line < seen) > 0) had[line] = 1 }
      index(ENVIRON["INPUT"], $1) && !($2 in had) { out = out "\\\\n- " $2 ": " $3; print $2 >> seen }
      END { if (out != "") printf "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PreToolUse\\",\\"additionalContext\\":\\"# store: before this step%s\\"}}\\n", out }' "$dir/rules.tsv" ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  const w = world("tools", bin);
  const ws = join(w.dir, "ws");
  for (const d of [".git", "notes", "src", "build", "out"]) mkdirSync(join(ws, d), { recursive: true });
  mkdirSync(join(w.dir, "scratch"), { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(ws, "notes", `n${i}.md`), `note ${i}\n`);
  const TURNS_T = 12;
  const inputs: Input[] = Array.from({ length: TURNS_T }, (_, t) => {
    const tools = [
      "git status", "ls src", `cat notes/n${t % 3}.md`, `grep -rn ${word()} src`,
      "touch build/stamp", `echo ${t} > out/log${t}.txt`,
      `write:${join(ws, "src", `gen${t}.ts`)}`, `write:${join(w.dir, "scratch", `t${t}.txt`)}`,
    ];
    // A rule's trigger now and then: in a command that changes something, in a read, in a file written.
    if (t === 2) tools.push(`touch build/${triggers[0]}.stamp`);
    if (t === 3) tools.push(`cat notes/${triggers[1]}.md`);
    if (t === 4) tools.push(`write:${join(ws, "src", `${triggers[2]}.ts`)}`);
    if (t === 6) tools.push(`touch build/${triggers[3]}.stamp`);
    if (t === 8) tools.push(`grep -rn ${triggers[4]} notes`);
    if (t === 9) tools.push(`touch build/${triggers[0]}.stamp`); // again: its rule was given
    return { ref: `q${t}`, who: "owner" as const, tools, text: `Go on with the ${common()} work. (ref q${t})` };
  });
  const s = w.store.createSession({ model: MODEL, workspace: ws });
  const t0 = performance.now();
  await w.run(s.id, inputs);
  // One more prompt: a rule that followed a read arrives with a later request.
  await w.run(s.id, [{ ref: "q99", who: "owner", tools: [], text: "And the summary? (ref q99)" }]);
  const wall = performance.now() - t0;
  const calls = inputs.reduce((n, i) => n + i.tools.length, 0);
  const st = w.tacit.stats() as any;
  const pre = st.hooks["pre-tool"];
  const made = Object.values(pre.outcomes as Record<string, number>).reduce((a, b) => a + b, 0);
  const { added } = addedBy(w.store, s.id, [...inputs, { ref: "q99", who: "owner", tools: [], text: "" }]);
  const reached = new Set(added.flatMap((a) => a.entries.map(nameOf)));
  const given = readFileSync(join(dir, `seen-${s.id}`), "utf8").trim().split("\n").filter(Boolean);
  // What a run that asks the store about every call gets: each rule whose trigger a call holds.
  const all = inputs.flatMap((i) => i.tools);
  const expected = triggers.map((t, i) => ({ t, name: `rule-${i}-${t}` })).filter((r) => all.some((c) => c.includes(r.t)));
  const lost = expected.filter((r) => !reached.has(r.name)).length;
  // A rule must be in the request the model answers after the call it came with: before its next action.
  const turns = w.sent.filter((r) => r.session === s.id && r.purpose === "turn").map((r) => r.messages.join("\n"));
  const inTime = expected.filter((r) => {
    const after = turns.find((m) => /"type":"tool_use"/.test(m) && new RegExp(`"(command|file_path)":"[^"]*${r.t}`).test(m));
    return !!after && after.includes(`- ${r.name}:`);
  }).length;
  const m = meterOf?.(w.store).report({ session: s.id });
  const held = m?.paths.find((p: any) => p.path === "store_tool")?.wait_ms ?? NaN;
  const waitedReq = st.tools?.request_wait_ms ?? 0;
  console.log(`\nBefore a tool: ${TURNS_T} turns, ${calls} tool calls (${(calls / TURNS_T).toFixed(1)} a turn), a store that takes 0.2 s a call`);
  console.log(`  calls made to the store: ${made} of ${calls}${st.tools ? ` (not asked: ${st.tools.known_nothing} reads known to get nothing, ${st.tools.never_answered} calls it never answers)` : ""}; store process time ${ms(pre.duration_ms.total)} ms`);
  console.log(`  time added: ${ms(held + waitedReq)} ms in all, ${ms((held + waitedReq) / calls)} ms a tool call (results held ${ms(held)} ms${st.tools ? `, ${st.tools.request_waits} requests waited ${ms(waitedReq)} ms for a read's answer` : ""}); the session took ${ms(wall)} ms`);
  console.log(`  rules a run that asks about every call gets: ${expected.length}; given by the store: ${given.length}; in a request: ${expected.length - lost}; in the request right after their call: ${inTime}; lost: ${lost}`);
  result.tools = { turns: TURNS_T, calls, made, process_ms: pre.duration_ms.total, held_ms: held, request_wait_ms: waitedReq, wall_ms: wall, expected: expected.length, given: given.length, in_time: inTime, lost, not_asked: st.tools ?? null };
  w.close();
}

const out = Bun.argv.indexOf("--json");
if (out > 0 && Bun.argv[out + 1]) writeFileSync(Bun.argv[out + 1]!, JSON.stringify(result, null, 2));
rmSync(root, { recursive: true, force: true });
process.exit(0);
