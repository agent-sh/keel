// Rate-limit and plan usage windows per provider: read off every answer's
// headers (Anthropic `anthropic-ratelimit-*`, OpenAI-style `x-ratelimit-*`,
// the ChatGPT plan's `x-codex-*`) and asked of the accounts that have a usage
// endpoint (the ChatGPT plan's /wham/usage, an OpenRouter key's /key, the Grok
// plan's billing window, a plugin's status). Nothing here is invented: a
// window exists when the provider stated it.

export type Window = {
  provider: string;
  id: string;             // stable per provider: "requests", "tokens", "primary", "key_limit"...
  label: string;          // "Requests", "5 hours", "7 days", "Key limit"
  used_percent?: number;
  remaining?: number;     // in `unit`
  limit?: number;
  unit?: "requests" | "tokens" | "usd";
  resets_at_ms?: number;
  spent_usd?: number;     // what an account spent in the window (no ceiling stated)
  overage_enabled?: boolean;
  note?: string;
  observed_ms: number;
};

export type WindowReading = Omit<Window, "provider" | "observed_ms">;

// A window this full (or with this little left) is close: shown near the picker.
export const CLOSE_PERCENT = 80;

// "6m0s", "1s", "250ms", "1h2m3.5s" (OpenAI's resets) to milliseconds.
export function goDuration(s: string): number | undefined {
  let ms = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === "h" ? n * 3600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? ms : undefined;
}

// A window length in minutes as a label: 300 -> "5 hours", 10080 -> "7 days".
export function spanLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

const num = (v: string | null) => (v === null || v.trim() === "" || isNaN(Number(v)) ? undefined : Number(v));
const pct = (remaining?: number, limit?: number) =>
  remaining !== undefined && limit ? Math.min(100, Math.max(0, (100 * (limit - remaining)) / limit)) : undefined;

// Every window an answer's headers state. `now` makes relative resets absolute.
export function fromHeaders(h: Headers, now = Date.now()): WindowReading[] {
  const out: WindowReading[] = [];
  // Anthropic: requests, tokens, input and output tokens, and the fast-mode set.
  for (const [prefix, kinds] of [["anthropic-ratelimit-", ["requests", "tokens", "input-tokens", "output-tokens"]], ["anthropic-fast-", ["input-tokens", "output-tokens"]]] as const) {
    for (const k of kinds) {
      const limit = num(h.get(`${prefix}${k}-limit`));
      const remaining = num(h.get(`${prefix}${k}-remaining`));
      if (limit === undefined && remaining === undefined) continue;
      const reset = h.get(`${prefix}${k}-reset`);
      const fast = prefix === "anthropic-fast-";
      out.push({
        id: `${fast ? "fast-" : ""}${k}`, label: `${fast ? "Fast " : ""}${k.replace("-", " ")} per minute`.replace(/^./, (c) => c.toUpperCase()),
        limit, remaining, used_percent: pct(remaining, limit), unit: k === "requests" ? "requests" : "tokens",
        resets_at_ms: reset ? Date.parse(reset) || undefined : undefined,
      });
    }
  }
  // OpenAI and the endpoints that copy it: x-ratelimit-{limit,remaining,reset}-{requests,tokens};
  // OpenRouter's bare x-ratelimit-{limit,remaining,reset} (reset in epoch ms).
  for (const k of ["requests", "tokens", ""]) {
    const sfx = k ? `-${k}` : "";
    const limit = num(h.get(`x-ratelimit-limit${sfx}`));
    const remaining = num(h.get(`x-ratelimit-remaining${sfx}`));
    if (limit === undefined && remaining === undefined) continue;
    const reset = h.get(`x-ratelimit-reset${sfx}`);
    const resetMs = !reset ? undefined : k ? goDuration(reset) : num(reset);
    out.push({
      id: k || "requests", label: k === "tokens" ? "Tokens per minute" : "Requests per minute",
      limit, remaining, used_percent: pct(remaining, limit), unit: k === "tokens" ? "tokens" : "requests",
      resets_at_ms: resetMs === undefined ? undefined : k ? now + resetMs : resetMs,
    });
  }
  // Fireworks states only whether the key is over its limit.
  if (h.get("x-ratelimit-over-limit") === "yes") out.push({ id: "over-limit", label: "Rate limit", used_percent: 100, note: "over the limit" });
  // The ChatGPT plan: x-<family>-{primary,secondary}-{used-percent,window-minutes,reset-at}.
  const families = new Set<string>();
  h.forEach((_v, name) => {
    const m = /^x-(.+)-primary-used-percent$/.exec(name.toLowerCase());
    if (m) families.add(m[1]!);
  });
  for (const f of families) {
    for (const slot of ["primary", "secondary"]) {
      const used = num(h.get(`x-${f}-${slot}-used-percent`));
      if (used === undefined) continue;
      const minutes = num(h.get(`x-${f}-${slot}-window-minutes`));
      const at = num(h.get(`x-${f}-${slot}-reset-at`));
      const name = h.get(`x-${f}-limit-name`);
      out.push({
        id: f === "codex" ? slot : `${f}-${slot}`,
        label: `${name && f !== "codex" ? `${name} ` : ""}${minutes ? spanLabel(minutes) : slot}`,
        used_percent: Math.min(100, Math.max(0, used)),
        resets_at_ms: at ? at * 1000 : undefined,
      });
    }
  }
  const credits = h.get("x-codex-credits-has-credits");
  if (credits !== null && h.get("x-codex-credits-unlimited") !== "true") {
    const balance = num(h.get("x-codex-credits-balance"));
    if (balance !== undefined) out.push({ id: "credits", label: "Credits", remaining: balance, note: /^(true|1)$/.test(credits) ? undefined : "no credits" });
  }
  return out;
}

