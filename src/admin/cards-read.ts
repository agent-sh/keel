// An observational report, not a gate input. The read thread returns counts
// only: no call inputs, reasons in the owner's words, or session identifiers.
import type { Database } from "bun:sqlite";
import { cardDays, CARD_ZONE, countCards, HOUR_MS, type Card, type CardDay, type CardKind } from "./cards-days.ts";
import type { Restart } from "./life-rows.ts";
import { fromFiles } from "./logs.ts";
import { TURN } from "./marks.ts";
import { rowsIndex } from "./timeline.ts";
import { isMode } from "../safety/policy.ts";
import { trustRepo } from "../safety/trust.ts";

type Daily = CardDay & {
  trust_notices: number;
  legacy_trust_notices: number;
  trust_builds: { build: string | null; notices: number }[];
  active_hours: number;
  calls: number;
  model_calls: number;
  agent_refusals: number;
  agent_model_refusals: number;
  interrupted_owner_turns: number;
  incomplete_owner_turns: number;
};
export type DailyCards = { time_zone: string; days: Daily[]; today: Daily; active_days: number };

const top = "s.parent_id IS NULL AND COALESCE(s.settings ->> '$.helper_cards', 0) = 0";
const local = "s.outside IS NULL";
const modeOf = (v: unknown) => isMode(v) ? v : null;
const has = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

// Use the start's actual build, not the gate's current build or the build
// that wrote a result after continuing a parked card. Older starts can be
// joined to their own startup log line by pid and time. No match is unknown.
function startsOf(db: Database, lo: number, now: number, logDir: string | undefined) {
  const starts = (!has(db, "daemon_starts") ? [] : db.query<{ data: string }, []>("SELECT data FROM daemon_starts ORDER BY up_ms").all())
    .map((r) => JSON.parse(r.data) as Restart);
  const i = Math.max(0, starts.findLastIndex((s) => s.up_ms <= lo));
  const window = starts.slice(i);
  const first = window[0]?.up_ms ?? Infinity;
  const older: Pick<Restart, "up_ms" | "build_id">[] = [];
  if (logDir && (first > lo || window.some((s) => !s.build_id))) {
    // The store keeps only the newest starts; older days can still have
    // launch lines. Read by file-day, because fromFiles caps each read.
    const day = 24 * HOUR_MS;
    const logs: { at: number; pid: number; build: string }[] = [];
    for (let at = Math.floor(lo / day) * day - day; at <= now; at += day) {
      for (const l of fromFiles(logDir, at, Math.min(now, at + day - 1))) {
        const m = !l.session && l.level === "info" && /^\[daemon\] started: Keel ([a-f0-9]{12}), pid (\d+), at /.exec(l.text);
        if (m) logs.push({ at: l.ts, pid: Number(m[2]), build: m[1]! });
      }
    }
    for (const l of logs) if (l.at < first) older.push({ up_ms: l.at, build_id: l.build });
    for (const [n, s] of window.entries()) {
      const next = window[n + 1]?.up_ms ?? Infinity;
      s.build_id ??= logs.find((l) => l.pid === s.pid && s.up_ms <= l.at && l.at < next)?.build;
    }
  }
  return [...older, ...window];
}

type ApprovalRow = { id: string; session_id: string; created: number; seq: number | null; call_id: string; mode: string | null; build: string | null; why: string | null;
  rule: string | null; held: string | null; account: string | null; unparsed: number | null; provenance: number | null };

function kindsOf(a: ApprovalRow, legacyRule: string | null | undefined): CardKind[] {
  const kinds: CardKind[] = ["approval"];
  const why = a.why ?? "";
  if (a.account !== null || a.rule === "writes beyond your accounts" || legacyRule === "writes beyond your accounts" ||
      /not (?:one of|among) your namespaces|cannot tell whether it is one of your accounts|writes with the account the MCP server/.test(why)) kinds.push("account");
  if (a.held === "words" || why.startsWith("This goes to a public place under your name")) kinds.push("private_words");
  if (a.unparsed || a.rule === "could not be parsed" || legacyRule === "could not be parsed" || why.includes("the command could not be parsed, so no rule can cover it")) kinds.push("unparsed");
  if (a.provenance || a.held === "provenance" || why.includes("came from outside content")) kinds.push("provenance");
  return kinds;
}

const key = (kind: string, ...parts: string[]) => JSON.stringify([kind, ...parts]);
const normal = new Set(["end_turn", "stop_sequence", "stop"]);

