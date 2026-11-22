// The hands of a machine: one workspace tool call, a script, a file in or out,
// a stat and the instruction files, for a session whose tools run here. Served
// by a daemon to the daemons paired with it (behind its link check), and by the
// helper an ssh machine runs (src/fleet/hands-main.ts), behind a socket only
// its user can open. The same handlers in both.
import { heldFile } from "../core/store-files.ts";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { git, gitEnv, innerWork } from "../core/git.ts";
import { dirname, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { readText } from "../core/proc.ts";
import { vault } from "../safety/secrets.ts";
import { listJobs, logPath, ownerRun, readJobLog, stopOne, waitOne } from "../tools/terminal.ts";
import type { ToolOutput } from "../tools/types.ts";
import { localFacts } from "./facts.ts";
import { execArgv, namedSecrets, runHands } from "./hands.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
const SCRIPT: ReadonlySet<string> = new Set(["script"]);
const KEEPALIVE_MS = 5_000; // under Bun's 10 s idle timeout: a long call keeps its connection

// A path with its links resolved, through the deepest part that exists: a link
// inside the granted directory cannot carry a write out of it.
export function realOf(p: string): string {
  let at = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(at), ...rest.reverse()); } catch {}
    const up = dirname(at);
    if (up === at) return resolve(p);
    rest.push(at.slice(up.length + (up.endsWith("/") ? 0 : 1)));
    at = up;
  }
}

// A JSON answer that may take minutes: spaces go out while it works (valid
// JSON whitespace), so the connection is not closed as idle.
export function keepalive(work: () => Promise<unknown>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const tick = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch {} }, KEEPALIVE_MS);
      let out: unknown;
      try { out = await work(); } catch (e) { out = { error: (e as Error).message }; }
      clearInterval(tick);
      try { c.enqueue(enc.encode(JSON.stringify(out))); c.close(); } catch {}
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

// Calls sent with `detach`: they run to their end even when the connection
// that asked drops, and the same call id asked again (after a reconnect) gets
// that run's answer instead of a second run. Only Interrupt (`/hands/cancel`)
// stops one. A finished answer is kept for 30 minutes: longer than any retry
// of a caller (15 minutes, the longest call plus margin).
type Run = { out: Promise<ToolOutput>; ctl: AbortController; done?: number };
const runs = new Map<string, Run>();
const KEEP_MS = 30 * 60_000;
const sweep = () => { const now = Date.now(); for (const [k, r] of runs) if (r.done && now - r.done > KEEP_MS) runs.delete(k); };

export const handsBusy = () => [...runs.values()].some((r) => !r.done);

