// A reply's text as the editor shows it while it streams, across a model
// request that failed and was sent again (src/engine/turn.ts drops the
// half-streamed reply and tells a retry status).

type Json = any;

// One step of a reply's text as it streams. The editor shows `shown` of the
// reply; the attempt that streams now has sent `streamed` (this delta
// included). A request sent again after a failure streams its reply from the
// start: what the editor already shows is not sent again, only what goes past
// it. A retried reply that says something else is sent whole after one line
// that says so (`restarted`), and is what the editor shows from then on.
export function streamStep(shown: string, streamed: string): { send: string; shown: string; restarted?: true } {
  if (shown.startsWith(streamed)) return { send: "", shown };
  if (streamed.startsWith(shown)) return { send: streamed.slice(shown.length), shown: streamed };
  return { send: streamed, shown: streamed, restarted: true };
}
export const RESTARTED = "\n\n[Keel: the model request failed and was sent again; the reply it gave is:]\n\n";

// A retry status of the turn as a notice (clientCapabilities.session.notices).
export function retryNotice(s: { attempt?: number; max?: number; at?: number; message?: string; unreachable?: number; limit?: string }): Json {
  const title = s.unreachable ? "The model's provider cannot be reached: the request waits for it"
    : s.limit ? "The request waits in its account's line"
    : s.max ? `The model request failed: sending it again (retry ${s.attempt ?? 1} of ${s.max})`
    : "The model is at capacity: the request is sent again until it has room";
  const description = [s.limit, s.message].filter(Boolean).join(" ") || undefined;
  return { sessionUpdate: "notice", severity: "warning", title, ...(description ? { description } : {}) };
}
