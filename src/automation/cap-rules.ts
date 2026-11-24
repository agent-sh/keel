// A dollar cap on a session and everything it starts (an agent's own budget in dollars is the same
// thing for its task): what a view shows of it, and when the owner or the parent is told. Pure; the
// ledger reads are in src/automation/caps.ts. Nothing here knows a price or a model.
//
// The burn rate is what the tree spent in the last ten minutes, as dollars an hour. The forecast is
// what the cap's spend would be an hour from now at that rate. A cap set minutes ago has less than
// ten minutes of its own history, so its rate is over the time it has had (at least one minute: a
// single step must not read as an hour's rate). At 80 percent the one who gave the work is told once
// (the owner for a top session, the parent for an agent); at 100 percent new work stops: no new
// model step but the report, no new agent (a step that runs finishes).

export const BURN_WINDOW_MS = 10 * 60_000;
export const MIN_WINDOW_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const WARN_AT = 0.8;

export type CapLevel = "ok" | "warn" | "spent";
// What the ledger says: the cap's dollars, its tree's spend since the cap began and in the last
// ten minutes, and when the cap began.
export type CapFacts = { usd: number; spent: number; recent: number; from: number; now: number };
export type CapView = {
  usd: number;
  spent: number;
  pct: number; // spent over the cap, 0 to any
  level: CapLevel;
  burn_hour: number; // dollars an hour at the rate of the last ten minutes
  forecast_hour: number; // the spend an hour from now at that rate
  ms_to_cap: number | null; // time until the cap at that rate (0: reached; null: the rate is nil, it never is)
};

// One cap as the daemon tells it: `id` is the session it sits on, `at` when it was read.
// `unpriced`: calls in the tree's spend whose model has no listed price (a plan, a local model): they add no
// dollars, and the popup says so. A call with no price when it ran is counted at the model's listed price now.
export type CapRow = CapView & { id: string; kind: "session" | "agent"; from: number; at: number; unpriced: number };

export const levelOf = (spent: number, usd: number): CapLevel => (spent >= usd ? "spent" : spent >= usd * WARN_AT ? "warn" : "ok");

// The time the rate is read over: the last ten minutes, or the cap's whole life when it is younger.
export const windowOf = (from: number, now: number) => Math.min(BURN_WINDOW_MS, Math.max(MIN_WINDOW_MS, now - from));

export function capView(f: CapFacts): CapView {
  const burn = f.recent > 0 ? (f.recent / windowOf(f.from, f.now)) * HOUR_MS : 0;
  const left = f.usd - f.spent;
  return {
    usd: f.usd,
    spent: f.spent,
    pct: f.usd > 0 ? f.spent / f.usd : 0,
    level: levelOf(f.spent, f.usd),
    burn_hour: burn,
    forecast_hour: f.spent + burn,
    ms_to_cap: left <= 0 ? 0 : burn > 0 ? (left / burn) * HOUR_MS : null,
  };
}

// Cents for dollars of a unit and up, two figures below a dime, so a small cap never reads $0.00.
export const dollars = (n: number) => `$${n >= 1 ? n.toFixed(2).replace(/\.00$/, "") : n >= 0.1 ? n.toFixed(2) : String(Number(n.toPrecision(2)))}`;
const span = (ms: number) => (ms < 90_000 ? "a minute" : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 3_600_000)} hours`);
const pctWords = (v: CapView) => `${Math.floor(v.pct * 100)} percent`;

// The facts a notice or a card gives, one line: the spend, the cap, the rate and what it comes to.
export function capLine(v: CapView): string {
  const rate = v.burn_hour > 0
    ? `; at the last ten minutes' rate of ${dollars(v.burn_hour)} an hour it is ${dollars(v.forecast_hour)} in an hour${v.ms_to_cap ? `, and the cap is reached in ${span(v.ms_to_cap)}` : ""}`
    : "; nothing was spent in the last ten minutes";
  return `${dollars(v.spent)} of the ${dollars(v.usd)} cap (${pctWords(v)})${rate}`;
}

// When the one who gave the work is told of the 80 percent: once for a cap, and again for a raised one.
// `told`: the cap's dollars and start when it was told last, if it was.
export const warnDue = (v: CapView, told: { usd: number; from: number } | undefined, cap: { usd: number; from: number }): boolean =>
  v.level !== "ok" && !(told && told.usd === cap.usd && told.from === cap.from);

// One press doubles the cap, and goes past an overshoot: a cap whose spend ran over it is raised to
// half as much again as the spend, so the work has room and the 80 percent is not met at once.
export const raisedCap = (usd: number, spent: number): number => Number(Math.max(usd * 2, spent * 1.5).toPrecision(3));

// What a view of the cap says, short: for a row's tip and the header chip's title.
export const capTip = (v: CapView, who: string) =>
  v.level === "spent" ? `${who} reached its ${dollars(v.usd)} cap (${dollars(v.spent)} spent): new work waits until it is raised` : `${who}: ${capLine(v)}`;

// The harness's words for the last step of a session at its cap (a top session's own, or the session above an agent).
export const capClosing = (usd: number, spent: number, above?: string) =>
  `[harness] ${above ? `The dollar cap of "${above}", the session above you, is reached` : "The dollar cap of this session is reached"} (${dollars(usd)}; spent ${dollars(spent)}). This is your last step: no tool call runs, and no agent starts${above ? ", and any agents you started stop with you" : ""}. Write your report now: what you did, where the work stands and what is left${above ? "" : ". The owner can raise the cap to go on"}.`;

// The notice that rides a session's failures list (the kind "budget", the cause `80%`).
export const WARN_CLS = "80%";
export const warnMessage = (v: CapView, who?: string) => `${who ? `${who}: ` : ""}${capLine(v)}`;

// The note a turn carries once while the owner's own message runs it past a reached cap: the owner chose
// to spend, so the steps go on; what they must know is that the cap is reached and nothing else starts.
export const capOwnerNote = (usd: number, spent: number) =>
  `[harness] The dollar cap of this session is reached (${dollars(usd)}; spent ${dollars(spent)}). The owner wrote to you, so this turn goes on at their cost. No agent starts until the cap is raised, and the agents you started stop at their next step.`;

// What the owner is told once when a reached cap holds the inputs that are not theirs.
export const HELD_CLS = "held";
export const capHeldMessage = (usd: number, spent: number) =>
  `The dollar cap (${dollars(usd)}) is reached with ${dollars(spent)} spent: loops, timer wakes, agent reports and goal checks for this session wait until the cap is raised. Your own messages still run.`;
