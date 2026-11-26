// Compaction by price for a session the owner talks to (session setting `owner_compact_by_price`, which he
// turns on from the session's menu). The price is the agents' (src/engine/price-compact.ts): a summary is
// written when the steps ahead would read more of the context above what it keeps than the summary and the
// rewrite cost. Two things differ for the owner's own session, and they are decided here. Pure: the engine
// (src/engine/turn.ts, Engine.priced and its step loop) reads the facts and carries out what this says.
//
// When: the summary is written in the background while the work goes on, as an agent's is, but it takes the
// history's place only at a moment the owner is not in the middle of: the first step of a turn (the session was
// idle until this turn's input came), or a step whose cache has lapsed anyway (the request writes the whole
// context either way). A step inside a running turn on a warm cache never swaps: the turn the owner watches
// goes on with the context it started with.
//
// What it must keep: the owner reads this session's answers, so a summary that changed what was said does not
// replace the history by price. It goes in only when the meaning check holds: every standing statement quoted
// word for word (settle() in src/engine/compact.ts drops a retold one, and that one is then a refusal here), the
// owner's own messages all kept verbatim (none left out or cut for the budget), and the probe of what it kept
// (src/engine/trail.ts probeOf) no lower than MEANING_KEPT of the files written and the recurring identifiers, with
// no identifier that nothing it read holds. The system prompt and the statements are never compacted (the
// checkpoint carries them). A refused summary is told in the session's timeline once; the window's line still
// compacts as it always did.
import { share, type Probe } from "./trail.ts";

// The least share of the span's written files and of its recurring identifiers a summary by price keeps (with the
// trail). It is a floor, not a measured bar: it sits just under the least any model summary on a working store
// kept, so it refuses only a summary that kept less than every one seen, and no real summary would have been
// refused by it. Of 17 such compactions with a probe, the lowest kept 31% of the recurring identifiers and 62% of
// the files written; a long session's summaries keep about a third of its identifiers, a short one's all of them.
// The statements and his words are what the check holds to whole; this only catches a summary that lost the work.
export const MEANING_KEPT = 0.3;

// Whether the summary may take the history's place at this step.
export const swapAt = (m: { firstStep: boolean; cold: boolean }): boolean => m.firstStep || m.cold;

// Whether the input that opened this run is the harness's continuation of a turn a restart cut: its first step
// is a step inside that turn, on a cache the cut turn left warm, not a turn's first. (A message queued while the
// daemon was down follows the continuation into the same run.)
export function openedByRestart(line: readonly { kind: string; data: any }[]): boolean {
  let start = line.length - 1;
  while (start >= 0 && line[start]!.kind !== "turn_start") start--;
  for (let i = start - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind === "note") continue;
    if (e.kind !== "user") return false;
    if (e.data?.origin === "restart") return true;
  }
  return false;
}

// What a prepared summary's data says of what it kept (checkpointData's fields).
export type KeptFacts = {
  statements_dropped?: string[];
  owner_messages_shortened?: number;
  owner_messages_left?: number;
  owner_media_left?: number;
  probe?: Partial<Probe>;
};

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

// Why the summary does not keep the meaning of what it replaces, in words; undefined when it does.
export function meaningHeld(d: KeptFacts): string | undefined {
  const why: string[] = [];
  const dropped = d.statements_dropped?.length ?? 0;
  if (dropped) why.push(`it did not quote ${n(dropped, "statement")} word for word`);
  if (d.owner_messages_left) why.push(`it would leave out ${d.owner_messages_left === 1 ? "one" : d.owner_messages_left} of the owner's messages`);
  if (d.owner_messages_shortened) why.push(`it would cut ${d.owner_messages_shortened === 1 ? "one" : d.owner_messages_shortened} of the owner's messages to ${d.owner_messages_shortened === 1 ? "its" : "their"} start and end`);
  if (d.owner_media_left) why.push(`it would leave out ${d.owner_media_left === 1 ? "an image or file" : `${d.owner_media_left} images and files`} the owner sent`);
  const p = d.probe;
  if (p && typeof p.files === "number") {
    const files = share(p.files_kept ?? 0, p.files);
    const anchors = share(p.anchors_kept ?? 0, p.anchors ?? 0);
    if (files !== null && files < MEANING_KEPT) why.push(`it kept ${p.files_kept ?? 0} of ${n(p.files, "file")} written`);
    if (anchors !== null && anchors < MEANING_KEPT) why.push(`it kept ${p.anchors_kept ?? 0} of ${n(p.anchors ?? 0, "recurring identifier")}`);
    if (p.unsupported) why.push(`it names ${n(p.unsupported, "identifier")} found in nothing it read`);
  }
  return why.length ? why.join("; ") : undefined;
}
