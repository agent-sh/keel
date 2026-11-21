// One reading job: the material split into parts that fit the reader, the
// parts read side by side (at most READERS_AT_ONCE at a time), each reader's
// findings with exact quotes and path:line references, and a compile step that
// merges them into one answer for the working model. A reader that fails or
// refuses hands its part to the next choice; a part no reader could read is
// named in the answer, never left out silently. No request is sent to a model
// whose listed window does not hold it: findings too many for one compile
// request are merged in groups first, and findings no reader could compile
// come back as a preview within what a tool result holds.
import { addUsage, emptyUsage, type Usage } from "../core/types.ts";
import type { ModelInfo, Price } from "../providers/types.ts";
import { bytesPerToken } from "./compact.ts";
import { registerSettings, settings } from "../admin/settings.ts";
import { OUTPUT_CAP } from "../tools/spill.ts";
import {
  checkAnswer, checkedNote, chunkChars, chunkMaterial, compilePrompt, type Checked, type Finding, findingsPreview, fitsOne, groupFindings, holds,
  materialCap, NOTHING, partPrompt, partRef, READ_CHUNK_CHARS, readersAtOnce, readerChoices, readRate, type Chunk, type Material,
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
  text: string;            // the answer (or a preview of the readers' findings, when the compile failed)
  models: string[];        // names of the models that read
  parts: PartState[];
  unread: string[];        // what no reader read: parts every choice failed on, material past the cap
  chars: number;           // material a reader read: the parts read, those that held nothing included
  usage: Usage;            // every reader call of the job
  cost?: number;           // USD, where priced
  plan?: boolean;          // every reader that read is on a subscription: no per-token cost
  working?: { model: string; tokens: number; cost?: number }; // the working model reading the same material once, uncached (at least)
  compiled: boolean;
  // Set when several parts had findings and no reader could compile them:
  // every part's findings in part order (for a file), why, and how many parts
  // the preview in `text` shows whole, shows the start of, and leaves out.
  uncompiled?: { findings: string; error: string; whole: number; cut: number; left: number };
  checked?: Checked;       // the answer held against the material
};

const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

// Tokens a reader holds to be a choice for `chars` of material: one full part
// and the room around it.
const needFor = (chars: number, cur: ModelInfo) => Math.ceil(Math.min(chars, READ_CHUNK_CHARS) / bytesPerToken(cur.id)) + 10_000;

// The most characters one job of this host reads, known before any material
// is: the cap of the reader that reads material longer than one part, the
// same one the job then picks. The readers tool gathers no more than this.
// (Material under one part may go to a smaller reader with a cap of its own,
// which the job applies and names.)
export async function readBudget(host: Pick<ReaderHost, "models" | "current" | "listPrice" | "env">): Promise<number> {
  const [models, cur] = await Promise.all([host.models(), host.current()]);
  const list = (m: ModelInfo) => host.listPrice?.(m);
  return materialCap(cur, readerChoices(models, cur, needFor(READ_CHUNK_CHARS, cur), host.env ?? process.env, list, smallModels())[0]!, list);
}

