// A stopped session with a decision row between ordinary queued prompts.
import { Store } from "../../../src/core/store.ts";

const [state, workspace] = process.argv.slice(2);
const store = new Store(state!);
const { id } = store.createSession({ title: "Queued decision", model: "scripted:stand-in", workspace: workspace! });
const alpha = store.enqueue(id, "alpha", false);
const ask = store.enqueue(id, "Agent asks to write", false, undefined, { kind: "write_asks" });
const bravo = store.enqueue(id, "bravo", false);
const charlie = store.enqueue(id, "charlie", false);
store.migrate("CREATE TABLE IF NOT EXISTS queue_holds (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, by TEXT)");
store.db.run("INSERT INTO queue_holds (session_id, by) VALUES (?, 'owner')", [id]);
store.db.close();
console.log(JSON.stringify({ id, alpha: alpha.id, ask: ask.id, bravo: bravo.id, charlie: charlie.id }));
