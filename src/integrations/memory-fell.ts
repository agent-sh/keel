// A fall of the memory store's recall, told to the owner once. The meter's signal (memory-meter.ts recallFell)
// shows on the Memory page only; a fall that nobody opens the page to see lasted a day before it was noticed.
// One alert (the regression kind) a fall, one unread row a path (a fall raised again replaces it), read when recall recovers: a path that fell is marked open in the store's meta table, and the
// mark clears only when the path's recall was measured back above half of its day's, so a share that wavers
// around the line is one fall, not one alert an hour.
import { recovered, type Fell, type MemoryPath, type Standing } from "./memory-meter.ts";

const WORDS: Record<string, string> = {
  store_start: "at session start", store_prompt: "with prompts", store_brief: "with agents' tasks", store_tool: "with tool calls", store_owed: "carried to a later step", helper: "in the helper's records", native_read: "read by a tool call",
};
const pct = (w: { answered: number; hits: number }) => `${Math.round((100 * w.hits) / w.answered)}%`;

export function fellText(f: Fell): { title: string; body: string } {
  const where = WORDS[f.path] ?? f.path;
  return {
    title: `Memory recall fell ${where}`,
    body: `Facts came with ${f.recent.hits} of the last ${f.recent.answered} answers ${where} in two hours (${pct(f.recent)}), against ${f.day.hits} of ${f.day.answered} in the day before (${pct(f.day)}). The Memory tab of Usage shows the counts. Either the store answers differently or what Keel sends it changed.`,
  };
}

export type FellDeps = {
  standing(): Promise<Standing[]>;
  // The marks of falls told and not yet over, by path.
  open(): Set<string>;
  mark(path: MemoryPath, on: boolean): void;
  raise(f: Fell, text: { title: string; body: string }): void;
  // Recall is back: what the fall told and nobody read is read.
  settle(path: MemoryPath): void;
};

// One look: each path that fell and is not marked is told and marked; each marked path that recovered is unmarked.
export async function watchFell(d: FellDeps): Promise<MemoryPath[]> {
  const open = d.open(), told: MemoryPath[] = [];
  for (const w of await d.standing()) {
    if (w.fell && !open.has(w.path)) { d.mark(w.path, true); d.raise(w.fell, fellText(w.fell)); told.push(w.path); }
    else if (!w.fell && open.has(w.path) && recovered(w)) { d.mark(w.path, false); d.settle(w.path); }
  }
  return told;
}
