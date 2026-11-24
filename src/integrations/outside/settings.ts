// The owner's settings for sessions other harnesses run (Settings > Outside sessions).
//
// enabled: watch the other harnesses' folders at all.
// exclude: folders whose sessions are never shown (a session whose folder is one of them or under one).
// days: only folders that held a session in the last `days` days are watched. 30, the age at which
//   Claude Code deletes a transcript by default (its cleanupPeriodDays): an older folder holds
//   nothing it would keep. A session that starts or resumes in an older folder is still found,
//   by the harness's prompt history (history.jsonl) or its record of a running session.
// stale_minutes: a session that works or waits with no record that long, and no running process
//   to vouch for it, shows as stale and leaves the working and waiting counts. 10, Claude Code's
//   longest command (the Bash tool's limit of 600000 ms): a turn that is alive writes a record at
//   least that often.
import { registerSettings, settings } from "../../admin/settings.ts";
import { isAbsolute } from "node:path";

export type OutsideSettings = { enabled: boolean; exclude: string[]; days: number; stale_minutes: number };

export const OUTSIDE_DEFAULTS: OutsideSettings = { enabled: true, exclude: [], days: 30, stale_minutes: 10 };

export function checkOutside(v: any): string | undefined {
  if (typeof v.enabled !== "boolean") return "enabled is true or false";
  if (!Array.isArray(v.exclude) || v.exclude.some((p: unknown) => typeof p !== "string" || !isAbsolute(p))) return "exclude is a list of absolute folder paths";
  if (!Number.isInteger(v.days) || v.days < 1) return "days is a whole number of days, 1 or more";
  if (typeof v.stale_minutes !== "number" || !(v.stale_minutes > 0)) return "stale_minutes is a number of minutes above 0";
  return undefined;
}

registerSettings("outside", OUTSIDE_DEFAULTS as unknown as Record<string, unknown>, checkOutside);

export const outsideSettings = (): OutsideSettings => settings().outside as OutsideSettings;

// Whether a session's folder is one the owner excluded.
export const excluded = (cwd: string | undefined, exclude: string[]) =>
  !!cwd && exclude.some((d) => { const x = d.replace(/\/+$/, ""); return cwd === x || cwd.startsWith(`${x}/`); });
