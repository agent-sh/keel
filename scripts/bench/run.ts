#!/usr/bin/env bun
// Token benchmark: the fixed tasks of tasks.ts, each in a fresh scratch repo,
// run through this tree's own engine, routes and tools in-process (the same
// wiring as `keel serve`), on one model. Per task it records total input,
// cached input, cache writes, output, model requests, tool calls, wall time,
// cost and success, plus the request shape (tools, system and history bytes).
//
//   bun scripts/bench/run.ts --model bedrock:global.anthropic.claude-haiku-5-5 --label base [--reps 2] [--tasks a,b]
//   bun scripts/bench/run.ts ... --gap 6   (then a follow-up prompt after a 6 minute pause, tasks side by side)
//   bun scripts/bench/run.ts ... --without run_code   (a shared tool left out, to measure what it brings)
//   bun scripts/bench/run.ts ... --no-defer   (Claude with every tool eager and the search_tools/mcp_call pair)
//   bun scripts/bench/run.ts compare base lever1 ...
//   bun scripts/bench/run.ts --experiment readers --tasks readlog,readspec,readcode --reps 3 --model ID
//     (an experiment: a template id, a JSON file, or --daemon URL --experiment ID; the arms run
//      interleaved per task and repetition, the report has per-arm intervals and the effect;
//      --daemon also uploads each run to that daemon's experiment)
//
// Results go to $KEEL_BENCH_DIR (default ~/.cache/keel-work/bun/tokens): never into the repo.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { TASKS } from "./tasks.ts";

const OUT = process.env.KEEL_BENCH_DIR ?? join(homedir(), ".cache/keel-work/bun/tokens");
const TASK_TIMEOUT_MS = 8 * 60_000;
const FOLLOWUP = "In two sentences: what did you find or change, and how do you know it is right?";

type Row = {
  label: string; model: string; task: string; rep: number; ok: boolean; why: string; arm?: string; tool_errors?: number;
  input: number; cache_read: number; cache_write: number; output: number; total_in: number;
  cost?: number; requests: number; tools: number; tool_names: Record<string, number>;
  cache_write_1h: number;
  followup?: { input: number; cache_read: number; cache_write: number; cache_write_1h: number; output: number; cost?: number; requests: number; per?: undefined };
  ms: number; first_prefix: number; tools_bytes: number; system_bytes: number; last_messages_bytes: number;
  per_request: { input: number; cache_read: number; cache_write: number; cache_write_1h: number; output: number }[];
  reply: string; error?: string; ts: string;
  // Everything the session spent, side calls included (a reader's read, a summary).
  session_cost?: number; session_in: number; session_out: number;
};

function loadEnvFile(p: string) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

