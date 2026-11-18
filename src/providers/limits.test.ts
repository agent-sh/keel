import { expect, test } from "bun:test";
import { fromChatgptUsage, fromHeaders } from "./limits.ts";

// The windows each provider's headers state, read as the vendors document them.
test("rate-limit headers of Anthropic, OpenAI and the ChatGPT plan", () => {
  const now = 1_000_000;
  const a = fromHeaders(new Headers({
    "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "5", "anthropic-ratelimit-requests-reset": "2026-11-19T00:01:00Z",
  }), now);
  expect(a).toEqual([{ id: "requests", label: "Requests per minute", limit: 50, remaining: 5, used_percent: 90, unit: "requests", resets_at_ms: Date.parse("2026-11-19T00:01:00Z") }]);
  const o = fromHeaders(new Headers({ "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "750", "x-ratelimit-reset-tokens": "6m0s" }), now);
  expect(o[0]).toMatchObject({ id: "tokens", used_percent: 25, resets_at_ms: now + 360_000 });
  const c = fromHeaders(new Headers({ "x-codex-primary-used-percent": "87.5", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": "2000", "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080" }), now);
  expect(c).toEqual([
    { id: "primary", label: "5 hours", used_percent: 87.5, resets_at_ms: 2_000_000 },
    { id: "secondary", label: "7 days", used_percent: 40, resets_at_ms: undefined },
  ]);
});

test("the ChatGPT plan's usage endpoint", () => {
  const w = fromChatgptUsage({ rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 604800, reset_after_seconds: 10 } }, credits: { has_credits: false, unlimited: false, balance: "0" } }, 0);
  expect(w).toEqual([
    { id: "primary", label: "7 days", used_percent: 60, resets_at_ms: 10_000 },
    { id: "credits", label: "Credits", remaining: 0, note: "no credits" },
  ]);
});
