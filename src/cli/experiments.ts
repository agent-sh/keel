// keel experiments list|templates|start|stop|report: trials of a change, from a terminal
// (the routes of src/server/routes/experiments.ts; the page's Settings > Experiments is the same data).
import { ago, command, EXIT, line, printJson, usageError, type Client } from "./client.ts";

const USAGE = `keel experiments [list] [--json]
keel experiments templates [--json]
keel experiments start TEMPLATE [--json]
keel experiments stop ID [REASON...] [--json]
keel experiments report ID [--json]
  Experiments: arms that differ in configuration, the metric that judges them, and a stop rule.

  list        every experiment: its state, arms, units so far and the primary metric by arm
  templates   the starting points (id, mode, arms, primary metric)
  start       create an experiment from a template and start it. One live experiment runs at a time:
              a start while another runs is refused, and the refusal says which one
  stop        end a running experiment and record the decision with its report
  report      the report: each arm's figures, the effects, the guards and the decision

  An experiment is named by its id or the start or the end of it that list shows.`;

type Exp = { id: string; name: string; mode: "live" | "offline"; state: string; primary: string; arms: { name: string }[]; sessions?: { arm: string; n: number }[]; runs?: number; started_ms?: number; stopped_ms?: number; stop_reason?: string; created_ms: number };
type Metrics = Record<string, { label: string; unit: string }>;
type Interval = { estimate: number; lo: number; hi: number; n: number };
type Report = { arms: { arm: string; units: number; clusters: number; metrics: Record<string, Interval | undefined> }[]; effects: { arm: string; metric: string; diff: Interval & { significant: boolean }; better: boolean | null }[]; guards: { arm: string; metric: string; reject: boolean; worse: boolean }[]; judged: boolean; decision: { verdict: string; winner: string | null; text: string; remove: string } };

// A value in the metric's unit (the daemon's list says each metric's unit).
function value(unit: string | undefined, v: number): string {
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (unit === "usd") return `${sign}$${a < 0.01 && a !== 0 ? a.toPrecision(2) : a.toFixed(4)}`;
  if (unit === "share") return `${(v * 100).toFixed(a < 0.1 && a !== 0 ? 1 : 0)}%`;
  if (unit === "ms") return `${(v / 1000).toFixed(1)}s`;
  return a < 10 ? Number(v.toFixed(2)).toString() : Math.round(v).toString();
}

const units = (e: Exp) => (e.mode === "offline" ? `${e.runs ?? 0} runs` : `${(e.sessions ?? []).reduce((n, s) => n + s.n, 0)} session families`);
const when = (e: Exp) => (e.state === "running" ? `since ${ago(e.started_ms ?? e.created_ms)}` : e.state === "stopped" ? `stopped ${ago(e.stopped_ms ?? e.created_ms)} ago${e.stop_reason ? `: ${line(e.stop_reason)}` : ""}` : `made ${ago(e.created_ms)} ago`);

async function all(c: Client) {
  return c.get<{ experiments: Exp[]; templates: ({ id: string; label: string } & Omit<Exp, "id" | "state" | "created_ms">)[]; metrics: Metrics }>("/api/experiments");
}

// The experiment a word names: the whole id, or the start or the end of it.
function pick(list: Exp[], word: string | undefined): Exp | string {
  if (!word) return "name an experiment (keel experiments list shows them)";
  const hits = list.filter((e) => e.id === word || e.id.startsWith(word) || e.id.endsWith(word));
  const exact = hits.filter((e) => e.id === word);
  if (exact.length === 1) return exact[0]!;
  if (hits.length === 1) return hits[0]!;
  return hits.length ? `${word} names ${hits.length} experiments; give more of the id` : `no experiment ${word}`;
}