export function handsRoutes(deps: { spillRoot: string; capture: (err: unknown, ctx: Record<string, unknown>) => { message: string }; instructions: (cwd: string) => string }) {
  const { spillRoot } = deps;
  const call = (q: any, signal: AbortSignal) => runHands(q, spillRoot, signal).catch((e) => {
    const rec = deps.capture(e, { at: "fleet hands", tool: q.tool });
    return { content: `Tool failed on this machine: ${rec.message}`, is_error: true } as ToolOutput;
  });
  return {
    "/api/fleet/facts": { GET: async (req: Request) => json(await localFacts(new URL(req.url).searchParams.get("root") ?? undefined)) },

    // One workspace tool call. The answer is JSON preceded by spaces sent while
    // the call runs, so the connection stays open.
    "/api/fleet/hands": {
      POST: async (req: Request) => {
        const q = await body(req);
        let run: Run | undefined;
        const key = q.detach && typeof q.call === "string" && q.call ? `${q.session}:${q.call}` : "";
        if (key) {
          sweep();
          run = runs.get(key);
          if (!run) {
            const ctl = new AbortController();
            const r: Run = { ctl, out: call(q, ctl.signal) };
            r.out.finally(() => { r.done = Date.now(); });
            runs.set(key, (run = r));
          }
        }
        const ctl = new AbortController();
        if (!run) req.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
        const work = run ? run.out : call(q, ctl.signal);
        return keepalive(() => work);
      },
    },
    "/api/fleet/hands/cancel": {
      POST: async (req: Request) => {
        const q = await body(req);
        const r = runs.get(`${q.session}:${q.call}`);
        r?.ctl.abort();
        return json({ cancelled: !!r && !r.done });
      },
    },

    // The terminal pane of a session placed here: its jobs on this machine, a
    // log read, a stop, the owner's command and waiting for it.
    "/api/fleet/hands/terminal": {
      POST: async (req: Request) => {
        const b = await body(req);
        const sid = String(b.session ?? "");
        if (!/^[\w-]+$/.test(sid)) return bad("no session");
        switch (b.op) {
          case "list": return json({ jobs: listJobs(spillRoot, sid) });
          case "log": return json({ log: readJobLog(spillRoot, sid, String(b.job ?? ""), Number(b.from ?? 0)) });
          case "stop": return json({ stopped: await stopOne(sid, String(b.job ?? "")) });
          case "run": {
            const cwd = resolve(String(b.cwd ?? ""));
            if (!b.root || !contains(resolve(b.root), cwd) || !existsSync(cwd)) return bad(`not a directory inside the granted one: ${cwd}`);
            const j = ownerRun(spillRoot, sid, String(b.command ?? ""), cwd);
            return json({ job: { id: j.id, command: j.command, cwd } });
          }
          case "wait": {
            const id = String(b.job ?? "");
            return keepalive(async () => ({ job: await waitOne(spillRoot, sid, id, 5 * 60_000, req.signal), log: logPath(spillRoot, sid, id) }));
          }
          default: return bad("unknown op");
        }
      },
    },

    "/api/fleet/hands/instructions": {
      POST: async (req: Request) => {
        const b = await body(req);
        if (!b.cwd || !b.root || !contains(resolve(b.root), resolve(b.cwd))) return json({ text: "" });
        return json({ text: existsSync(b.cwd) ? deps.instructions(resolve(b.cwd)) : "" });
      },
    },

    // The uncommitted work in a folder of the granted directory, as the
    // daemon's own git reads it: what status lists, and each submodule asked
    // through its own view (src/core/git.ts). `base`: also the commits over it.
    "/api/fleet/hands/work": {
      POST: async (req: Request) => {
        const b = await body(req);
        const dir = resolve(String(b.dir ?? ""));
        if (!b.root || !contains(resolve(b.root), dir) || !existsSync(dir)) return json({ error: `not a directory inside the granted one: ${dir}` });
        return keepalive(async () => {
          const [st, work, ahead] = await Promise.all([
            git(dir, ["status", "--porcelain", "-z"], { read: true }),
            innerWork(dir),
            typeof b.base === "string" && /^[\w./-]+$/.test(b.base) && !b.base.startsWith("-") ? git(dir, ["rev-list", "--count", `${b.base}..HEAD`], { read: true }) : undefined,
          ]);
          if (st.code !== 0) return { error: st.err.trim().slice(0, 300) || "git could not read the folder" };
          const listed = new Set<string>();
          const recs = st.out.split("\0").filter(Boolean);
          for (let i = 0; i < recs.length; i++) {
            listed.add(recs[i]!.slice(3).replace(/\/$/, ""));
            if (recs[i]![0] === "R" || recs[i]![0] === "C") i++;
          }
          return {
            dirty: listed.size + work.dirty.filter((p) => !listed.has(p)).length, unpushed: work.unpushed, unknown: work.unknown,
            ...(ahead ? { ahead: ahead.code === 0 ? Number(ahead.out.trim()) : undefined } : {}),
          };
        });
      },
    },

    "/api/fleet/hands/stat": {
      POST: async (req: Request) => {
        const b = await body(req);
        const p = resolve(String(b.path ?? ""));
        if (!b.root || !contains(resolve(b.root), p)) return json({ exists: false, dir: false, error: "outside the granted directory" });
        try {
          const st = statSync(p);
          return json({ exists: true, dir: st.isDirectory() });
        } catch {
          return json({ exists: false, dir: false });
        }
      },
    },

    // One script in the granted directory, for a handoff's git steps: no tool
    // state (a tool's shell keeps its own working directory between calls).
    "/api/fleet/hands/exec": {
      POST: async (req: Request) => {
        const b = await body(req);
        const cwd = resolve(String(b.cwd ?? ""));
        if (!b.root || !contains(resolve(b.root), cwd) || !existsSync(cwd)) return json({ code: 127, out: `not a directory inside the granted one: ${cwd}` });
        const named = namedSecrets({ script: String(b.script ?? "") }, SCRIPT);
        if ("error" in named) return json({ error: named.error });
        const argv = execArgv(named.value.script, resolve(b.root), b.confined && typeof b.confined === "object" ? b.confined : undefined);
        if ("error" in argv) return json({ error: argv.error });
        return keepalive(async () => {
          const p = Bun.spawn(argv, {
            // (`view`: a script of the daemon's own, a session's move, whose git reads the repository in `cwd` through this machine's view of it.
            // `fetch`: it fills a work tree there, and may fetch what a partial clone lacks as far as that reaches: GitOpts.fetch.)
            cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...(b.view === true ? gitEnv(cwd, b.fetch === "any" || b.fetch === "public" ? b.fetch : undefined) : {}), GIT_TERMINAL_PROMPT: "0", ...named.env }, signal: req.signal,
            timeout: 10 * 60_000, // the longest a shell call may run in any family
          });
          const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
          return { code, out: vault.mask((out + err).slice(-200_000)) };
        });
      },
    },

    // A file into or out of the granted directory (a handoff's git bundle).
    "/api/fleet/hands/put": {
      POST: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const p = resolve(u.get("path") ?? "");
        if (!u.get("root") || !contains(resolve(u.get("root")!), p) || !contains(realOf(u.get("root")!), realOf(p))) return bad("outside the granted directory");
        { const held = heldFile(p); if (held) return bad(held); }
        mkdirSync(dirname(p), { recursive: true });
        await Bun.write(p, await req.arrayBuffer());
        return json({ ok: true });
      },
    },
    "/api/fleet/hands/get": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const p = resolve(u.get("path") ?? "");
        if (!u.get("root") || !contains(resolve(u.get("root")!), p)) return bad("outside the granted directory");
        { const held = heldFile(p); if (held) return bad(held); }
        const file = Bun.file(p);
        return (await file.exists()) ? new Response(file, { headers: { "content-type": "application/octet-stream" } }) : bad("no such file", 404);
      },
    },
  } satisfies Record<string, Record<string, (req: Request) => Promise<Response>>>;
}
