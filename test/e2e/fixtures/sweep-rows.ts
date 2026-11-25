// Rows for the memory sweep spec, written into a stopped daemon's store: a day of recalls (what the
// memory store gave and what turns named), a fact given often and never named, a stale record of the
// helper, a Claude auto memory folder three sessions loaded, and two nudges of the supervisor.
// Usage: bun sweep-rows.ts <state folder> <auto memory folder>
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [state, dir] = process.argv.slice(2) as [string, string];
const db = new Database(join(state, "keel.db"));
const now = Date.now(), hour = 3_600_000, day = 24 * hour;

const tm = db.query("INSERT INTO telemetry_memory (session_id, ts, path, outcome, facts, tokens, used, rules, followed, broken) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const at = now - 2 * hour;
tm.run("s1", at, "store_prompt", "added", 6, 300, 3, 1, 1, 0);
tm.run("s1", at, "store_tool", "added", 4, 120, 1, 0, 0, 0);
tm.run("s1", at, "store_prompt", "empty", 0, 0, null, 0, 0, 0);
tm.run("s2", at, "helper", "added", 1, 20, 1, 0, 0, 0);
tm.run("s2", at, "helper", "added", 1, 20, 0, 0, 0, 0);

const given = db.query("INSERT INTO memory_given (session_id, ts, recall, path, hook, name, tokens, used, rule) VALUES (?, ?, ?, 'store_prompt', 'prompt', 'code-word', 40, 0, 0)");
for (let i = 0; i < 8; i++) given.run(`g${i % 4}`, now - 3 * hour - i * 1000, i);

db.query("INSERT INTO helper_records (key, value, kind, source, ts, updated, used) VALUES ('pref.coffee', 'likes oat milk in coffee', 'preference', 'helper', ?, ?, 0)").run(now - 90 * day, now - 60 * day);

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "MEMORY.md"), "- [Role](user_role.md): the owner runs the company\n");
writeFileSync(join(dir, "user_role.md"), "---\nname: Role\ndescription: the owner runs the company\ntype: user\n---\nRuns it.\n");
writeFileSync(join(dir, "feedback_tests.md"), "---\nname: Tests\ndescription: run the focused tests, not the suite\ntype: feedback\n---\nFocused.\n");
const log = db.query("INSERT INTO native_memory_log (session_id, ts, system, action, file, bytes) VALUES (?, ?, 'claude', ?, ?, ?)");
for (const s of ["a", "b", "c"]) log.run(s, at, "loaded", dir, 900);
log.run("a", at, "read", join(dir, "user_role.md"), 0);

db.exec("CREATE TABLE IF NOT EXISTS momentum_acts (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, action TEXT NOT NULL)");
db.query("INSERT INTO momentum_acts (session_id, ts, action) VALUES ('m1', ?, 'steer')").run(at);
db.close();