type BenchArm = import("../../src/admin/experiments.ts").Arm;
async function bench(opts: { model: string; label: string; reps: number; tasks: string[]; gapMin?: number; without: string[]; noDefer?: boolean; arms?: BenchArm[]; onRow?: (r: Row) => void | Promise<void> }) {
  loadEnvFile(join(homedir(), ".config/claude-code/bedrock.env"));
  const { Bus } = await import("../../src/core/bus.ts");
  const { ErrorTracker } = await import("../../src/core/errors.ts");
  const { Store } = await import("../../src/core/store.ts");
  const { Engine } = await import("../../src/engine/turn.ts");
  const { registerHooks } = await import("../../src/engine/hooks.ts");
  const { Providers } = await import("../../src/providers/registry.ts");
  const { serve } = await import("../../src/server/app.ts");
  const { routeModules } = await import("../../src/server/routes/index.ts");
  const perms = await import("../../src/server/routes/permissions.ts");

  const stateDir = join(OUT, "state", opts.label);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  // A task that needs MCP servers runs with exactly those; other runs keep the daemon's usual config.
  const servers = Object.assign({}, ...TASKS.filter((t) => !opts.tasks.length || opts.tasks.includes(t.id)).map((t) => t.mcp ?? {}));
  if (Object.keys(servers).length) {
    process.env.KEEL_MCP_CONFIG = join(stateDir, "mcp.json");
    writeFileSync(process.env.KEEL_MCP_CONFIG, JSON.stringify({ servers }));
  }
  const store = new Store(stateDir);
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const providers = new Providers(stateDir, { capture: (s, e, c) => errors.capture(s, e, c) });
  providers.start();
  const engine = new Engine(store, bus, providers, errors, join(stateDir, "spill"));
  const server = serve({ store, bus, engine, providers, errors, workspace: OUT }, { hostname: "127.0.0.1", port: 0 }, routeModules);
  perms.gate!.setDefaultMode("full-auto" as any);
  const { unregisterShared } = await import("../../src/tools/registry.ts");
  for (const name of opts.without) unregisterShared(name);
  const resolved = await providers.resolve(opts.model);
  if (opts.noDefer) (await import("../../src/tools/defer.ts")).refuseDefer(resolved.info.id);
  // An experiment arm per session: its tools, its prompt addition and its cache lifetime.
  const armOf = new Map<string, BenchArm>();
  const { withToolText } = await import("../../src/admin/experiments.ts");
  (await import("../../src/tools/registry.ts")).registerToolsOff("bench-arm", (sid) => armOf.get(sid)?.tools_off ?? []);
  registerHooks({
    sessionSystem: (s) => armOf.get(s.id)?.system_append ?? "",
    beforeRequest: (s, req) => { const life = req.purpose !== "reader" ? armOf.get(s.id)?.cache_life : undefined; return withToolText(life ? { ...req, cacheLife: life } : req, armOf.get(s.id)); },
  });

  // The request shape, measured as it leaves the engine (after every hook).
  const shape = new Map<string, { tools: number; system: number; messages: number }>();
  const last = new Map<string, unknown>();
  registerHooks({
    beforeRequest(s, req) {
      shape.set(s.id, { tools: JSON.stringify(req.tools).length, system: req.system.length, messages: JSON.stringify(req.messages).length });
      last.set(s.id, { model: req.model, effort: req.effort, system: req.system, tools: req.tools, messages: req.messages });
      return req;
    },
  });

  // Tasks whose material a model writes: written once by the cheapest model
  // that reads for this one (the readers' own choice), cached for every run.
  const writing = TASKS.filter((t) => t.prepare && (!opts.tasks.length || opts.tasks.includes(t.id)));
  if (writing.length) {
    const { readerChoices } = await import("../../src/engine/reader.ts");
    const { smallModels } = await import("../../src/engine/readers.ts");
    const w = readerChoices(await providers.models(), resolved.info, 20_000, process.env, (m) => providers.catalog.lookup(m.model)?.price, smallModels())[0]!;
    const { provider, info } = await providers.resolve(w.id);
    const writer = {
      id: info.id,
      async write(prompt: string) {
        const res = await provider.stream({ model: info.model, route: info.id, system: "You write realistic business documents for a test corpus.", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], maxTokens: Math.min(info.output || 16_000, 16_000), signal: AbortSignal.timeout(300_000), cache: false }, () => {});
        return res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");
      },
    };
    console.log(`writing material for ${writing.map((t) => t.id).join(", ")} with ${info.name} (cached under ${join(OUT, "material")})`);
    for (const t of writing) await t.prepare!(writer, join(OUT, "material"));
  }

  const results = join(OUT, "results", `${opts.label}.jsonl`);
  mkdirSync(dirname(results), { recursive: true });
  const picked = TASKS.filter((t) => !opts.tasks.length || opts.tasks.includes(t.id));

  const turn = async (sid: string, text: string) => {
    const done = new Promise<void>((resolve) => {
      const off = bus.on((f) => {
        if (f.t === "event" && f.event.session_id === sid && (f.event.kind === "turn_end" || f.event.kind === "error")) { off(); resolve(); }
      });
    });
    const from = store.events(sid).length;
    engine.send(sid, text);
    const timedOut = await Promise.race([done.then(() => false), Bun.sleep(TASK_TIMEOUT_MS).then(() => true)]);
    if (timedOut) await engine.interrupt(sid);
    // A turn that failed writes its error after its turn_end: read the events once the turn has settled.
    await engine.idle(sid);
    return { timedOut, events: store.events(sid).slice(from) };
  };
  const usageOf = (events: any[]) => {
    const per = events.filter((e) => e.kind === "assistant").map((e) => {
      const u = e.data.usage ?? {};
      return { input: u.input ?? 0, cache_read: u.cache_read ?? 0, cache_write: u.cache_write ?? 0, cache_write_1h: u.cache_write_1h ?? 0, output: u.output ?? 0, cost: u.cost as number | undefined };
    });
    const sum = (k: "input" | "cache_read" | "cache_write" | "cache_write_1h" | "output") => per.reduce((a, u) => a + u[k], 0);
    const costs = per.map((u) => u.cost);
    return {
      per, input: sum("input"), cache_read: sum("cache_read"), cache_write: sum("cache_write"), cache_write_1h: sum("cache_write_1h"), output: sum("output"),
      cost: costs.every((x) => x !== undefined) ? costs.reduce((a, x) => a + (x as number), 0) : undefined,
    };
  };

  async function runOne(task: (typeof TASKS)[number], rep: number, arm?: BenchArm) {
    const dir = join(OUT, "runs", opts.label, `${task.id}-${rep}${arm ? `-${arm.name.replace(/[^a-z0-9]+/gi, "_")}` : ""}`);
    rmSync(dir, { recursive: true, force: true });
    for (const [p, body] of Object.entries(task.files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "start"], { cwd: dir });

    const model = arm?.model ?? opts.model;
    const s = store.createSession({ model, workspace: dir, title: `bench ${task.id}`, settings: (arm?.settings ?? {}) as any });
    if (arm) armOf.set(s.id, arm);
    const t0 = Date.now();
    const first = await turn(s.id, task.prompt);
    const ms = Date.now() - t0;
    const events = first.events;
    const asst = events.filter((e) => e.kind === "assistant");
    const u = usageOf(events);
    const names: Record<string, number> = {};
    for (const e of asst) for (const b of e.data.blocks) if (b.type === "tool_use") names[b.name] = (names[b.name] ?? 0) + 1;
    const reply = [...asst].reverse().find((e) => e.data.blocks.some((b: any) => b.type === "text"))?.data.blocks
      .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? "";
    const err = events.find((e) => e.kind === "error")?.data.message;
    const c = first.timedOut ? { ok: false, why: "timed out" } : task.check(dir, reply);
    const sh = shape.get(s.id) ?? { tools: 0, system: 0, messages: 0 };
    // The owner comes back after a pause: what the next turn pays for the
    // conversation so far depends on whether its cache outlived the pause.
    let followup: Row["followup"];
    if (opts.gapMin) {
      await Bun.sleep(opts.gapMin * 60_000);
      const f = usageOf((await turn(s.id, FOLLOWUP)).events);
      followup = { ...f, requests: f.per.length, per: undefined };
    }
    const p0 = u.per[0];
    const toolErrors = events.filter((e) => e.kind === "tool_result").reduce((n, e) => n + (e.data.results ?? []).filter((r: any) => r.is_error).length, 0);
    const row: Row = {
      label: opts.label, model, task: task.id, rep, ok: c.ok, why: c.why, arm: arm?.name, tool_errors: toolErrors,
      input: u.input, cache_read: u.cache_read, cache_write: u.cache_write, cache_write_1h: u.cache_write_1h, output: u.output,
      total_in: u.input + u.cache_read + u.cache_write, cost: u.cost,
      requests: asst.length, tools: Object.values(names).reduce((a, n) => a + n, 0), tool_names: names, ms,
      first_prefix: p0 ? p0.input + p0.cache_read + p0.cache_write : 0,
      tools_bytes: sh.tools, system_bytes: sh.system, last_messages_bytes: sh.messages,
      per_request: u.per.map(({ cost: _c, ...x }) => x), followup, reply: reply.slice(0, 2000), error: err, ts: new Date().toISOString(),
      ...(() => { const su = store.session(s.id)!.usage; return { session_cost: su.cost, session_in: su.input + su.cache_read + su.cache_write, session_out: su.output }; })(),
    };
    appendFileSync(results, JSON.stringify(row) + "\n");
    await opts.onRow?.(row);
    writeFileSync(join(dir, ".bench-request.json"), JSON.stringify(last.get(s.id), null, 1));
    const fu = followup ? ` | after ${opts.gapMin}m: read=${followup.cache_read} write=${followup.cache_write} cost=${followup.cost?.toFixed(6)}` : "";
    console.log(`${arm ? `[${arm.name}] ` : ""}${task.id}#${rep} ${c.ok ? "ok" : "FAIL"} in=${row.total_in} cached=${row.cache_read} write=${row.cache_write} out=${row.output} req=${row.requests} tools=${row.tools} ${(ms / 1000).toFixed(0)}s ${c.why}${err ? ` error=${err}` : ""}${fu}`);
  }

  const jobs: [(typeof TASKS)[number], number, BenchArm?][] = [];
  for (let rep = 1; rep <= opts.reps; rep++) {
    picked.forEach((t, ti) => {
      if (!opts.arms) return void jobs.push([t, rep]);
      // Arms interleaved, their order rotated by repetition and task, so a
      // drift over the run (provider load, a warm cache) falls on every arm alike.
      const k = opts.arms.length;
      for (let j = 0; j < k; j++) jobs.push([t, rep, opts.arms[(j + rep + ti) % k]!]);
    });
  }
  if (opts.gapMin) {
    // Pauses run side by side, started 20 s apart so no two first requests race for the same cache entry.
    await Promise.all(jobs.map(([t, rep, a], i) => Bun.sleep(i * 20_000).then(() => runOne(t, rep, a))));
  } else {
    for (const [t, rep, a] of jobs) await runOne(t, rep, a);
  }
  server.stop(true);
  providers.shutdown();
}

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0;
}

