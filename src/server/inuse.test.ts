// A rewind while the folder is in use would be undone by what still writes
// there: a turn, or a background command of this or another session, in the
// folder, below it or through a link to it. Nothing else holds a rewind.
import { expect, test } from "bun:test";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, symlinkSync, writeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { claudeTools } from "../tools/claude.ts";
import { running, startJob, stopJob, type Job } from "../tools/jobs.ts";
import { checkpointRoutes, checkpoints } from "./routes/checkpoints.ts";

type Case = "turn" | "own job" | "other session's job" | "idle" | "job below" | "job through a link" | "job ignoring TERM" | "job with a setsid child";

async function attempt(kind: Case) {
  const base = mkdtempSync(join(tmpdir(), "keel-inuse-"));
  const workspace = join(base, "ws");
  mkdirSync(join(workspace, "sub"), { recursive: true });
  const file = join(workspace, "note.txt");
  writeFileSync(file, "alpha\n");
  const store = new Store(join(base, "state")), bus = new Bus(), errors = new ErrorTracker(store, bus);
  const hooksBefore = allHooks().length; // the hooks are process-wide: other test files run without this store's
  const routes = checkpointRoutes({ store, bus, errors, engine: { isRunning: () => kind === "turn" } } as any) as any;
  const c = checkpoints!;
  const s = store.createSession({ workspace, model: "fixture", title: "rewind" });
  store.append(s.id, "user", { text: "write beta" });
  const turn = store.append(s.id, "turn_start", {}).seq;
  const ctx = { cwd: workspace, sessionId: s.id, signal: new AbortController().signal, seen: new Map(), spillDir: join(base, "spill") };
  const read = claudeTools.find((t) => t.name === "Read")!, write = claudeTools.find((t) => t.name === "Write")!;
  await read.run({ file_path: file }, ctx as any);
  const call = { id: "w1", tool: write, input: { file_path: file, content: "beta\n" }, ctx };
  await c.before(s, call as any);
  await write.run(call.input, ctx as any);
  await c.after(s, call as any);
  await c.end(s);
  store.append(s.id, "turn_end", { reason: "end_turn" });
  let job: Job | undefined;
  if (kind !== "turn" && kind !== "idle") {
    const link = join(base, "alias");
    if (kind === "job through a link") symlinkSync(workspace, link);
    const cwd = kind === "job below" ? join(workspace, "sub") : kind === "job through a link" ? link : workspace;
    const owner = kind === "other session's job" ? store.createSession({ workspace: join(base, "elsewhere"), model: "fixture", title: "other" }).id : s.id;
    // A child of the job's shell that ignores TERM and writes once released
    // through its own FIFO: the wrapper exits on TERM, the child does not.
    const fifo = join(base, "release.fifo");
    // The setsid one leaves the job's process group and session too, and
    // ignores TERM: only the job's cgroup still holds it.
    const writer = `bash -c 'exec 3<> "$0"; echo READY; read -r x <&3; echo beta-late > "$1"' '${fifo}' '${file}'`;
    const fifoCase = kind === "job ignoring TERM" || kind === "job with a setsid child";
    if (fifoCase) Bun.spawnSync(["mkfifo", fifo]);
    const command = kind === "job ignoring TERM" ? `trap '' TERM; ${writer}; sleep 30`
      : kind === "job with a setsid child" ? `trap '' TERM; setsid ${writer} & sleep 30`
      : "sleep 30";
    job = startJob({ sessionId: owner, cwd, command, logDir: join(base, "logs"), background: true } as any);
    if (fifoCase) for (let i = 0; i < 200 && !readFileSync(job.log, "utf8").includes("READY"); i++) await Bun.sleep(25);
  }
  // Whether anything of the job can still be released to write: a FIFO with
  // no reader left refuses a writer that will not wait.
  const release = () => {
    const fifo = join(base, "release.fifo");
    if (!existsSync(fifo)) return false;
    try { const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); writeSync(fd, "go\n"); closeSync(fd); return true; } catch { return false; }
  };
  const post = async (path: string, body: unknown) => {
    const req = Object.assign(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body) }), { params: { id: s.id } });
    const r = await routes[path.replace(s.id, ":id")].POST(req);
    return { status: r.status as number, body: await r.json() };
  };
  try {
    const rewind = await post(`/api/sessions/${s.id}/rewind`, { turn });
    const kept = readFileSync(file, "utf8");
    // The owner can have the commands stopped and the rewind done in one step.
    const stopped = job ? await post(`/api/sessions/${s.id}/rewind`, { turn, stop_shells: true }) : undefined;
    const released = release();
    if (released) for (let i = 0; i < 200 && readFileSync(file, "utf8") === "alpha\n"; i++) await Bun.sleep(25);
    return { status: rewind.status, error: String(rewind.body.error ?? ""), kept, stopped: stopped?.status, after: readFileSync(file, "utf8"), jobRuns: job ? running(job) : false, released };
  } finally {
    if (job) await stopJob(job);
    allHooks().length = hooksBefore;
    store.db.close();
  }
}

test("a rewind waits for every turn and background command in or around its folder", async () => {
  const held = { status: 409, kept: "beta\n" };
  expect(await attempt("turn")).toMatchObject(held);
  // Without systemd --user and cgroup v2 a job has no cgroup, and a setsid
  // descendant is out of reach: that case runs only where jobs get a scope.
  const scoped = startJob({ sessionId: "probe", cwd: tmpdir(), command: "true", logDir: join(mkdtempSync(join(tmpdir(), "keel-inuse-")), "logs") } as any);
  await scoped.exited;
  const cases = ["own job", "other session's job", "job below", "job through a link", "job ignoring TERM", ...(scoped.contain === "cgroup" ? ["job with a setsid child" as const] : [])] as const;
  for (const k of cases) {
    const r = await attempt(k);
    // Restored only once nothing of the job is left that could write after.
    expect({ k, ...r }).toMatchObject({ k, ...held, stopped: 200, after: "alpha\n", jobRuns: false, released: false });
    expect(r.error).toContain(k.startsWith("job ignoring") || k.startsWith("job with") ? "trap" : "sleep 30");
  }
  expect(await attempt("idle")).toMatchObject({ status: 200, after: "alpha\n" });
}, 60_000);
