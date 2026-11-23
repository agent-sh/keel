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

const ids = titles.map((title) => {
  const s = store.createSession({ title, model: "scripted:stand-in", workspace: workspace! });
  if (process.env.KEEL_FIXTURE_SHAPE === "run") run(s.id, s.model);
  else if (process.env.KEEL_FIXTURE_SHAPE === "turns") turns(s.id, s.model);
  else for (let i = 1; i <= N; i++) {
    store.append(s.id, "note", { text: `Generated note ${i} of ${count}. ${"A line of an earlier turn that a reconnect must not send again. ".repeat(12)}` });
  }
  return s.id;
});
store.db.close();
process.stdout.write(JSON.stringify(ids) + "\n");