function compare(labels: string[]) {
  const rows = (l: string): Row[] => {
    const p = join(OUT, "results", `${l}.jsonl`);
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)) : [];
  };
  const cols = ["ok", "total_in", "cache_read", "cache_write", "input", "output", "requests", "tools", "s", "cost", "cached%", "all cost"];
  console.log(`| label | task | ${cols.join(" | ")} |`);
  console.log(`|${" --- |".repeat(cols.length + 2)}`);
  for (const l of labels) {
    const all = rows(l);
    const tasks = [...new Set(all.map((r) => r.task)), "ALL"];
    for (const t of tasks) {
      const rs = t === "ALL" ? all : all.filter((r) => r.task === t);
      if (!rs.length) continue;
      // ALL is the mean per task run, so labels with different rep counts compare.
      const m = (f: (r: Row) => number) => mean(rs.map(f));
      const tin = m((r) => r.total_in);
      const cells = [
        `${rs.filter((r) => r.ok).length}/${rs.length}`,
        tin.toFixed(0), m((r) => r.cache_read).toFixed(0), m((r) => r.cache_write).toFixed(0), m((r) => r.input).toFixed(0),
        m((r) => r.output).toFixed(0), m((r) => r.requests).toFixed(1), m((r) => r.tools).toFixed(1), (m((r) => r.ms) / 1000).toFixed(0),
        rs.every((r) => r.cost !== undefined) ? `$${m((r) => r.cost!).toFixed(5)}` : "?",
        tin ? `${((100 * m((r) => r.cache_read)) / tin).toFixed(0)}%` : "-",
        rs.every((r) => r.session_cost !== undefined) ? `$${m((r) => r.session_cost!).toFixed(5)}` : "-",
      ];
      console.log(`| ${l} | ${t} | ${cells.join(" | ")} |`);
    }
  }
}

