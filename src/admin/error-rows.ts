// The error list as text (keel debug errors), and the words both the text and
// the page use for a kind's state. One line a kind; under a kind that happened
// in sessions, one line a session with its own count, its latest time and the
// command that opens that session's own failure. No imports besides the
// clock, so the page can load this file.
import { zoned } from "../core/clock.ts";
import type { ErrorRecord, ErrorSite } from "../core/types.ts";

// The states of a kind, in one place (the state-words vocabulary replaces these when it lands).
export const ERROR_STATE = { open: "Open", recovered: "Recovered", resolved: "Resolved" } as const;
export type ErrorState = keyof typeof ERROR_STATE;
export const errorState = (e: Pick<ErrorRecord, "resolved_ts" | "recovered_ts">): ErrorState => (e.resolved_ts ? "resolved" : e.recovered_ts ? "recovered" : "open");

// "healed by a retry", "2 of 5 healed by a retry", "" when none was.
export const healedWords = (s: Pick<ErrorSite, "count" | "healed">) => (s.healed <= 0 ? "" : s.healed >= s.count ? "healed by a retry" : `${s.healed} of ${s.count} healed by a retry`);

// How many occurrences of a kind no session holds (a daemon failure, a session since removed, one from before sessions were recorded).
export const elsewhere = (e: Pick<ErrorRecord, "count" | "sites">) => Math.max(0, (e.count ?? 1) - (e.sites ?? []).reduce((n, s) => n + s.count, 0));

const SITES = 6;
export function errorLines(errors: ErrorRecord[], o: { all?: boolean; now?: number } = {}): string[] {
  const open = errors.filter((e) => errorState(e) === "open");
  const recovered = errors.filter((e) => errorState(e) === "recovered");
  const resolved = errors.filter((e) => errorState(e) === "resolved");
  const z = zoned(o.now);
  const head = `${open.length} open${recovered.length ? `, ${recovered.length} recovered (a retry passed)` : ""}${o.all && resolved.length ? `, ${resolved.length} resolved` : ""}. ${z.note}.`;
  const out = [head];
  for (const e of [...open, ...recovered, ...(o.all ? resolved : [])]) {
    const state = errorState(e);
    out.push(`${e.id}  ${z.stamp(e.ts)}  ${e.source.padEnd(8)} ${String(e.count ?? 1).padStart(4)}x  ${state === "open" ? "" : `[${ERROR_STATE[state].toLowerCase()}] `}${e.message.split("\n")[0]!.slice(0, 140)}`);
    const sites = e.sites ?? [];
    for (const s of sites.slice(0, SITES)) {
      const healed = healedWords(s);
      out.push(`    ${String(s.count).padStart(4)}x  ${(s.title || s.session_id).slice(0, 48)}, last ${z.stamp(s.ts)}${healed ? `, ${healed}` : ""}  (keel debug ${e.id.slice(-12)} --session ${s.session_id.slice(-12)})`);
    }
    if (sites.length > SITES) out.push(`          and ${sites.length - SITES} more sessions`);
    const rest = elsewhere(e);
    if (sites.length && rest) out.push(`    ${String(rest).padStart(4)}x  with no session recorded`);
  }
  return out;
}
