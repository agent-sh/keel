// A run of read-only steps told what it costs (src/engine/read-run.ts): in a
// tree whose top session has `read_runs`, an agent's second read-only step in
// a row of one call each gets the note on its result, once a run, with what
// one step of its context reads and costs; on "reader" the note also offers
// an Explore agent, which searches on the reader model there
// (src/automation/agents.ts).
import type { Session } from "../../core/types.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { explores, nextRun, readerFor, readNote, readRunsOf, START, type RunState } from "../../engine/read-run.ts";
import { readRate } from "../../engine/reader.ts";
import { smallModels } from "../../engine/readers.ts";
import type { RouteModule } from "../app.ts";

// A step being run: its calls, how many have come back, how many only read,
// and the tokens its request carried.
type Pending = { calls: number; seen: number; reads: number; context: number };

export const readRunRoutes: RouteModule = ({ store, providers }) => {
  const runs = new Map<string, RunState>();
  const steps = new Map<string, Pending>();
  const parentOf = (id: string) => store.session(id);
  // (Only agents are told: a top session asks the store nothing on each of its steps.)
  const arm = (s: Session) => (s.parent_id ? readRunsOf(store.session(s.id) ?? s, parentOf) : undefined);
  const listPrice = (m: { model: string }) => providers.catalog.lookup(m.model)?.price;
  const forget = (id: string) => { runs.delete(id); steps.delete(id); };
  const close = (s: Session, p: Pending) => {
    const r = nextRun(runs.get(s.id) ?? START, { calls: p.calls, reads: p.reads });
    runs.set(s.id, r.state);
    steps.delete(s.id);
    return r.note;
  };
  registerHooks({
    afterResponse(s, res) {
      if (!arm(s)) return forget(s.id);
      // A step whose calls did not all come back (one the gate refused) ended the run.
      const was = steps.get(s.id);
      if (was && was.seen < was.calls) runs.set(s.id, START);
      const calls = res.blocks.filter((b) => b.type === "tool_use").length;
      const u = res.usage;
      const p: Pending = { calls, seen: 0, reads: 0, context: (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0) };
      if (calls) steps.set(s.id, p);
      else close(s, p);
    },
    afterTool(s, call, result) {
      const p = steps.get(s.id);
      if (!p) return;
      p.seen++;
      if (explores(call.tool.name, call.input)) p.reads++;
      if (p.seen < p.calls || !close(s, p)) return;
      const models = providers.current();
      const info = models.find((m) => m.id === s.model);
      // What a step of this context costs: its cached tokens at the model's cache read price (a plan's at the
      // same model's per-token price, which says how much of the plan it takes).
      const price = info?.billing === "per_token" ? info.price : info?.billing === "subscription" ? listPrice(info) : undefined;
      const rate = price?.cache_read;
      let offer: { start: string; model: string; share: number } | undefined;
      if (info && arm(s) === "reader") {
        const start = call.ctx.offers?.("Agent") ? "an Explore agent (Agent with subagent_type Explore)" : call.ctx.offers?.("spawn_agent") ? "an explorer agent (spawn_agent with agent_type explorer)" : undefined;
        const reader = start ? readerFor(models, info, process.env, listPrice, smallModels()) : undefined;
        const own = readRate(info, listPrice), r = reader ? readRate(reader, listPrice) : undefined;
        if (start && reader && r !== undefined && own) offer = { start, model: reader.name, share: r / own };
      }
      const note = readNote(p.context, rate, offer);
      if (typeof result.content === "string") result.content = `${result.content}\n\n${note}`;
      else result.content = [...result.content, { type: "text", text: note }];
    },
    // A call that threw is a step's call that came back too; it reads or not as any other.
    toolFailed(s, call) {
      const p = steps.get(s.id);
      if (!p) return;
      p.seen++;
      if (explores(call.tool.name, call.input)) p.reads++;
      if (p.seen >= p.calls) close(s, p);
    },
    turnEnd: (s) => forget(s.id),
  });
  return {};
};