// A run's values for the experiment metrics: everything the session spent, readers included.
function runMetrics(r: Row): Record<string, number> {
  const turnIn = r.total_in;
  return {
    ...(r.session_cost !== undefined ? { cost_usd: r.session_cost } : {}),
    prompt_tokens: r.session_in, output_tokens: r.session_out, ms: r.ms, ok: r.ok ? 1 : 0, requests: r.requests,
    ...(turnIn ? { cache_read_share: r.cache_read / turnIn } : {}), tool_errors: r.tool_errors ?? 0,
  };
}

async function experiment(opts: { spec: string; daemon?: string; model?: string; reps?: number; tasks: string[] }) {
  const ex = await import("../../src/admin/experiments.ts");
  type Exp = import("../../src/admin/experiments.ts").Experiment;
  let e: Exp;
  const daemon = opts.daemon?.replace(/\/$/, "");
  if (daemon) {
    const r = await fetch(`${daemon}/api/experiments/${opts.spec}`);
    if (!r.ok) throw new Error(`the daemon has no experiment ${opts.spec}: ${r.status}`);
    e = (await r.json()).experiment;
  } else {
    const t = ex.TEMPLATES.find((x) => x.id === opts.spec);
    const spec = t ? t.make() : JSON.parse(readFileSync(opts.spec, "utf8"));
    ex.validate(spec);
    e = { ...spec, id: `local-${Date.now()}`, state: "running", created_ms: Date.now() } as Exp;
  }
  if (e.mode !== "offline") throw new Error(`${e.name} is a live experiment: the daemon runs it in new sessions`);
  if (daemon && e.state === "draft") {
    const r = await fetch(`${daemon}/api/experiments/${e.id}/start`, { method: "POST" });
    if (!r.ok) throw new Error(`could not start it on the daemon: ${r.status} ${await r.text()}`);
  }
  const model = opts.model ?? e.stop.model;
  if (!model) throw new Error("name the model the arms run on (--model), or put it in the experiment's stop.model");
  const tasks = opts.tasks.length ? opts.tasks : e.stop.tasks ?? [];
  if (!tasks.length) throw new Error("name the tasks (--tasks) or put them in the experiment's stop.tasks");
  const label = `exp-${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const rows: Row[] = [];
  await bench({ model, label, reps: opts.reps ?? e.stop.reps ?? 3, tasks, without: [], arms: e.arms,
    onRow: async (r) => {
      rows.push(r);
      if (!daemon) return;
      const res = await fetch(`${daemon}/api/experiments/${e.id}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runs: [{ arm: r.arm, task: r.task, rep: r.rep, metrics: runMetrics(r) }] }) });
      if (!res.ok) console.error(`upload failed: ${res.status} ${await res.text()}`);
    } });
  const rep = ex.report(e, rows.map((r, i) => ({ arm: r.arm!, cluster: `run-${i}`, stratum: r.task, m: runMetrics(r) })));
  console.log(`\n${e.name}: ${e.hypothesis}\nmodel ${model}, tasks ${tasks.join(", ")}, unit: ${rep.unit}. Means with 95% BCa bootstrap intervals; effects are arm minus ${e.arms[0]!.name}.\n`);
  const show = (m: string, v: number) => (m === "cost_usd" ? `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(5)}` : m === "ok" || m === "cache_read_share" ? `${(v * 100).toFixed(0)}%` : m === "ms" ? `${(v / 1000).toFixed(1)}s` : v.toFixed(0));
  const metrics = ["cost_usd", "prompt_tokens", "output_tokens", "ms", "ok", "requests", "tool_errors"];
  console.log(`| metric | ${rep.arms.map((a) => `${a.arm} (n=${a.units})`).join(" | ")} | effect | significant |`);
  console.log(`|${" --- |".repeat(rep.arms.length + 3)}`);
  for (const m of metrics) {
    const cells = rep.arms.map((a) => { const iv = a.metrics[m as keyof typeof a.metrics]; return iv ? `${show(m, iv.estimate)} [${show(m, iv.lo)}, ${show(m, iv.hi)}]` : "-"; });
    const f = rep.effects.find((x) => x.metric === m);
    const eff = f ? `${f.diff.estimate >= 0 ? "+" : ""}${show(m, f.diff.estimate)} [${show(m, f.diff.lo)}, ${show(m, f.diff.hi)}]${f.diff.relative !== null ? ` (${(f.diff.relative * 100).toFixed(0)}%)` : ""}` : "-";
    console.log(`| ${m}${m === e.primary ? " (primary)" : ""} | ${cells.join(" | ")} | ${eff} | ${f ? (f.diff.significant ? "yes" : "no") : "-"} |`);
  }
  // Which tools each arm's runs called: an arm whose model never used the tool under test has no effect to show.
  for (const a of e.arms) {
    const names: Record<string, number> = {};
    for (const r of rows.filter((x) => x.arm === a.name)) for (const [k, n] of Object.entries(r.tool_names)) names[k] = (names[k] ?? 0) + n;
    console.log(`Tools called, ${a.name}: ${Object.entries(names).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  }
  console.log(`\nGuards: ${rep.guards.map((g) => `${g.arm} ${g.metric}: likelihood ratio ${g.lr.toFixed(2)}${g.worse ? " (worse)" : ""}`).join("; ") || "none"}`);
  console.log(`Decision: ${rep.decision.text} ${rep.decision.remove}`);
  if (daemon) {
    const r = await fetch(`${daemon}/api/experiments/${e.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "the offline run finished" }) });
    if (!r.ok) console.error(`could not stop it on the daemon: ${r.status} ${await r.text()}`);
  }
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2), allowPositionals: true,
  options: { experiment: { type: "string" }, daemon: { type: "string" }, model: { type: "string" }, label: { type: "string" }, reps: { type: "string", default: "1" }, tasks: { type: "string", default: "" }, gap: { type: "string" }, without: { type: "string", default: "" }, "no-defer": { type: "boolean", default: false } },
});
if (positionals[0] === "compare") compare(positionals.slice(1));
else if (values.experiment) {
  await experiment({ spec: values.experiment, daemon: values.daemon, model: values.model, reps: Bun.argv.includes("--reps") ? Number(values.reps) : undefined, tasks: values.tasks ? values.tasks.split(",") : [] });
  process.exit(0);
} else {
  if (!values.model || !values.label) {
    console.error("usage: run.ts --model ID --label NAME [--reps N] [--tasks a,b] [--without tool,tool] [--no-defer] | run.ts compare LABEL...");
    process.exit(2);
  }
  await bench({ model: values.model, label: values.label, reps: Number(values.reps), tasks: values.tasks ? values.tasks.split(",") : [], gapMin: values.gap ? Number(values.gap) : undefined, without: values.without ? values.without.split(",") : [], noDefer: values["no-defer"] });
  process.exit(0);
}
