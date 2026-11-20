// One reading job: the material split into parts that fit the reader, the
// parts read side by side (at most READERS_AT_ONCE at a time), each reader's
// findings with exact quotes and path:line references, and a compile step that
// merges them into one answer for the working model. A reader that fails or
// refuses hands its part to the next choice; a part no reader could read is
// named in the answer, never left out silently.
import { addUsage, emptyUsage, type Usage } from "../core/types.ts";
import type { ModelInfo, Price } from "../providers/types.ts";
import { bytesPerToken } from "./compact.ts";
import { registerSettings, settings } from "../admin/settings.ts";
import {
  checkAnswer, checkedNote, chunkChars, chunkMaterial, compilePrompt, type Checked, materialCap, NOTHING, partPrompt, partRef, READ_CHUNK_CHARS, READERS_AT_ONCE,
  readerChoices, readRate, type Chunk, type Material,
} from "./reader.ts";

// The owner's small models, best first: they read before any other choice.
registerSettings("small_models", { ids: [] }, (v) =>
  Array.isArray(v.ids) && v.ids.every((x: unknown) => typeof x === "string" && x.length > 0) ? undefined : "ids is a list of model ids");
export const smallModels = (): string[] => settings().small_models?.ids ?? [];

export type ReaderAnswer = { text: string; usage: Usage; stop?: string };

// What the engine lends a job: the listing, one reader request (no
// conversation, no cache, booked with purpose "reader"), the error tracker.
export type ReaderHost = {
  models(): Promise<ModelInfo[]>;
  current(): Promise<ModelInfo>;
  listPrice?(m: ModelInfo): Price | undefined;
  ask(model: ModelInfo, prompt: string, signal: AbortSignal): Promise<ReaderAnswer>;
  capture(e: unknown, context: Record<string, unknown>): void;
  progress?(p: ReadProgress): void;
  env?: Record<string, string | undefined>;
};

export type PartState = { k: number; covers: string; chars: number; model?: string; state: "waiting" | "reading" | "read" | "nothing" | "unread"; error?: string };
export type ReadProgress = { parts: PartState[]; compiling?: boolean };