export function readDailyCards(db: Database, { now, log_dir }: { now: number; log_dir?: string }): DailyCards {
  const days = cardDays(now);
  const lo = days[0]!.from_ms;
  const starts = startsOf(db, lo, now, log_dir);
  const startAt = (at: number) => starts.findLast((s) => s.up_ms <= at);
  const buildAt = (at: number) => startAt(at)?.build_id ?? null;

  // A current snapshot, including when this function is run against a live
  // store for a backfill. All time-bounded event reads use their narrow index
  // or are for a particular session and call.
  return db.transaction(() => {
    const cards: Card[] = [];
    const add = (id: string, at: number, mode: unknown, kinds: readonly CardKind[], build?: string | null) =>
      cards.push({ id, at, mode: modeOf(mode), kinds, build: build ?? buildAt(at) });
    const result = db.query<{ ts: number; mode: string | null; rule: string | null; ruled: number }, [string, number, number, number, string]>(`
      SELECT ts, data ->> '$.ruled.mode' AS mode, data ->> '$.ruled.rule' AS rule,
        json_type(data -> 'shown' -> (?5), '$.ruling') IS NOT NULL AS ruled
      FROM events WHERE session_id = ?1 AND seq >= ?2 AND ts >= ?3 AND ts <= ?4 AND kind = 'tool_result'
        AND data ->> '$.results[0].tool_use_id' = ?5
      ORDER BY seq LIMIT 1`);
    if (has(db, "approvals")) {
      const approvals = db.query<ApprovalRow, [number, number]>(`
        SELECT a.id, a.session_id, a.created, a.data ->> '$.call_id' AS call_id,
          a.data ->> '$.reply.seq' AS seq, a.data ->> '$.opened_mode' AS mode, a.data ->> '$.opened_build' AS build,
          a.data ->> '$.why' AS why, a.data ->> '$.rule' AS rule, a.data ->> '$.facts.held' AS held,
          a.data ->> '$.facts.account' AS account, a.data ->> '$.facts.unparsed' AS unparsed, a.data ->> '$.facts.provenance' AS provenance
        FROM approvals a JOIN sessions s ON s.id = a.session_id
        WHERE a.created BETWEEN ? AND ? AND ${top} AND ${local}
          AND COALESCE(
            (SELECT MIN(COALESCE(q.data ->> '$.helper_first', 0)) FROM alerts q
              WHERE q.kind = 'approval' AND json_extract(q.data, '$.approval_id') = a.id AND q.far_id IS NULL),
            a.data ->> '$.by.client' IS 'helper'
          ) = 0`).all(lo, now);
      for (const a of approvals) {
        const r = !a.mode && a.call_id ? result.get(a.session_id, a.seq ?? 0, a.created, now, a.call_id) : null;
        const start = startAt(a.created);
        // Do not use today's perm_sessions row or a result from a later daemon.
        const legacy = r && start && startAt(r.ts) === start ? r : null;
        add(key("approval", a.id), a.created, a.mode ?? legacy?.mode, kindsOf(a, legacy?.rule), a.build);
      }
    }

    const alertsSeen = new Set<string>();
    if (has(db, "activity")) {
      for (const q of db.query<{ id: string; alert: string; sid: string; ts: number; mode: string | null; build: string | null }, [number, number]>(`
        SELECT a.data ->> '$.card' AS id, a.data ->> '$.alert_id' AS alert, s.id AS sid, a.ts,
          a.data ->> '$.card_mode' AS mode, a.data ->> '$.card_build' AS build
        FROM activity a JOIN sessions s ON s.id = a.session_id
        WHERE a.ts BETWEEN ? AND ? AND a.kind = 'alert' AND a.sub = 'question' AND a.data ->> '$.card' IS NOT NULL
          AND a.data ->> '$.child_session' IS NULL AND ${top} AND ${local}`).all(lo, now)) {
        alertsSeen.add(q.alert);
        add(key("question", q.sid, q.id), q.ts, q.mode, ["question"], q.build);
      }
    }
    if (has(db, "alerts")) {
      for (const q of db.query<{ alert: string; sid: string; ts: number; asked: string | null; call: string | null }, [number, number]>(`
        SELECT a.id AS alert, s.id AS sid, a.ts, a.data ->> '$.call_id' AS call,
          COALESCE(a.data ->> '$.ask_id', a.data ->> '$.plan_id', a.data ->> '$.secret_id') AS asked
        FROM alerts a JOIN sessions s ON s.id = a.session_id
        WHERE a.ts BETWEEN ? AND ? AND a.kind = 'question' AND a.far_id IS NULL
          AND a.data ->> '$.expired' IS NULL AND a.data ->> '$.child_session' IS NULL AND ${top} AND ${local}`).all(lo, now)) {
        if (alertsSeen.has(q.alert) || (!q.asked && q.call && result.get(q.sid, 0, q.ts, now, q.call)?.ruled)) continue;
        add(key("question", q.sid, q.asked ?? q.call ?? q.alert), q.ts, null, ["question"]);
      }
    }

    const tally = countCards(days, cards).map((d) => ({
      ...d, hours: new Set<number>(), calls: 0, model_calls: 0, agent_refusals: 0, agent_model_refusals: 0,
      interrupted_owner_turns: 0, incomplete_owner_turns: 0, legacy_trust_notices: 0,
      trust: new Set<string>(), trust_builds: new Map<string | null, number>(),
    }));
    const at = (ts: number) => tally.find((d) => d.from_ms <= ts && ts < d.until_ms);

    // Notices don't wait on an answer. Count the first notice of each held
    // set per repository and day, even when many sessions showed it. Old
    // notes have no digests: use the visible list and the last known folder.
    const repos = new Map<string, string>();
    const notes = rowsIndex([]);
    for (const t of db.query<{ ts: number; workspace: string; repo: string | null; held: string | null; build: string | null; text: string }, [number, number]>(`
      SELECT e.ts, s.workspace, e.data ->> '$.held.repo' AS repo,
        e.data ->> '$.held.set' AS held, e.data ->> '$.card_build' AS build, e.data ->> '$.text' AS text
      FROM sessions s CROSS JOIN events e ON e.session_id = s.id
      WHERE ${top} AND ${local} AND ${notes.kept} AND e.ts BETWEEN ? AND ?
        AND e.kind = 'note' AND e.data ->> '$.kind' = 'trust'
        AND (e.data ->> '$.held.set' IS NOT NULL OR e.data ->> '$.card' = 1
          OR e.data ->> '$.text' LIKE '%held until you trust%Open the Trust panel%')
      ORDER BY e.ts, e.id`).all(lo, now)) {
      const d = at(t.ts);
      if (!d) continue;
      const legacy = t.repo === null || t.held === null;
      if (legacy && !repos.has(t.workspace)) repos.set(t.workspace, trustRepo(t.workspace));
      const tag = legacy ? key("legacy", repos.get(t.workspace)!, t.text) : key("held", t.repo!, t.held!);
      if (d.trust.has(tag)) continue;
      d.trust.add(tag);
      if (legacy) d.legacy_trust_notices++;
      const build = t.build ?? buildAt(t.ts);
      d.trust_builds.set(build, (d.trust_builds.get(build) ?? 0) + 1);
    }

    // Active hours are elapsed clock hours with a logged model or tool call
    // in a top session, not duration summed across concurrent sessions.
    for (const [table, field] of [["telemetry_calls", "model_calls"], ["telemetry_tools", "calls"]] as const) {
      if (!has(db, table)) continue;
      for (const { ts } of db.query<{ ts: number }, [number, number]>(`
        SELECT t.ts FROM ${table} t JOIN sessions s ON s.id = t.session_id
        WHERE t.ts BETWEEN ? AND ? AND ${top} AND ${local}${field === "model_calls" ? " AND t.purpose = 'turn'" : ""}`).iterate(lo, now)) {
        const d = at(ts);
        if (!d) continue;
        d[field]++;
        d.hours.add(Math.floor((ts - d.from_ms) / HOUR_MS));
      }
    }
    for (const t of db.query<{ ts: number; agent: number; reason: string; denied: number }, [number, number]>(`
      SELECT e.ts, s.parent_id IS NOT NULL AS agent, e.data ->> '$.reason' AS reason,
        COALESCE(e.data ->> '$.tool_denied', 0) AS denied
      FROM sessions s CROSS JOIN events e ON e.session_id = s.id
      WHERE ${local} AND (s.parent_id IS NOT NULL OR (${top})) AND ${TURN}
        AND e.kind = 'turn_end' AND e.ts BETWEEN ? AND ?`).all(lo, now)) {
      const d = at(t.ts);
      if (!d) continue;
      if (t.agent) {
        d.agent_refusals += t.denied;
        if (t.reason === "refusal") d.agent_model_refusals++;
      } else {
        if (t.reason === "interrupted") d.interrupted_owner_turns++;
        if (t.reason && !normal.has(t.reason)) d.incomplete_owner_turns++;
      }
    }
    const complete = tally.map(({ hours, trust, trust_builds, ...d }) => ({
      ...d, active_hours: hours.size, trust_notices: trust.size,
      trust_builds: [...trust_builds].map(([build, notices]) => ({ build, notices })),
    }));
    const today = complete.pop()!;
    return { time_zone: CARD_ZONE, days: complete, today, active_days: complete.filter((d) => d.active_hours > 0).length };
  })();
}
