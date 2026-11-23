// How much of a tool's text result goes in the context, by what carrying it
// will cost. Every character kept inline is written to the prompt cache once
// and read again by each later request of the context, until a compaction
// takes it; a character spilled to the file costs nothing unless the model
// needs it, and then one more step reads it back: that step reads the whole
// context from the cache and writes a short call. So the inline part of a
// long result is
//
//   tokens = share * (context * read + step * output) / ((1 - share) * (write + later * read))
//
// where `share` is how often the rest is needed, `later` the requests still
// to come in this context, and the prices those of the session's model. A
// long context that will run many more steps keeps less; a short one, or one
// about to end, keeps more. Never less than FLOOR (what the model needs to
// act on a result), never more than the cap a result has without this
// (OUTPUT_CAP), and a failed call keeps that cap: its error is what the model
// acts on. Claude Code, Codex and OpenCode cut results at a fixed size.
import type { Price } from "../providers/types.ts";
import { OUTPUT_CAP } from "./spill.ts";

// The least a result keeps inline: what the shell tool keeps of a failed
// command's output, head and tail (INLINE_FAIL in src/tools/claude.ts).
export const FLOOR = 10_000;
// How often the model needs what was cut. Kept on the high side, one in five,
// the rate at which a spilled output's file is read again when the inline part
// is a short preview; a cut that keeps head and tail is needed less often.
export const REREAD = 0.2;
// Of the inline part of a cut result, the share at its start; the rest is its
// end, where a test run's summary and a command's error stand.
export const HEAD_SHARE = 0.25;

// `context`: the tokens of the last request; `steps`: the requests this
// context has had since its checkpoint; `room`: the tokens left before it is
// compacted; `growth`: tokens a request adds on average; `output`: a step's
// output tokens on average; `bytes`: bytes a token for the model.
export type Carry = { context: number; price?: Price; steps: number; room: number; growth: number; output: number; bytes: number };

// The requests still to come in this context: as many again as it has had
// (half of all contexts go on for as long as they already ran), but no more
// than fit before it is compacted.
export function laterRequests(c: Pick<Carry, "steps" | "room" | "growth">): number {
  const fit = c.growth > 0 ? c.room / c.growth : Infinity;
  return Math.max(1, Math.min(c.steps, fit));
}

// The characters of a text result kept inline for this session now.
export function inlineCap(c: Carry): number {
  // A request past a tier's size is billed at that tier's rates.
  const tier = c.price?.tiers?.filter((t) => c.context > t.above).at(-1);
  const p = tier ?? c.price;
  // No price: nothing to weigh, as before.
  if (!p || !(p.input > 0)) return OUTPUT_CAP;
  const read = p.cache_read ?? p.input, write = p.cache_write ?? p.input, out = p.output ?? p.input;
  const tokens = (REREAD * (c.context * read + c.output * out)) / ((1 - REREAD) * (write + laterRequests(c) * read));
  return Math.round(Math.min(OUTPUT_CAP, Math.max(FLOOR, tokens * c.bytes)));
}