// The ChatGPT plan's /wham/usage answer (what Codex's /status reads).
export function fromChatgptUsage(d: any, now = Date.now()): WindowReading[] {
  const out: WindowReading[] = [];
  const win = (id: string, w: any, label?: string) => {
    if (!w || typeof w.used_percent !== "number") return;
    const secs = w.limit_window_seconds;
    const at = typeof w.reset_at === "number" ? w.reset_at * 1000 : typeof w.reset_after_seconds === "number" ? now + w.reset_after_seconds * 1000 : undefined;
    out.push({ id, label: label ?? (secs ? spanLabel(Math.round(secs / 60)) : id), used_percent: Math.min(100, Math.max(0, w.used_percent)), resets_at_ms: at });
  };
  win("primary", d?.rate_limit?.primary_window);
  win("secondary", d?.rate_limit?.secondary_window);
  for (const a of d?.additional_rate_limits ?? []) {
    const name = a?.limit_name ?? a?.metered_feature;
    win(`${name}-primary`, a?.rate_limit?.primary_window, name ? `${name} ${spanLabel(Math.round((a.rate_limit.primary_window?.limit_window_seconds ?? 0) / 60) || 1)}` : undefined);
  }
  const c = d?.credits;
  if (c && !c.unlimited && c.balance !== undefined && c.balance !== null && !isNaN(Number(c.balance))) {
    out.push({ id: "credits", label: "Credits", remaining: Number(c.balance), note: c.has_credits === false ? "no credits" : undefined });
  }
  return out;
}

// An OpenRouter key's /api/v1/key answer.
export function fromOpenRouterKey(d: any): WindowReading[] {
  const k = d?.data;
  if (!k) return [];
  const out: WindowReading[] = [];
  if (typeof k.limit === "number" && k.limit > 0) {
    const remaining = typeof k.limit_remaining === "number" ? k.limit_remaining : undefined;
    out.push({ id: "key_limit", label: `Key limit${k.limit_reset ? ` (${k.limit_reset})` : ""}`, limit: k.limit, remaining, used_percent: pct(remaining, k.limit), unit: "usd" });
  }
  if (typeof k.usage_daily === "number") out.push({ id: "today", label: "Spent today", spent_usd: k.usage_daily, unit: "usd" });
  if (typeof k.usage_monthly === "number") out.push({ id: "month", label: "Spent this month", spent_usd: k.usage_monthly, unit: "usd" });
  if (k.is_free_tier) out.push({ id: "free_tier", label: "Free tier", note: "free models only, with daily request caps" });
  return out;
}

export class Limits {
  private windows = new Map<string, Window>();

  record(provider: string, readings: WindowReading[], now = Date.now()) {
    for (const r of readings) this.windows.set(`${provider}\u0000${r.id}`, { ...r, provider, observed_ms: now });
  }

  // Current windows; one whose reset has passed is left out.
  list(provider?: string, now = Date.now()): Window[] {
    return [...this.windows.values()].filter((w) => (!provider || w.provider === provider) && !(w.resets_at_ms && w.resets_at_ms < now));
  }
}

export const isClose = (w: Window) => w.used_percent !== undefined && w.used_percent >= CLOSE_PERCENT;
