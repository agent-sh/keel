// A trial of a setting with a week of agent trees behind it, written into a state folder a daemon has
// started once (so its tables are there) and is not running now. Usage: bun trial-rows.ts <state-dir> <seed|rate>
//   rate: only agent trees spread over three days (a rate to plan a trial from), no trial.
//   seed: the same, and a trial of the agents' working window on since three days, with `PER` trees an arm
//         assigned and settled: the first arm (compacts at 85%) costs about $2 a tree, the second (42.5%) about $1.4.
import { Database } from "bun:sqlite";
import { join } from "node:path";

const [state, what] = process.argv.slice(2);
const db = new Database(join(state!, "keel.db"));
const now = Date.now(), DAY = 86_400_000, HOUR = 3_600_000, PER = 12;
const id = (n: string, i: number) => `fx-${n}-${String(i).padStart(4, "0")}`;
const session = db.query("INSERT INTO sessions (id, model, workspace, created, updated, parent_id) VALUES (?, 'scripted:stand-in', '/', ?, ?, ?)");
session.run("fx-top", now - 6 * DAY, now - HOUR, null);
// 450 agents the top session started over three days: about 150 new trees a day.
for (let i = 0; i < 450; i++) session.run(id("plain", i), now - 3 * DAY + i * (3 * DAY / 450), now - HOUR, "fx-top");

if (what === "seed") {
  const arms: string[] = ["compacts at 85% of the window", "compacts at 42.5% of the window"];
  const exp = {
    id: "fx-trial", name: "Trial: Agents' working window", mode: "live", unit: "agent", template: "setting_trial", state: "running", created_ms: now - 3 * DAY, started_ms: now - 3 * DAY,
    hypothesis: "What a tree costs when its agent compacts at 85% of the window and when it compacts at 42.5% of the window: the one that costs less stays, if neither has more failed turns, failed tool calls, lost contexts, stops by the owner or replies rated down.",
    arms: [{ name: arms[0], settings: { compact_share: 0.85 } }, { name: arms[1], settings: { compact_share: 0.425 } }],
    primary: "tree_cost_usd",
    guards: [{ metric: "error", mde: 0.1 }, { metric: "tool_errors", mde: 0.25, relative: true }, { metric: "successor", mde: 0.05 }, { metric: "stopped_by_owner", mde: 0.1 }, { metric: "thumbs_down", mde: 0.1 }],
    stop: { sessions_per_arm: 40, until_ms: now + 2 * DAY },
    setting: { trial: "agent_window", key: "window_share", from: 0.85, to: 0.425 },
  };
  db.query("INSERT INTO experiments (id, state, created, data) VALUES (?, 'running', ?, ?)").run(exp.id, exp.created_ms, JSON.stringify(exp));
  const assign = db.query("INSERT INTO experiment_sessions (session_id, exp_id, arm, ts, root) VALUES (?, ?, ?, ?, ?)");
  const turn = db.query("INSERT INTO telemetry_turns (session_id, turn_event, ts, ms, reason, outcome, requests, tool_calls, tool_errors, input, output, cost, exp_id, arm) VALUES (?, ?, ?, ?, 'end_turn', ?, 2, 4, ?, 900, 120, ?, 'fx-trial', ?)");
  const call = db.query("INSERT INTO telemetry_calls (session_id, ts, model, latency_ms, input, output, cost, unpriced, outcome, purpose) VALUES (?, ?, 'scripted:stand-in', 900, 900, 120, ?, 0, 'ok', ?)");
  for (let a = 0; a < 2; a++) for (let i = 0; i < PER; i++) {
    const sid = id(`t${a}`, i), at = now - 2 * DAY + (a * PER + i) * 5 * 60_000;
    session.run(sid, at, at, "fx-top");
    assign.run(sid, exp.id, arms[a]!, at, sid);
    // A tree: three turns of about a third of its cost, with a call each; a summary call for the smaller window.
    const tree = (a ? 1.4 : 2.0) + ((i * 37) % 11 - 5) * 0.06;
    for (let k = 0; k < 3; k++) {
      const t = at + k * 4 * 60_000, c = tree / 3;
      turn.run(sid, `fx-turn-${a}-${i}-${k}`, t, 60_000 + ((i * 13 + k * 7) % 9) * 6_000, a === 0 && i % 6 === 0 && k === 2 ? "error" : "ok", i % 5 === 0 && k === 0 ? 1 : 0, c, arms[a]!);
      call.run(sid, t + 1000, c * (a ? 0.9 : 1), "turn");
      if (a && k === 1) call.run(sid, t + 2000, c * 0.1, "summary");
    }
  }
}
db.close();
