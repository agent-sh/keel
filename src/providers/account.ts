// The words of an account state: a route out of credit or suspended for
// billing, or signed out. Neither passes by itself: every request on the
// route is refused until the owner acts, so new work is not started on it
// (`routeShut` in src/automation/incidents.ts) for a time (`shutFor`).
//
// From each provider's documented errors, as phrases or error codes only (a
// bare "billing" names a schema field as often as an account): OpenAI's
// `insufficient_quota` (a 429) and `billing_hard_limit_reached`, Anthropic's
// `billing_error` and "Your credit balance is too low" (a 400), a gateway's
// "no available balance" and "the API key is suspended for billing", and an
// ACP agent's auth_required (-32000) or its words for a missing sign-in.
export const BILLING_WORDS = /\b(?:billing_error|insufficient_quota|billing_hard_limit_reached|billing_not_active)\b|credit balance is too low|suspended for billing|no available balance|insufficient (?:credits?|balance|funds)|out of credits?|exceeded your current quota|\b(?:account|api.?key)\b[^.\n]{0,24}\bsuspended\b/i;
export const SIGNED_OUT_WORDS = /auth(entication)? required|not (signed|logged) in|(sign(ed)?|log(ged)?) ?in (first|again|required)|needs you to sign in|please (sign|log) ?in|login required/i;
// A credential refused in so many words (a 403 that says so is the route's sign-in, not a permission).
export const CREDENTIAL_WORDS = /invalid.{0,12}(?:api.?key|x-api-key|token|credential)|incorrect api key|api key not valid|expired.{0,12}token|no credentials/i;
// A model, or a resource, the account may not use: that model is refused, not the route.
export const ACCESS_WORDS = /permission_error|(?:do(?:es)?n['\u2019]?t|do(?:es)? not|no) (?:have )?(?:access|permission) to (?:use |access |invoke )?(?:the |this )?(?:model|specified|resource)|not authori[sz]ed to (?:use|access|invoke)|accessdenied|access denied|model.{0,40}not (?:enabled|available) for (?:your|this) (?:account|organization|key)/i;

// How long a route marked shut keeps new work off it before the next request
// on it decides (clears the mark, or marks it again). 15 minutes first: an
// owner who reads the alert and adds credit or signs in has done it by then,
// and a wrong pass-over costs only a less preferred route for that long; a
// request refused for billing or a sign-in is not billed, so the try costs one
// failed start. Doubling while it keeps failing: a route left unpaid overnight
// fails a new start six times, not four an hour. Capped at 4 hours, so a route
// paid while nobody watches is tried again within a working morning.
export const SHUT_FIRST_MS = 15 * 60_000;
export const SHUT_MAX_MS = 4 * 3600_000;
export const shutFor = (strikes: number) => Math.min(SHUT_MAX_MS, SHUT_FIRST_MS * 2 ** Math.max(0, strikes - 1));
// Past a mark's time one choice of new work tries the route; the others pass it over as before
// until that try is answered (a request refused again marks it, an answer clears it), so the
// agents that waited do not all fail at once on a route still unpaid. A refusal for billing or a
// sign-in is a request's first answer, in seconds; the start that tried may first spend up to two
// minutes on its brief (a successor's restatement has a two-minute limit) before its request. A
// try with no answer in 3 minutes was never sent or is being served, and the next choice tries.
export const SHUT_TRY_MS = 3 * 60_000;

// A route's account problem as one line: who, what, and the provider's own words.
export function shutWords(p: { kind: "auth" | "billing" | "access"; message: string; label: string; route: string; until?: number; trying?: boolean } | undefined, now = Date.now()): string | undefined {
  if (!p) return undefined;
  const model = p.route.startsWith("model:");
  const id = model ? p.route.slice(6) : p.route;
  const part = id.includes(":") ? ` (${id.slice(id.indexOf(":") + 1)})` : "";
  const said = p.message.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 200);
  const what = p.kind === "billing" ? "is out of credit or suspended for billing" : p.kind === "access" ? "does not give this account the model" : "refuses its sign-in";
  const left = p.trying ? "; another start is trying it again now"
    : p.until && p.until > now ? `; tried again in ${Math.max(1, Math.round((p.until - now) / 60_000))} min` : "";
  return `${p.label}${part} ${what}${left}: ${said}`;
}

export type Skipped = { model: string; why: string };

// The first of `order` whose route takes work, and the ones before it that were
// skipped, each with why (`shut`: why a model's route takes no work now).
export function firstOpen(order: readonly string[], shut: (model: string) => string | undefined): { model?: string; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  for (const model of new Set(order)) {
    const why = shut(model);
    if (!why) return { model, skipped };
    skipped.push({ model, why });
  }
  return { skipped };
}

// The skipped routes as a clause of a line: "skipped a (why); b (why)".
export const skippedWords = (s: readonly Skipped[]) => s.map((x) => `${x.model} (${x.why})`).join("; ");
