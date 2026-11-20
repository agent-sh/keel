// Who wrote a prompt. The owner's own words are typed in the page (no origin),
// steered into a running turn, queued, spoken or sent from the command line.
// Everything the harness delivers says what it is: a `kind` (an agent's task or
// report, a wake, a loop run, a peer's message) or an origin of its own
// (momentum, a hook, the harness, a restart). The one list for the engine and the page.
export const OWNER_ORIGINS: ReadonlySet<unknown> = new Set([undefined, "steer", "queued", "voice", "cli"]);