export async function readMaterial(host: ReaderHost, items: Material[], question: string, signal: AbortSignal): Promise<ReadOutcome> {
  const env = host.env ?? process.env;
  const [models, cur] = await Promise.all([host.models(), host.current()]);
  const list = (m: ModelInfo) => host.listPrice?.(m);
  const total = items.reduce((n, m) => n + m.text.length, 0);
  // Choices that hold one full part; the first one sizes the parts.
  const choices = readerChoices(models, cur, needFor(total, cur), env, list, smallModels());
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
  // What one request holds besides the question: a part, or a group of findings.
  const perRequest = chunkChars(first, question.length);
  const chunks = chunkMaterial(kept, perRequest);
  const parts: PartState[] = chunks.map((c, i) => ({ k: i + 1, covers: c.parts.map(partRef).join(", "), chars: c.chars, state: "waiting" }));
  let usage = emptyUsage();
  // Prompt tokens of the request that read each part, as the provider counted
  // them: about what the working model would take in to read the same material
  // once. An attempt that failed or refused is the readers' own cost (`usage`),
  // not something the working model would pay.
  let partTokens = 0;
  const used = new Set<string>();
  const billed = new Set<string>();
  const tell = (compiling = false) => { try { host.progress?.({ parts: parts.map((p) => ({ ...p })), compiling }); } catch (e) { host.capture(e, { at: "reader progress" }); } };

  // One request, through the choices in order; the failure of each is captured once.
  const ask = async (prompt: string, what: Record<string, unknown>, onModel?: (m: ModelInfo) => void): Promise<{ text: string; model: ModelInfo; input: number } | { error: string }> => {
    let last = "no reader model";
    let sent = false;
    for (const m of choices) {
      if (signal.aborted) throw Object.assign(new Error("interrupted"), { name: "AbortError" });
      if (!holds(m, prompt)) { last = `${m.name}: the request is over its window (${m.context} tokens)`; continue; }
      sent = true;
      onModel?.(m);
      try {
        const r = await host.ask(m, prompt, signal);
        usage = addUsage(usage, r.usage);
        const text = r.text.trim();
        if (r.stop === "refusal" || !text) throw new Error(`the reader (${m.name}) ${r.stop === "refusal" ? "refused" : "gave no answer"}`);
        used.add(m.name);
        billed.add(m.billing);
        return { text, model: m, input: r.usage.input + r.usage.cache_read + r.usage.cache_write };
      } catch (e) {
        if (signal.aborted) throw e;
        last = `${m.name}: ${short(e)}`;
        host.capture(e, { at: "reader", model: m.id, ...what });
      }
    }
    // No choice was asked: nothing above captured it.
    if (!sent) host.capture(new Error(last), { at: "reader", ...what });
    return { error: last };
  };

  const found: { k: number; covers: string; text: string }[] = [];
  const readOne = async (c: Chunk, i: number) => {
    const p = parts[i]!;
    p.state = "reading";
    tell();
    const r = await ask(partPrompt(c, question, i + 1, chunks.length), { part: `${i + 1}/${chunks.length}` }, (m) => { p.model = m.name; tell(); });
    if (!("error" in r)) partTokens += r.input;
    if ("error" in r) {
      p.state = "unread";
      p.error = r.error;
    } else if (chunks.length > 1 && r.text.replace(/[.\s]+$/, "").toUpperCase() === NOTHING) {
      p.state = "nothing";
    } else {
      p.state = "read";
      found.push({ k: i + 1, covers: p.covers, text: r.text });
    }
    tell();
  };
  const atOnce = readersAtOnce(env);
  // `n` runs side by side, at most `atOnce` at a time.
  const sideBySide = async (n: number, run: (i: number) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(atOnce, n) }, async () => { while (next < n) await run(next++); }));
  };
  await sideBySide(chunks.length, (i) => readOne(chunks[i]!, i));
  found.sort((a, b) => a.k - b.k);
  // In part order, whichever failed first, and before the material past the cap, which follows every part.
  unread.unshift(...parts.filter((p) => p.state === "unread").map((p) => `${p.covers} (every reader failed; last: ${p.error})`));

  // The findings compiled into one answer.
  const compile = async (): Promise<{ text: string } | { error: string }> => {
    const none = parts.filter((p) => p.state === "nothing").map((p) => p.covers);
    // The request that writes the answer. The parts that held nothing are
    // named while the request holds the names, else counted.
    const answer = (items: Finding[]) => {
      const named = compilePrompt(question, items, none);
      return fitsOne(first, named) ? named : compilePrompt(question, items, [`${none.length} other parts`]);
    };
    // One request while the reader's window holds every finding, below its first price tier.
    let error: string | undefined;
    const one = answer(found);
    if (fitsOne(first, one)) {
      const r = await ask(one, { part: "compile" });
      if (!("error" in r)) return r;
      error = r.error;
    }
    // It does not, or that request failed: neighbours are merged group by
    // group, stage by stage, until one request holds what is left. Every stage
    // has fewer findings than the one before.
    let items: Finding[] = found;
    for (let stage = 1; ; stage++) {
      const groups = groupFindings(items, perRequest);
      if (groups.length === 1 && stage > 1) return ask(answer(items), { part: "compile" });
      if (groups.length === 1 || groups.length === items.length) return { error: error ?? `the findings are too long to merge in one request to ${first.name}` };
      const merged: Finding[] = new Array(groups.length);
      let failed: string | undefined;
      await sideBySide(groups.length, async (i) => {
        // One group failed: the rest are not sent.
        if (failed) return;
        const g = groups[i]!;
        if (g.length === 1) { merged[i] = g[0]!; return; }
        const r = await ask(compilePrompt(question, g, [], { k: i + 1, n: groups.length }), { part: `compile stage ${stage}, group ${i + 1}/${groups.length}` });
        if ("error" in r) failed ??= r.error;
        else merged[i] = { covers: `group ${i + 1} of ${groups.length}, merged`, text: r.text };
      });
      if (failed) return { error: failed };
      items = merged;
    }
  };

  let text: string;
  let compiled = false;
  let uncompiled: ReadOutcome["uncompiled"];
  if (found.length === 0) {
    text = parts.some((p) => p.state === "nothing") ? "Nothing in the material bears on the request." : "";
  } else if (found.length === 1) {
    text = found[0]!.text;
  } else {
    tell(true);
    const r = await compile();
    if ("error" in r) {
      const preview = findingsPreview(found, OUTPUT_CAP);
      text = preview.text;
      uncompiled = { findings: found.map((f) => `Findings of part ${f.k} (${f.covers}):\n${f.text}`).join("\n\n"), error: r.error, whole: preview.whole, cut: preview.cut, left: preview.left };
    } else { text = r.text; compiled = true; }
  }
  tell();
  // The answer is held against what a reader read, not against a part every reader failed on.
  const readSpans = chunks.flatMap((c, i) => (parts[i]!.state === "read" || parts[i]!.state === "nothing" ? c.parts.map((p) => ({ source: p.source, from: p.from, to: p.to })) : []));
  const rate = readRate(cur, list);
  const chars = chunks.reduce((n, c, i) => n + (parts[i]!.state === "read" || parts[i]!.state === "nothing" ? c.parts.reduce((k, p) => k + p.chars, 0) : 0), 0);
  const tokens = partTokens || chars / bytesPerToken(cur.id);
  return {
    text, models: [...used], parts, unread, chars, usage, cost: usage.cost, compiled, ...(uncompiled ? { uncompiled } : {}), ...(text ? { checked: checkAnswer(text, kept, readSpans) } : {}),
    ...(billed.size === 1 && billed.has("subscription") ? { plan: true } : {}),
    working: { model: cur.name, tokens: Math.round(tokens), cost: rate === undefined || cur.billing !== "per_token" ? undefined : (tokens * rate) / 1e6 },
  };
}

