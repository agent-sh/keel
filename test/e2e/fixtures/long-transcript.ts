// Sessions with a generated long transcript, written into a state folder
// before its daemon starts. Two shapes:
//   notes (the default): plain notes, which a turn does not send to the model,
//     so the scripted model's small window still holds the next turn;
//   turns (KEEL_FIXTURE_SHAPE=turns): whole turns (a prompt, a reply with a
//     tool call, its result, a closing reply, the turn's end), with an edited
//     prompt a tenth of the way in (the first version and two turns under it
//     stay as a side branch), ending on a summary checkpoint so the next turn
//     fits the window;
//   run (KEEL_FIXTURE_SHAPE=run): one turn of <events> tool calls with a short
//     line before each: a run of calls longer than the part a page holds.
//   coordinator (KEEL_FIXTURE_SHAPE=coordinator): a session that started agents
//     (child sessions of it), over about three days: a few prompts of the
//     owner's, each answered after some work, and between them stretches of
//     turns the harness started (agents' reports, a failed one among them,
//     wakes, a landing outcome whose entries landed), about <events> events.
// KEEL_FIXTURE_FIND=word (coordinator): the word in the output of one call of the second stretch,
// past the part a stretch opens with (220 events into it), and of one call early in the third, and
// nowhere else.
// KEEL_FIXTURE_FIND=word (turns): the word in the second turn's prompt (older
// than the part a page opens with), in the prompt of a turn half way down that
// part (far from the end the page opens at), and in the output of a call near
// the end (folded in its closed card), and nowhere else.
// Usage: bun long-transcript.ts <state-dir> <workspace> <events> <title>...
// Prints the session ids as a JSON list, in the order of the titles.
import { Store } from "../../../src/core/store.ts";

const [stateDir, workspace, count, ...titles] = process.argv.slice(2);
const store = new Store(stateDir!);
const N = Number(count);
const usage = { input: 1200, output: 300, cache_read: 40_000, cache_write: 900, cost: 0.0123 };
const words = "the parser reads each line and keeps the offsets so a later pass can report where a token began without reading the file again".split(" ");
const say = (k: number, n: number) => Array.from({ length: n }, (_, i) => words[(k * 7 + i * 3) % words.length]).join(" ");

const FIND = process.env.KEEL_FIXTURE_FIND;
function turns(id: string, model: string) {
  let n = 0, t = 0, found = false, middle = false;
  const add = (kind: Parameters<Store["append"]>[1], data: unknown, parent?: string | null) => { n++; return store.append(id, kind, data, parent); };
  const turn = (parent?: string | null, tag = "") => {
    t++;
    const late = !!FIND && !found && n >= N - 30;
    if (late) found = true;
    const mid = !!FIND && !middle && n >= N - 130;
    if (mid) middle = true;
    add("user", { text: `Prompt ${t}${tag}: ${say(t, 14)}${FIND && (t === 2 || mid) ? ` ${FIND}` : ""}?` }, parent);
    add("turn_start", { model });
    add("assistant", { model, usage, stop: "tool_use", blocks: [
      { type: "text", text: `Looking at **step ${t}**. ${say(t + 1, 22)}.` },
      { type: "tool_use", id: `call-${t}`, name: "Bash", input: { command: `rg -n "token ${t}" src | head -20`, description: `Search for token ${t}` } },
    ] });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: `call-${t}`, content: Array.from({ length: 12 }, (_, i) => `src/parse/file${i}.ts:${t + i}: ${say(t + i, 9)}${late && i === 7 ? ` ${FIND}` : ""}`).join("\n") }] });
    add("assistant", { model, usage, stop: "end_turn", blocks: [{ type: "text", text: `## Result ${t}\n\n${say(t + 2, 40)}.\n\n- First: \`src/parse/file1.ts:${t}\` ${say(t + 3, 8)}\n- Second: ${say(t + 4, 10)}\n\n\`\`\`ts\nexport function step${t}(input: string): string[] {\n  return input.split("\\n").filter(Boolean);\n}\n\`\`\`\n\nReply ${t} ends here.` }] });
    add("turn_end", { reason: "end_turn", usage, ms: 4200 + (t % 7) * 310, steps: 2, tools: 1 });
  };
  let forked = false;
  while (n < N - 1) {
    if (!forked && n >= Math.floor(N / 10)) {
      forked = true;
      const fork = store.session(id)!.head;
      turn(fork, " (first version)");
      turn();
      turn();
      turn(fork, " (edited)");
    } else turn();
  }
  add("compaction", { mode: "summary", summary: "Goal: a generated history. State: every step ran; next, answer the newest prompt.", auto: true, tokens_before: 6400 });
}

// One turn of N calls, a short line before each (KEEL_FIXTURE_SHAPE=run): a run
// of tool calls longer than the part a page holds, ending on the reply.
function run(id: string, model: string) {
  store.append(id, "user", { text: `Go through the ${N} parts, one at a time.` });
  store.append(id, "turn_start", { model });
  for (let k = 1; k <= N; k++) {
    store.append(id, "assistant", { model, usage, stop: "tool_use", blocks: [
      { type: "text", text: `Step ${k}: part ${k}.` },
      { type: "tool_use", id: `run-${k}`, name: "Bash", input: { command: `bun run check --part ${k}` } },
    ] });
    store.append(id, "tool_result", { results: [{ type: "tool_result", tool_use_id: `run-${k}`, content: `part ${k}: ${say(k, 6)}` }] });
  }
  store.append(id, "assistant", { model, usage, stop: "end_turn", blocks: [{ type: "text", text: `All ${N} parts are checked.` }] });
  store.append(id, "turn_end", { reason: "end_turn", usage, ms: N * 900, steps: N + 1, tools: N });
}

