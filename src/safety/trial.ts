// A safety rule tried on the stored calls before it is on (Settings > Safety, `keel safety trial`). A candidate
// rule set is the current one with a change: a settings diff (the owner's namespaces, standing grants, a mode),
// replayed by the daemon on its read thread, or a developer's patch of the rule modules' source, replayed by
// `keel safety trial --patch` in its own process. Both replay the tool calls of the last days with no model
// call (trial-read.ts), through the rules' own pure functions (trial-rules.ts). The report
// says, per tool and per class, how many calls the candidate would allow, ask about or refuse that the current
// rules treated otherwise, by id with a link (never a call's text), and how many of those had run and succeeded.
// It also holds the current rules' replay against what was stored when each call was decided: the agreement, and
// each disagreement's cause.
//
// This file is pure: plain data in, plain data out.
import type { Decision, Mode, Rule, RuleKind } from "./policy.ts";

export type Outcome = "allow" | "ask" | "refuse";
export const OUTCOMES: readonly Outcome[] = ["allow", "ask", "refuse"];

// What the rules decided of a call when it was made, kept with its result (gate.ts sets it on the call, the turn
// stores it with the result). `d`: the rules' own decision (policy.ts decide), before the judge, a card or the
// owner; absent when a check before the rules refused the call (`before`). `looked`: the disk's answers the
// decision read (looked.ts), `real`: which program names were the programs themselves (shims.ts), `named`:
// folders a parent or the owner named as the session's own. `rev`: the build that decided.
export type Ruled = {
  mode: Mode; d?: Outcome; risk?: "low" | "high"; rule?: string; owner?: true; before?: string;
  looked?: [string, unknown][]; real?: Record<string, boolean>; named?: string[]; rev?: string;
};

// A decision as an outcome and the class it was made for: an ask's rule (or its risk), a refusal's kind.
export type Judged = { outcome: Outcome; cls: string };
export function judgedOf(d: Decision): Judged {
  if ("allow" in d) return { outcome: "allow", cls: "allowed" };
  if ("deny" in d) return { outcome: "refuse", cls: refusalClass(d.deny) };
  return { outcome: "ask", cls: d.ask.rule ?? (d.ask.risk === "high" ? "high risk" : "not covered by a grant") };
}

// What the gate keeps of its decision on a call.
export function ruledOf(mode: Mode, d: Decision, more: Omit<Ruled, "mode" | "d" | "risk" | "rule" | "owner" | "before"> = {}): Ruled {
  const j = judgedOf(d);
  const ask = "ask" in d ? d.ask : undefined;
  return { mode, d: j.outcome, ...(ask ? { risk: ask.risk, rule: j.cls, ...(ask.ownerOnly ? { owner: true as const } : {}) } : "deny" in d ? { rule: j.cls } : {}), ...strip(more) };
}
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length))) as T;

