// What a failure is, for what the page offers on it: the words that lead the
// box a failed turn leaves (TurnFailure), the page that fixes it (billing, the
// provider's settings), and whether an agent could fix it. One reading for the
// failure box in the transcript and for a row of the Errors panel, so both
// offer the same acts for the same failure.
import { errorClass, type ErrorClass } from "../../../src/admin/classes.ts";
import type { ErrorRecord } from "../../../src/core/types.ts";

export type FailKind = "auth" | "rate" | "quota" | "overloaded" | "network" | "unreachable" | "invalid" | "context" | "server";

// What failed, in the owner's words. The provider's own message follows it.
export const LEAD: Record<FailKind, string> = {
  quota: "The provider's account is out of credit or over its quota.",
  rate: "The provider is limiting how often this account may ask.",
  auth: "The provider did not accept the credentials.",
  overloaded: "The provider is overloaded.",
  network: "The provider's answer broke off or went silent.",
  // A turn waits for a provider it cannot reach (src/providers/outage.ts): this box is a request made outside that wait, or the wait's end a week on.
  unreachable: "The provider could not be reached.",
  server: "The provider failed on its side.",
  context: "The conversation no longer fits the model's window.",
  invalid: "The provider refused the request as it was sent.",
};

// A failure stored before failures carried their kind is read from its status.
export const kindOf = (kind: unknown, status?: number): FailKind | undefined =>
  typeof kind === "string" && kind in LEAD ? (kind as FailKind)
    : status === 402 ? "quota" : status === 429 ? "rate" : status === 401 || status === 403 ? "auth" : status === 529 || status === 503 ? "overloaded" : status && status >= 500 ? "server" : undefined;

// The class the daemon counts a failure under, as the kind the box speaks of (src/admin/classes.ts).
const OF_CLASS: Partial<Record<ErrorClass, FailKind>> = {
  rate_limit: "rate", overloaded: "overloaded", server: "server", stream_drop: "network", unreachable: "unreachable",
  context_overflow: "context", auth: "auth", quota: "quota", invalid_request: "invalid",
};

export const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;
// An address in running text ends before the sentence's own punctuation.
export const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");
export const firstUrl = (text: string) => { const m = text.match(URL_RE); return m ? trimUrl(m[0]) : undefined; };

export type Failure = {
  kind?: FailKind;
  status?: number;
  words: string;   // the provider's own words, without an "HTTP 402: " opening
  // The fix is somewhere else: the account's billing (the address the provider gave), the provider's settings.
  fix?: { label: string; href: string } | { label: string; settings: string };
  page?: string;   // any other address the provider gave
};

// A failure from its stored words and, when the driver said them, its kind and status.
export function failureOf(f: { message: string; kind?: unknown; status?: unknown; guess?: boolean }): Failure {
  const http = /^HTTP (\d+): /.exec(f.message);
  const status = typeof f.status === "number" ? f.status : http ? Number(http[1]) : undefined;
  const said = kindOf(f.kind, status);
  // What the daemon's classes read from the words: "unreachable" for a network failure, and any
  // kind at all for a row stored before rows kept theirs (`guess`).
  const cls = errorClass({ message: f.message, ...(said ? { kind: said } : {}), ...(status ? { status } : {}) });
  const kind = (said === "network" || said === undefined) && cls === "unreachable" ? "unreachable" : said ?? (f.guess && cls ? OF_CLASS[cls] : undefined);
  const words = http ? f.message.slice(http[0].length) : f.message;
  const url = firstUrl(words);
  const fix = kind === "quota" && url ? { label: "Open billing", href: url } : kind === "auth" ? { label: "Open provider settings", settings: "providers" } : undefined;
  return { kind, status, words, fix, page: !fix && url ? url : undefined };
}

// A provider's failure as an Errors row holds it (the kind and status kept in
// its context: src/core/errors.ts failureFacts). Not a provider's: undefined.
export const rowFailure = (e: Pick<ErrorRecord, "source" | "message" | "context">): Failure | undefined =>
  e.source !== "provider" ? undefined : failureOf({ message: e.message, kind: e.context?.failure, status: e.context?.status, guess: true });

// Failures of the provider's side or the owner's account: no change to Keel or
// the project mends them, so an agent handed the bundle has nothing to fix.
// The owner's acts are the ones that help (billing, settings, again, another model).
const NOT_FOR_AN_AGENT = new Set<FailKind>(["quota", "rate", "auth", "overloaded", "network", "unreachable", "server"]);
export const agentCanFix = (e: Pick<ErrorRecord, "source" | "message" | "context">): boolean => {
  const f = rowFailure(e);
  return !f?.kind || !NOT_FOR_AN_AGENT.has(f.kind);
};

// A session's turn failure and its capture are written in one step, the
// capture first: the session's failure stamp (failed_ms, src/server/routes/marks.ts)
// follows its row's time in that session by moments. The same bound marks.ts
// takes a turn's error and its end as one failure by.
const SAME_FAILURE_MS = 5000;

// The id of the provider failure the session's last turn stopped on, among the
// rows: the newest provider row in that session at or before its failure stamp,
// within moments of it. None when the last turn did not fail (a later turn
// started), or failed on nothing a row holds.
export function stoppedOn(errors: Pick<ErrorRecord, "id" | "source" | "sites">[], sessionId: string, failedMs: number | null | undefined): string | undefined {
  if (!failedMs) return undefined;
  let best: { id: string; ts: number } | undefined;
  for (const e of errors) {
    if (e.source !== "provider") continue;
    const s = e.sites?.find((x) => x.session_id === sessionId);
    if (!s || s.ts > failedMs || failedMs - s.ts > SAME_FAILURE_MS) continue;
    if (!best || s.ts > best.ts) best = { id: e.id, ts: s.ts };
  }
  return best?.id;
}