export type ReadOutcome = {
  text: string;            // the answer (or the readers' findings, when the compile failed)
  models: string[];        // names of the models that read
  parts: PartState[];
  unread: string[];        // what no reader read: parts every choice failed on, material past the cap
  chars: number;           // material read
  usage: Usage;            // every reader call of the job
  cost?: number;           // USD, where priced
  plan?: boolean;          // every reader that read is on a subscription: no per-token cost
  working?: { model: string; tokens: number; cost?: number }; // the working model reading the same material once, uncached (at least)
  compiled: boolean;
  checked?: Checked;       // the answer held against the material
};

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export async function readMaterial(host: ReaderHost, items: Material[], question: string, signal: AbortSignal): Promise<ReadOutcome> {
  const env = host.env ?? process.env;
  const [models, cur] = await Promise.all([host.models(), host.current()]);
  const list = (m: ModelInfo) => host.listPrice?.(m);
  const total = items.reduce((n, m) => n + m.text.length, 0);
  // Choices that hold one full part; the first one sizes the parts.
  const need = Math.ceil(Math.min(total, READ_CHUNK_CHARS) / bytesPerToken(cur.id)) + 10_000;
  const choices = readerChoices(models, cur, need, env, list, smallModels());
  const first = choices[0]!;
  const unread: string[] = [];
  // Past the cap the material is not read: named, so the working model knows.
  const cap = materialCap(cur, first, list);
  let room = cap;
  const kept: Material[] = [];
  for (const m of items) {
    if (room <= 0) { unread.push(`${m.source} (past what one job reads, ${cap} characters)`); continue; }
    if (m.text.length > room) {
      const cut = m.text.lastIndexOf("\n", room);
      const text = m.text.slice(0, cut > 0 ? cut : room);
      kept.push({ ...m, text });
      unread.push(`${m.source} after line ${text.split("\n").length} (past what one job reads, ${cap} characters)`);
      room = 0;
      continue;
    }
    kept.push(m);
    room -= m.text.length;
  }
  const chunks = chunkMaterial(kept, chunkChars(first));
  const parts: PartState[] = chunks.map((c, i) => ({ k: i + 1, covers: c.parts.map(partRef).join(", "), chars: c.chars, state: "waiting" }));
  let usage = emptyUsage();
  // Prompt tokens of the readers' part requests, as the provider counted them:
  // about what the working model would take in to read the same material.
  let partTokens = 0;
  const used = new Set<string>();
  const billed = new Set<string>();
  const tell = (compiling = false) => { try { host.progress?.({ parts: parts.map((p) => ({ ...p })), compiling }); } catch (e) { host.capture(e, { at: "reader progress" }); } };

  // One request, through the choices in order; the failure of each is captured once.
  const ask = async (prompt: string, what: Record<string, unknown>, onModel?: (m: ModelInfo) => void, counted = false): Promise<{ text: string; model: ModelInfo } | { error: string }> => {
    let last = "no reader model";
    for (const m of choices) {
      if (signal.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" });
      onModel?.(m);
      try {
        const r = await host.ask(m, prompt, signal);
        usage = addUsage(usage, r.usage);
        if (counted) partTokens += r.usage.input + r.usage.cache_read + r.usage.cache_write;
        const text = r.text.trim();
        if (r.stop === "refusal" || !text) throw new Error(`the reader (${m.name}) ${r.stop === "refusal" ? "refused" : "gave no answer"}`);
        used.add(m.name);
        billed.add(m.billing);
        return { text, model: m };
      } catch (e) {
        if (signal.aborted) throw e;
        last = `${m.name}: ${short(e)}`;
        host.capture(e, { at: "reader", model: m.id, ...what });
      }
    }
    return { error: last };
  };

  const found: { k: number; covers: string; text: string }[] = [];
  const readOne = async (c: Chunk, i: number) => {
    const p = parts[i]!;
    p.state = "reading";
    tell();
    const r = await ask(partPrompt(c, question, i + 1, chunks.length), { part: `${i + 1}/${chunks.length}` }, (m) => { p.model = m.name; tell(); }, true);
    if ("error" in r) {
      p.state = "unread";
      p.error = r.error;
      unread.push(`${p.covers} (every reader failed; last: ${r.error})`);
    } else if (chunks.length > 1 && r.text.replace(/[.\s]+$/, "").toUpperCase() === NOTHING) {
      p.state = "nothing";
    } else {
      p.state = "read";
      found.push({ k: i + 1, covers: p.covers, text: r.text });
    }
    tell();
  };
  const atOnce = Math.max(1, Number(env.KEEL_READERS_AT_ONCE) || READERS_AT_ONCE);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(atOnce, chunks.length) }, async () => {
    while (next < chunks.length) { const i = next++; await readOne(chunks[i]!, i); }
  }));
  found.sort((a, b) => a.k - b.k);

  let text: string;
  let compiled = false;
  if (found.length === 0) {
    text = parts.some((p) => p.state === "nothing") ? "Nothing in the material bears on the request." : "";
  } else if (found.length === 1) {
    text = found[0]!.text;
  } else {
    tell(true);
    const r = await ask(compilePrompt(question, found, parts.filter((p) => p.state === "nothing").map((p) => p.covers)), { part: "compile" });
    if ("error" in r) text = found.map((f) => `Findings in ${f.covers}:\n${f.text}`).join("\n\n");
    else { text = r.text; compiled = true; }
  }
  tell();
  const rate = readRate(cur, list);
  const chars = kept.reduce((n, m) => n + m.text.length, 0);
  const tokens = partTokens || chars / bytesPerToken(cur.id);
  return {
    text, models: [...used], parts, unread, chars, usage, cost: usage.cost, compiled, ...(text ? { checked: checkAnswer(text, kept) } : {}),
    ...(billed.size === 1 && billed.has("subscription") ? { plan: true } : {}),
    working: { model: cur.name, tokens: Math.round(tokens), cost: rate === undefined || cur.billing !== "per_token" ? undefined : (tokens * rate) / 1e6 },
  };
}

// The line the working model reads under the answer: who read what, what went
// unread, where the material is.
export function coverageNote(o: ReadOutcome, sources: number, saved?: string): string {
  const who = o.models.length ? o.models.join(" and ") : "no reader";
  const n = o.parts.length;
  const all = !o.unread.length && o.parts.every((p) => p.state === "read" || p.state === "nothing");
  const lines = [`[${who} read ${all ? "every line of " : ""}${sources} source${sources === 1 ? "" : "s"} (${o.chars} chars) in ${n} part${n === 1 ? "" : "s"} for this request` +
    `${o.compiled ? `; their findings were compiled into this answer` : ""}${all ? "; nothing was left unread" : ""}. References are path:line in the files as they are on disk: Read one when you need its context.` +
    `${saved ? ` Fetched pages are saved under ${saved}.` : ""}]`];
  const checked = o.checked ? checkedNote(o.checked) : "";
  if (checked) lines.push(checked);
  if (o.unread.length) lines.push(`[Not read, so not covered by this answer:\n- ${o.unread.join("\n- ")}]`);
  return lines.join("\n");
}