// A coordinator's history (KEEL_FIXTURE_SHAPE=coordinator): four prompts of the owner's and, between
// them, stretches of the harness's turns. Its events are spread over 65 hours before now.
function coordinator(id: string, model: string) {
  const per = Math.max(60, Math.floor(N / 5));
  const t0 = Date.now() - 65 * 3600_000;
  let n = 0, k = 0;
  const step = (65 * 3600_000) / Math.max(1, N + 8);
  const add = (kind: Parameters<Store["append"]>[1], data: unknown) => store.append(id, kind, data, undefined, Math.round(t0 + ++n * step));
  store.db.exec(`CREATE TABLE IF NOT EXISTS landing_queue (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, branch TEXT NOT NULL, pos INTEGER NOT NULL,
  queued_by TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  holder TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tip TEXT NOT NULL, state TEXT NOT NULL, step TEXT, built TEXT, landed TEXT, why TEXT, log TEXT,
  batch TEXT, owed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  // (The column the agents module adds when the daemon starts.)
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  const kids = [1, 2, 3].map((i) => {
    const c = store.createSession({ title: `Worker ${i}`, model, workspace: workspace! });
    store.db.run("UPDATE sessions SET parent_id = ? WHERE id = ?", [id, c.id]);
    return c.id;
  });
  // Its agents, finished (the base columns of the agents module's table; the daemon adds the rest).
  store.db.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, model TEXT NOT NULL, background INTEGER NOT NULL, status TEXT NOT NULL,
  created INTEGER NOT NULL, ended INTEGER, result TEXT, handback INTEGER NOT NULL DEFAULT 0, first_seq INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0, def TEXT)`);
  kids.forEach((c, i) => store.db.run("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, ended, handback) VALUES (?, ?, ?, ?, 'general-purpose', ?, 1, 'completed', ?, ?, 1)",
    [`a-${c}`, id, c, `Worker ${i + 1}`, model, t0 + i * 1000, t0 + 3600_000]));
  const work = (tag: string, last: string, find = false) => {
    k++;
    add("turn_start", { model });
    add("assistant", { model, usage, stop: "tool_use", blocks: [
      { type: "text", text: `Checking ${tag}. ${say(k, 12)}.` },
      { type: "tool_use", id: `call-${k}`, name: "Bash", input: { command: `git log --oneline -3 ${tag}`, description: `Read ${tag}` } },
    ] });
    add("tool_result", { results: [{ type: "tool_result", tool_use_id: `call-${k}`, content: `${say(k, 8)}\n${say(k + 1, 8)}${find ? ` ${FIND}` : ""}` }] });
    add("assistant", { model, usage, stop: "end_turn", blocks: [{ type: "text", text: last }] });
    add("turn_end", { reason: "end_turn", usage, ms: 38_000 + (k % 5) * 4000, steps: 2, tools: 1 });
  };
  const asks = [
    "Start three workers on the parser lanes and land what passes.",
    "How far are the lanes? Land the ones that are green.",
    "Retry the failed lane with a smaller change.",
    "Summarize what landed today.",
  ];
  for (let p = 0; p < asks.length; p++) {
    add("user", { text: asks[p] });
    work(`lane-${p}`, `Reply to your message ${p + 1}: ${say(p + 3, 30)}.`);
    const until = n + per, start = n;
    let j = 0, put = false;
    while (n < until) {
      j++;
      if (j % 7 === 3) add("user", { text: "[harness] A wait fired.", kind: "wait", wait_id: `w-${p}-${j}`, outcome: "fired" });
      else if (j % 11 === 5) {
        const entries = [`land-${p}-${j}-a`, `land-${p}-${j}-b`];
        for (const [i, e] of entries.entries()) store.db.run("INSERT INTO landing_queue (id, repo, branch, pos, queued_by, tip, state, created, updated) VALUES (?, '/repo', ?, ?, ?, 'abc', 'landed', 0, 0)", [e, `keel/lane-${j}-${i}`, j * 2 + i, id]);
        add("user", { text: "[harness] Landing queue: two branches landed.", kind: "landing", entries, landed: 2, left: 0 });
      } else add("user", { text: `[harness] Agent report: ${say(j, 10)}.`, kind: "subagent", agent_id: `a-${kids[j % 3]}`, status: p === 1 && j === 4 ? "failed" : "completed" });
      // (The second stretch's call past its first part, the third's early one.)
      const here = !!FIND && !put && ((p === 1 && n - start >= 220) || (p === 2 && j === 3));
      if (here) put = true;
      work(`report-${p}-${j}`, `Noted report ${j}: ${say(j + p, 18)}.`, here);
    }
  }
  add("compaction", { mode: "summary", summary: "Goal: a coordinator's history. State: the lanes ran; next, answer the newest prompt.", auto: true, tokens_before: 6400 });
}

const ids = titles.map((title) => {
  const s = store.createSession({ title, model: "scripted:stand-in", workspace: workspace! });
  if (process.env.KEEL_FIXTURE_SHAPE === "run") run(s.id, s.model);
  else if (process.env.KEEL_FIXTURE_SHAPE === "coordinator") coordinator(s.id, s.model);
  else if (process.env.KEEL_FIXTURE_SHAPE === "turns") turns(s.id, s.model);
  else for (let i = 1; i <= N; i++) {
    store.append(s.id, "note", { text: `Generated note ${i} of ${count}. ${"A line of an earlier turn that a reconnect must not send again. ".repeat(12)}` });
  }
  return s.id;
});
store.db.close();
process.stdout.write(JSON.stringify(ids) + "\n");
