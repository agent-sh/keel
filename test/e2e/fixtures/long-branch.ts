// A session whose first turns include one on a branch left behind, with a
// long run of plain notes after them: its timeline cannot place those turns
// on a branch in one read. Written into a state folder before its daemon starts.
// Usage: bun long-branch.ts <state-dir> <workspace> <notes>
// Prints { session, kept, left }: the session and its two first turns (the one
// on the branch shown, the one left behind).
import { Store } from "../../../src/core/store.ts";

const [stateDir, workspace, count] = process.argv.slice(2);
const store = new Store(stateDir!);
const s = store.createSession({ title: "A branch left behind, long ago", model: "scripted:stand-in", workspace: workspace! });
const turn = (parent?: string) => {
  store.append(s.id, "user", { text: "go" }, parent);
  const start = store.append(s.id, "turn_start", { model: "scripted:stand-in" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "done" }] });
  store.append(s.id, "turn_end", { reason: "end_turn", ms: 5, steps: 1, tools: 0, tool_errors: 0 });
  return start.id;
};
const out = store.db.transaction(() => {
  const kept = turn();
  const fork = store.session(s.id)!.head!;
  const left = turn();
  turn(fork);
  for (let i = 1; i <= Number(count); i++) store.append(s.id, "note", { text: `Generated note ${i} of ${count}.` });
  return { session: s.id, kept, left };
})();
store.db.close();
process.stdout.write(JSON.stringify(out) + "\n");
