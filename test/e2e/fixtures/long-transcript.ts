// Sessions with a generated long transcript, written into a state folder
// before its daemon starts: plain notes, which a turn does not send to the
// model, so the scripted model's small window still holds the next turn.
// Usage: bun long-transcript.ts <state-dir> <workspace> <events> <title>...
// Prints the session ids as a JSON list, in the order of the titles.
import { Store } from "../../../src/core/store.ts";

const [stateDir, workspace, count, ...titles] = process.argv.slice(2);
const store = new Store(stateDir!);
const ids = titles.map((title) => {
  const s = store.createSession({ title, model: "scripted:stand-in", workspace: workspace! });
  for (let i = 1; i <= Number(count); i++) {
    store.append(s.id, "note", { text: `Generated note ${i} of ${count}. ${"A line of an earlier turn that a reconnect must not send again. ".repeat(12)}` });
  }
  return s.id;
});
store.db.close();
process.stdout.write(JSON.stringify(ids) + "\n");
