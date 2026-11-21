// Who wrote a prompt. The owner's own words are typed in the page (no origin),
// steered into a running turn, queued, spoken or sent from the command line.
// Everything the harness delivers says what it is: a `kind` (an agent's task or
// report, a wake, a loop run, a peer's message) or an origin of its own
// (momentum, a hook, the harness, a restart). The one list for the engine and the page.
export const OWNER_ORIGINS: ReadonlySet<unknown> = new Set([undefined, "steer", "queued", "voice", "cli"]);

// A stored prompt's data is the owner's own words.
export const ownerPrompt = (d: { kind?: unknown; origin?: unknown } | undefined): boolean => !!d && !d.kind && OWNER_ORIGINS.has(d.origin);

// Delivered input the transcript shows as a notice of its own (an agent's task
// or report, a wake, a loop run), and a message from another session: neither
// reads as a prompt of the owner's.
export const SYSTEM_INPUT: ReadonlySet<unknown> = new Set(["task", "subagent", "wait", "loop", "steer", "harness", "wake", "goal", "failures"]);
export const PEER_PREFIX = '<external_input source="peer_session"';
type Shown = { kind: string; data: { kind?: unknown; origin?: unknown; text?: unknown } };
export const isPeerMessage = (e: Shown) => e.kind === "user" && (e.data.kind === "peer" || String(e.data.text ?? "").startsWith(PEER_PREFIX));
// A prompt as the transcript shows one: what Previous and Next prompt step
// through, in the page and in the daemon's count of a branch's prompts.
export const shownAsPrompt = (e: Shown) => e.kind === "user" && e.data.origin !== "restart" && e.data.origin !== "harness" && !SYSTEM_INPUT.has(e.data.kind) && !isPeerMessage(e);
