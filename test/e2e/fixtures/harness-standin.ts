// A stand-in for a harness at work, for the resume-from-a-machine e2e: it
// keeps a Claude Code transcript and the record of a live session the way
// Claude Code does, starts a background job in a process group of its own,
// then asks for a shell command and runs it as a child shell that stays quiet
// for --hold seconds. Nothing is written to the transcript while that shell
// runs. When the shell ends it writes the result and its last words and sits
// idle, as a harness at its prompt does. Asked to end (SIGTERM) it stops its
// running command and leaves; its job goes on. With --lock-on-end its
// transcript cannot be read once it has left (until the spec makes it readable
// again): a copy that fails after the original was ended.
//   bun harness-standin.ts --home HOME --cwd DIR --session ID --hold SECONDS [--job SECONDS] [--title TEXT] [--lock-on-end]
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const home = arg("--home")!;
const cwd = arg("--cwd")!;
const sid = arg("--session")!;
const hold = Number(arg("--hold") ?? 10);
const job = Number(arg("--job") ?? 0);
const title = arg("--title") ?? "Run the slow check";

const dir = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
const file = join(dir, `${sid}.jsonl`);
const record = join(home, ".claude", "sessions", `${process.pid}.json`);
mkdirSync(dir, { recursive: true });
mkdirSync(join(home, ".claude", "sessions"), { recursive: true });

let n = 0;
let last: string | null = null;
const base = { cwd, sessionId: sid, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli" };
const write = (r: Record<string, unknown>) => appendFileSync(file, JSON.stringify(r) + "\n");
const message = (type: "user" | "assistant", content: unknown, stop?: string) => {
  const uuid = `${sid}-${++n}`;
  write({ ...base, type, uuid, parentUuid: last, timestamp: new Date().toISOString(), message: type === "assistant" ? { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-stand-in", content, stop_reason: stop } : { role: "user", content } });
  last = uuid;
};
const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: "1" };

// The record of a live session: its process, and the start that tells it from a later process with the same number.
const stat = readFileSync("/proc/self/stat", "utf8");
writeFileSync(record, JSON.stringify({ pid: process.pid, sessionId: sid, cwd, startedAt: Date.now(), procStart: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], version: "2.1.300", kind: "interactive", entrypoint: "cli" }));

writeFileSync(file, "");
message("user", "Start the benchmark in the background, then run the slow check and tell me how it went.");
if (job) {
  // A job that outlives the call that started it: its own process group, nothing more in the transcript.
  writeFileSync(join(cwd, "bench.sh"), `i=0; while [ $i -lt ${job} ]; do echo "round $i"; sleep 1; i=$((i+1)); done\n`);
  const command = "nohup sh bench.sh > bench.log 2>&1 &";
  message("assistant", [{ type: "tool_use", id: "toolu_job", name: "Bash", input: { command, description: "Start the benchmark" } }], "tool_use");
  spawn("sh", ["-c", "exec sh bench.sh > bench.log 2>&1"], { cwd, env, detached: true, stdio: "ignore" }).unref();
  message("user", [{ type: "tool_result", tool_use_id: "toolu_job", content: "" }]);
}
const command = `sleep ${hold}; echo checked > slow-check.out`;
message("assistant", [{ type: "text", text: "Running the slow check now." }], "tool_use");
message("assistant", [{ type: "tool_use", id: "toolu_check", name: "Bash", input: { command, description: "Run the slow check" } }], "tool_use");
write({ type: "ai-title", aiTitle: title, sessionId: sid });

// The tool's shell: a group of its own, quiet until it ends.
const shell = spawn("sh", ["-c", command], { cwd, env, detached: true, stdio: "ignore" });
shell.on("exit", (code) => {
  if (leaving) return;
  message("user", [{ type: "tool_result", tool_use_id: "toolu_check", content: code === 0 ? "" : `exit ${code}` }]);
  message("assistant", [{ type: "text", text: "The slow check passed." }], "end_turn");
  write({ ...base, type: "system", subtype: "turn_duration", durationMs: hold * 1000, timestamp: new Date().toISOString() });
});

let leaving = false;
const leave = () => {
  leaving = true;
  try { process.kill(-shell.pid!, "SIGTERM"); } catch {}
  if (process.argv.includes("--lock-on-end")) chmodSync(file, 0o000);
  rmSync(record, { force: true });
  process.exit(143);
};
process.on("SIGTERM", leave);
process.on("SIGINT", leave);
setInterval(() => {}, 60_000); // idle at its prompt until it is ended