// A refusal of the rules by its kind, from its words (the policy's refusals carry no name of their own). The
// report names the kind, never the words: they hold the call's paths.
const REFUSALS: [RegExp, string][] = [
  [/in plan mode/, "plan mode"],
  [/read-only/, "read-only session"],
  [/one of Keel's own files|corrupting the store of the daemon/, "Keel's own files"],
  [/credentials/, "credentials"],
  [/shares the repository's branches/, "shared branches"],
  [/namespaces/, "writes beyond your accounts"],
  [/never runs without the owner/, "never allowed"],
  [/sandbox/, "sandbox"],
  [/drive other sessions/, "other sessions"],
];
export function refusalClass(text: string): string {
  for (const [re, name] of REFUSALS) if (re.test(text)) return name;
  return "refused by the rules";
}

// A refusal made before the rules were read (or beside them), by its words: the replay runs the rules alone, so
// such a call is counted apart, by kind, and is neither an agreement nor a disagreement.
// (A judge's or a reviewer's refusal and the owner's answer on a card are known by their own rows, not by words.)
const BEFORE: [RegExp, string][] = [
  [/^A hook blocked this call/, "a hook"],
  [/^Refused: this session has no network/, "network off"],
  [/^Refused: this session's folder is not the folder the session was made in/, "folder moved"],
  [/^Refused: this session reviews another person's code/, "review tools only"],
  [/^Refused: authorization or the action changed/, "changed while pending"],
  [/^Refused: Auto cannot|^Refused: the complete action does not fit in (?:Auto|the judge's) review/, "review limits"],
  [/^The reviewer refused this call/, "the reviewer"],
  [/^Refused: it sends to a target that came from outside content/, "outside content"],
  [/^This agent works in its own worktree/, "agent write scope"],
  [/^\[secret:[0-9a-f]+\] stands inside/, "secret placeholders"],
  [/^The owner denied this call|^The turn was stopped before the owner answered/, "the owner"],
];
export function beforeClass(text: string): string | null {
  for (const [re, name] of BEFORE) if (re.test(text)) return name;
  return null;
}

// What is stored of a call: its result (`verdict` of an error result: failed, denied, none; `ok`: it ran and
// did not fail), whether a card opened for it, whether a review settled it without the owner (an activity row,
// a refused call's row), the start of a refusal's words (read here for its kind only), and the rules' own record.
export type Stored = { verdict?: string; ok: boolean; card?: boolean; reviewed?: boolean; denial?: string; ruled?: Ruled };
export type StoredOutcome = { outcome: Outcome; source: "ruled" | "card" | "review" | "refusal" | "ran" } | { before: string } | { skip: string };
export function storedOutcome(s: Stored): StoredOutcome {
  if (s.ruled?.before) return { before: s.ruled.before };
  if (s.ruled?.d) return { outcome: s.ruled.d, source: "ruled" };
  if (s.card) return { outcome: "ask", source: "card" };
  if (s.reviewed) return { outcome: "ask", source: "review" };
  if (s.verdict === "denied") {
    const before = s.denial ? beforeClass(s.denial) : null;
    return before ? { before } : { outcome: "refuse", source: "refusal" };
  }
  // (Not run for another reason: a stop, a tool an upgrade took away. Whether the rules saw it is not known.)
  if (s.verdict === "none") return { skip: "not run (a stop or a missing tool)" };
  return { outcome: "allow", source: "ran" };
}

// One call of the trial: its ids, tool, kind, what is stored of it, and the replays.
// `asked`: the replay of the current rules asked the disk something the stored call has no answer for;
// `shims`: it asked whether a program name is the program itself, which history does not say.
export type TrialCall = {
  id: string; session: string; event: string; tool: string; kind: string; ts: number; ok: boolean;
  stored: StoredOutcome; current: Judged; candidate: Judged; asked?: true; shims?: true; rev?: string; mode?: Mode; modeNow?: Mode;
  // Made before the store kept a row for a flagged call Full auto ran unreviewed.
  unkept?: true;
  // An agent whose session the shared-branch guard reads (its worktree's checkouts, as git says now).
  guard?: true;
  // A file its decision read hashes otherwise now (the record keeps a file's hash, not its text).
  fileChanged?: true;
};

export type Row = { key: string; n: number; allow: number; ask: number; refuse: number; succeeded: number; share: number | null };
export type ChangedCall = { id: string; session: string; event: string; tool: string; cls: string; from: Outcome; to: Outcome; ok: boolean; link: string };
// `classes`: the disagreeing calls by their kind and the class the current rules gave them.
export type Cause = { cause: string; n: number; from: Outcome; to: Outcome; classes: Record<string, number>; calls: { id: string; link: string }[] };
export type TrialReport = {
  days: number; since: number; calls: number; ms: number;
  changed: { n: number; allow: number; ask: number; refuse: number; succeeded: number; share: number | null; tools: Row[]; classes: Row[]; calls: ChangedCall[]; more: number };
  // `recorded`: of those, the calls whose rules' decision was stored with them (the rest are read from what remains).
  agreement: { compared: number; agreed: number; share: number | null; recorded: { compared: number; agreed: number }; before: Record<string, number>; skipped: Record<string, number>; causes: Cause[] };
  // What the replay does not run, said with every report.
  limits: string[];
  // A trial stopped at its time budget: it replayed `sessions` of the `of` sessions of the days, the newest first,
  // and every count above is of those.
  partial?: { budgetMs: number; sessions: number; of: number };
};

// The activity row of a call Full auto ran with no review (src/automation/index.ts): the first such row is when
// the store began to keep them, so a flagged call before it has no row to find.
export const UNREVIEWED = "ran unreviewed (Full auto)";

export const linkOf = (c: Pick<TrialCall, "session" | "event">) => `/s/${c.session}?e=${c.event}`;
// The calls one report lists by id; the counts cover them all.
export const CALLS_MAX = 500;
// The calls one cause lists.
export const CAUSE_CALLS = 20;
export const LIMITS = [
  "The judge and the reviewer are models: a call they would review counts as asked, and what they would say is not guessed.",
  "Hooks, an agent's write scope, outside-content holds and the network switch are checks beside the rules: calls they refused are counted apart.",
  "What the disk said of a call is read from its stored record; calls stored before that record was kept are judged by their names, with the disk's lasting answers (git remotes, manifests) read now.",
];

const share = (part: number, of: number) => (of ? part / of : null);

// Why the current rules' replay of a call is not what was stored.
export function causeOf(c: TrialCall): string {
  const s = c.stored as { outcome: Outcome; source: string };
  if (c.mode && c.modeNow && c.mode !== c.modeNow) return `the session's mode changed since (${c.mode} then, ${c.modeNow} now)`;
  if (c.guard && (c.current.cls === "shared branches" || (s.outcome === "refuse" && c.current.outcome !== "refuse"))) return "an agent's shared-branch guard reads the repository's checkouts as they are now, not as they were";
  if (s.source === "ruled") {
    if (c.fileChanged) return "a file its decision read has changed since (the record keeps the file's hash, not its text)";
    if (c.asked) return "the replay asked the disk something the stored call has no answer for";
    if (c.rev) return "another build of the rules decided the call";
    return "a fact beside the call changed since (a grant, a namespace, a folder)";
  }
  // (A call stored before its rules' record was kept: what the record would have said is read from what remains.)
  if (c.unkept && s.outcome === "allow" && c.current.outcome === "ask") return "it ran in Full auto before the store kept a row for a flagged call it ran unreviewed";
  if (c.asked) return "what the disk said at the time is not stored (a call from before the record was kept)";
  if (c.shims) return "whether a program name was a version manager's shim is not stored (a call from before the record was kept)";
  if (c.current.cls === "read-only session" || c.current.cls === "plan mode") return `the session is ${c.modeNow ?? "read-only"} now, and its mode then is not stored (a call from before the record was kept)`;
  const then = s.outcome === "allow" ? "ran with no card and no review" : s.outcome === "ask" ? "was asked about" : "was refused";
  const now = c.current.outcome === "allow" ? "allowed" : c.current.outcome === "ask" ? "asked about" : "refused";
  return `it ${then} then and is ${now} now: an earlier build of the rules decided it, or a grant or fact of the time`;
}

// The report over every call replayed. `ms`: how long the replay took.
// `skipped`: calls not replayed, by why (they count in no share).
export function trialReport(calls: TrialCall[], o: { days: number; since: number; ms: number; cap?: number; skipped?: Record<string, number>; partial?: TrialReport["partial"] }): TrialReport {
  const cap = o.cap ?? CALLS_MAX;
  const tools = new Map<string, Row>(), classes = new Map<string, Row>();
  const row = (m: Map<string, Row>, key: string) => { let r = m.get(key); if (!r) m.set(key, (r = { key, n: 0, allow: 0, ask: 0, refuse: 0, succeeded: 0, share: null })); return r; };
  const listed: ChangedCall[] = [];
  let n = 0, succeeded = 0;
  const to = { allow: 0, ask: 0, refuse: 0 };
  const before: Record<string, number> = {}, skipped: Record<string, number> = { ...o.skipped };
  const causes = new Map<string, Cause>();
  let compared = 0, agreed = 0;
  const rec = { compared: 0, agreed: 0 };
  for (const c of calls) {
    if (c.candidate.outcome !== c.current.outcome) {
      n++;
      to[c.candidate.outcome]++;
      if (c.ok) succeeded++;
      // The class of the rule that changed: the candidate's, unless it allows (then the one that no longer holds).
      const cls = c.candidate.outcome === "allow" ? c.current.cls : c.candidate.cls;
      for (const r of [row(tools, c.tool), row(classes, cls)]) { r.n++; r[c.candidate.outcome]++; if (c.ok) r.succeeded++; }
      if (listed.length < cap) listed.push({ id: c.id, session: c.session, event: c.event, tool: c.tool, cls, from: c.current.outcome, to: c.candidate.outcome, ok: c.ok, link: linkOf(c) });
    }
    const s = c.stored;
    if ("before" in s) { before[s.before] = (before[s.before] ?? 0) + 1; continue; }
    if ("skip" in s) { skipped[s.skip] = (skipped[s.skip] ?? 0) + 1; continue; }
    compared++;
    if (s.source === "ruled") rec.compared++;
    if (s.outcome === c.current.outcome) { agreed++; if (s.source === "ruled") rec.agreed++; continue; }
    const cause = causeOf(c);
    const key = `${cause}\0${s.outcome}\0${c.current.outcome}`;
    let k = causes.get(key);
    if (!k) causes.set(key, (k = { cause, n: 0, from: s.outcome, to: c.current.outcome, classes: {}, calls: [] }));
    k.n++;
    const ck = `${c.kind}: ${c.current.cls}`;
    k.classes[ck] = (k.classes[ck] ?? 0) + 1;
    if (k.calls.length < CAUSE_CALLS) k.calls.push({ id: c.id, link: linkOf(c) });
  }
  const done = (m: Map<string, Row>) => [...m.values()].map((r) => ({ ...r, share: share(r.succeeded, r.n) })).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  return {
    days: o.days, since: o.since, calls: calls.length, ms: o.ms,
    changed: { n, ...to, succeeded, share: share(succeeded, n), tools: done(tools), classes: done(classes), calls: listed, more: n - listed.length },
    agreement: { compared, agreed, share: share(agreed, compared), recorded: rec, before, skipped, causes: [...causes.values()].sort((a, b) => b.n - a.n) },
    limits: LIMITS,
    ...(o.partial ? { partial: o.partial } : {}),
  };
}

// A settings diff: what the owner would change. `namespaces`: his accounts (Settings > Safety > Your accounts);
// `grants`: standing rules made (`scope`: the folder, "/" for every folder) or revoked by id; `mode`: every
// session judged in this mode.
export type GrantAdd = { kind: RuleKind; pattern: string; scope: string };
export type RuleChange = { namespaces?: { add?: string[]; remove?: string[] }; grants?: { add?: GrantAdd[]; remove?: string[] }; mode?: Mode };

const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 4096);
// What is wrong with a change as it came, or null. (The namespaces' own words are checked where they are read.)
export function checkChange(c: unknown, isMode: (m: unknown) => boolean): string | null {
  if (c === undefined || c === null) return null;
  if (typeof c !== "object" || Array.isArray(c)) return "a change is an object: namespaces, grants, mode";
  const x = c as Record<string, any>;
  for (const k of Object.keys(x)) if (!["namespaces", "grants", "mode"].includes(k)) return `a change has no ${k}: namespaces, grants or mode`;
  if (x.namespaces !== undefined) {
    if (typeof x.namespaces !== "object" || x.namespaces === null) return "namespaces is { add, remove }";
    for (const k of ["add", "remove"]) if (x.namespaces[k] !== undefined && !strings(x.namespaces[k], 500)) return `namespaces.${k} is a list of names`;
  }
  if (x.grants !== undefined) {
    if (typeof x.grants !== "object" || x.grants === null) return "grants is { add, remove }";
    if (x.grants.remove !== undefined && !strings(x.grants.remove, 500)) return "grants.remove is a list of grant ids";
    if (x.grants.add !== undefined) {
      if (!Array.isArray(x.grants.add) || x.grants.add.length > 100) return "grants.add is a list of at most 100 grants";
      for (const g of x.grants.add) {
        if (!g || !["shell", "edit", "tool"].includes(g.kind)) return "a grant's kind is shell, edit or tool";
        if (typeof g.pattern !== "string" || !g.pattern.trim() || g.pattern.length > 4096) return "a grant has a pattern";
        if (typeof g.scope !== "string" || !g.scope.startsWith("/")) return "a grant's scope is an absolute folder (/ for every folder)";
      }
    }
  }
  if (x.mode !== undefined && !isMode(x.mode)) return `unknown mode: ${x.mode}`;
  return null;
}

// The owner's namespace list with the change made (each entry as he wrote it).
export function namespacesWith(list: string[], c?: RuleChange): string[] {
  const out = list.filter((n) => !(c?.namespaces?.remove ?? []).some((r) => r.trim() === n.trim()));
  for (const a of c?.namespaces?.add ?? []) if (!out.some((n) => n.trim() === a.trim())) out.push(a.trim());
  return out;
}

// The standing rules with the change made: a revoked one is gone, a new one stood from the first call on.
export function grantsWith(rules: Rule[], c?: RuleChange): Rule[] {
  const gone = new Set(c?.grants?.remove ?? []);
  const kept = rules.filter((r) => !gone.has(r.id));
  const made = (c?.grants?.add ?? []).map((g, i): Rule => ({ id: `trial-${i}`, kind: g.kind, pattern: g.pattern.trim(), scope: g.scope, lifetime: "always", session_id: null, created: 0 }));
  return [...kept, ...made];
}

// Whether a change changes nothing.
export const emptyChange = (c?: RuleChange) => !c || (!c.namespaces?.add?.length && !c.namespaces?.remove?.length && !c.grants?.add?.length && !c.grants?.remove?.length && !c.mode);

// A change as one text: the same change gives the same text whatever order its keys and lists came in. Its hash
// names the change a trial replayed and the passkey action that saves it (src/server/routes/safety-trial.ts).
export function canonicalChange(c?: RuleChange): string {
  const sorted = (l?: string[]) => (l?.length ? [...l].map((x) => x.trim()).sort() : undefined);
  const grants = (c?.grants?.add ?? []).map((g) => ({ kind: g.kind, pattern: g.pattern.trim(), scope: g.scope })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    namespaces: { add: sorted(c?.namespaces?.add), remove: sorted(c?.namespaces?.remove) },
    grants: { add: grants.length ? grants : undefined, remove: sorted(c?.grants?.remove) },
    mode: c?.mode,
  });
}