export const experimentsCmd = command("experiments", USAGE, {}, async (v, pos, c) => {
  const [sub = "list", arg, ...rest] = pos;
  if (sub === "list") {
    const r = await all(c);
    const shown = await Promise.all(r.experiments.map(async (e) => ({ e, report: e.state === "draft" ? undefined : (await c.get<{ report: Report }>(`/api/experiments/${e.id}`)).report })));
    if (v.json) return (printJson(shown.map(({ e, report }) => ({ ...e, report: report && { arms: report.arms.map((a) => ({ arm: a.arm, [e.primary]: a.metrics[e.primary] })), judged: report.judged, decision: report.decision } }))), EXIT.ok);
    if (!shown.length) console.error("no experiment yet: keel experiments templates, then keel experiments start TEMPLATE");
    for (const { e, report } of shown) {
      const unit = r.metrics[e.primary]?.unit;
      const figures = (report?.arms ?? []).filter((a) => a.metrics[e.primary]).map((a) => `${a.arm} ${value(unit, a.metrics[e.primary]!.estimate)}`).join(", ");
      console.log(`${e.id.slice(-8)}  ${e.state.padEnd(7)}  ${e.mode.padEnd(7)}  ${line(e.name)}  arms: ${e.arms.map((a) => line(a.name)).join(", ")}  ${units(e)}  ${when(e)}`);
      console.log(`          ${r.metrics[e.primary]?.label ?? e.primary}: ${figures || "no figures yet"}`);
    }
    return EXIT.ok;
  }
  if (sub === "templates") {
    const r = await all(c);
    if (v.json) return (printJson(r.templates), EXIT.ok);
    for (const t of r.templates) console.log(`${t.id}  ${t.mode}  ${line(t.label)}  arms: ${t.arms.map((a) => line(a.name)).join(", ")}  judged by ${r.metrics[t.primary]?.label ?? t.primary}`);
    return EXIT.ok;
  }
  if (sub === "start") {
    if (!arg || rest.length) return usageError("experiments", "start needs one template id (keel experiments templates)", USAGE);
    const r = await all(c);
    const t = r.templates.find((x) => x.id === arg);
    if (!t) return usageError("experiments", `no template ${arg}: ${r.templates.map((x) => x.id).join(", ")}`, USAGE);
    // One live experiment at a time: said before anything is made.
    const live = t.mode === "live" ? r.experiments.find((e) => e.state === "running" && e.mode === "live") : undefined;
    if (live) {
      console.error(`keel experiments: ${line(live.name)} (${live.id.slice(-8)}) is running live: stop it first (keel experiments stop ${live.id.slice(-8)})`);
      return EXIT.error;
    }
    const { experiment: made } = await c.post<{ experiment: Exp }>("/api/experiments", { template: arg });
    let started: Exp;
    try { started = (await c.post<{ experiment: Exp }>(`/api/experiments/${made.id}/start`)).experiment; } catch (e) {
      await c.del(`/api/experiments/${made.id}`).catch(() => undefined); // no draft is left behind by a start that was refused
      throw e;
    }
    if (v.json) return (printJson(started), EXIT.ok);
    console.log(`started ${started.id.slice(-8)}: ${line(started.name)} (${started.mode}), arms: ${started.arms.map((a) => line(a.name)).join(", ")}, judged by ${r.metrics[started.primary]?.label ?? started.primary}`);
    console.log(started.mode === "live" ? "New sessions get an arm from now on." : "It takes runs from the offline runner.");
    return EXIT.ok;
  }
  if (sub === "stop" || sub === "report") {
    const r = await all(c);
    const e = pick(r.experiments, arg);
    if (typeof e === "string") return usageError("experiments", e, USAGE);
    if (sub === "stop") {
      const reason = rest.join(" ").trim();
      const { experiment } = await c.post<{ experiment: Exp & { decision?: Report["decision"] } }>(`/api/experiments/${e.id}/stop`, reason ? { reason } : {});
      if (v.json) return (printJson(experiment), EXIT.ok);
      console.log(`stopped ${experiment.id.slice(-8)}: ${line(experiment.name)}${experiment.decision ? `\n${line(experiment.decision.text)}\n${line(experiment.decision.remove)}` : ""}`);
      return EXIT.ok;
    }
    const d = await c.get<{ experiment: Exp; report: Report }>(`/api/experiments/${e.id}`);
    if (v.json) return (printJson(d), EXIT.ok);
    const m = (k: string) => r.metrics[k]?.unit;
    console.log(`${d.experiment.id.slice(-8)}  ${d.experiment.state}  ${line(d.experiment.name)}  ${units(d.experiment)}`);
    for (const a of d.report.arms) {
      const cells = Object.entries(a.metrics).filter(([, i]) => i).map(([k, i]) => `${r.metrics[k]?.label ?? k} ${value(m(k), i!.estimate)} (${value(m(k), i!.lo)} to ${value(m(k), i!.hi)})`);
      console.log(`  ${line(a.arm)}: ${a.units} units${cells.length ? `; ${cells.join("; ")}` : ""}`);
    }
    for (const f of d.report.effects) {
      console.log(`  ${line(f.arm)} on ${r.metrics[f.metric]?.label ?? f.metric}: ${value(m(f.metric), f.diff.estimate)} (${value(m(f.metric), f.diff.lo)} to ${value(m(f.metric), f.diff.hi)})${f.diff.significant ? (f.better ? ", better" : ", worse") : ", no clear difference"}`);
    }
    for (const g of d.report.guards.filter((x) => x.worse)) console.log(`  guard: ${line(g.arm)} is worse on ${r.metrics[g.metric]?.label ?? g.metric}${g.reject ? " (stops it)" : ""}`);
    console.log(`${d.report.decision.verdict}${d.report.judged ? "" : " (not yet judged: the sample is not full)"}: ${line(d.report.decision.text)}`);
    return EXIT.ok;
  }
  return usageError("experiments", `unknown subcommand ${sub}`, USAGE);
});