// One source read for a request (a fetched page): the readers' answer, or,
// when no reader could compile the findings of its parts, every part's
// findings as they are (`compiled` false), for the caller to spill. An answer
// from the parts that were read is kept when another part went unread:
// `unread` names what it does not cover. Throws only when there is no answer
// (no reader read any of it; each failure is captured once).
export async function readSource(host: ReaderHost, source: string, text: string, prompt: string, signal: AbortSignal): Promise<{ text: string; model: string; usage: Usage; compiled: boolean; unread: string[] }> {
  const o = await readMaterial(host, [{ source, text }], prompt, signal);
  // Parts that held nothing say nothing about the parts no reader read.
  const answered = o.parts.some((p) => p.state === "read");
  if (!o.text || (o.unread.length && !answered)) throw new Error(`no reader read ${source}: ${o.unread.join("; ") || "no answer"}`);
  return { text: o.uncompiled?.findings ?? o.text, model: o.models.join(" and "), usage: o.usage, compiled: !o.uncompiled, unread: o.unread };
}

// The line the working model reads under the answer: who read what, what went
// unread, where the material is; and, when the findings were not compiled,
// what of them the text above shows and where all of them are (`findings`).
export function coverageNote(o: ReadOutcome, sources: number, saved?: string, findings?: string): string {
  const who = o.models.length ? o.models.join(" and ") : "no reader";
  const n = o.parts.length;
  const all = !o.unread.length && o.parts.every((p) => p.state === "read" || p.state === "nothing");
  const lines = [`[${who} read ${all ? "every line of " : ""}${sources} source${sources === 1 ? "" : "s"} (${o.chars} chars) in ${n} part${n === 1 ? "" : "s"} for this request` +
    `${o.compiled ? `; their findings were compiled into this answer` : ""}${all ? "; nothing was left unread" : ""}. References are path:line in the files as they are on disk: Read one when you need its context.` +
    `${saved ? ` Fetched pages are saved under ${saved}.` : ""}]`];
  if (o.uncompiled) {
    const u = o.uncompiled;
    const shown = [u.whole ? `the findings of ${u.whole} part${u.whole === 1 ? "" : "s"} whole` : "",
      u.cut ? `the start of the findings of ${u.cut} ${u.whole ? "more" : `part${u.cut === 1 ? "" : "s"}`}` : ""].filter(Boolean).join(" and ");
    lines.push(`[The readers' findings could not be compiled into one answer (${u.error}). The text above is a preview, not an answer: ${shown}, in part order` +
      `${u.left ? `; the findings of the last ${u.left} part${u.left === 1 ? " are" : "s are"} not in it` : ""}.` +
      `${findings ? ` Every part's findings are saved whole, in part order, to ${findings}: Read or search it before relying on what the preview leaves out.` : ""}]`);
  }
  const checked = o.checked ? checkedNote(o.checked, o.uncompiled ? "preview" : "answer") : "";
  if (checked) lines.push(checked);
  if (o.unread.length) lines.push(`[Not read, so not covered by this answer:\n- ${o.unread.join("\n- ")}]`);
  return lines.join("\n");
}
