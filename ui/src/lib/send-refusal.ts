// What the daemon's answer to a send means for the message (pure: no storage, no page).
// Where a new session's first message goes: the plain create, one in a fresh
// worktree, one on a machine of the fleet.
const CREATES = ["/api/sessions", "/api/worktrees", "/api/fleet/sessions"];

// A missing or cut response, a proxy failure or a server fault can happen
// after acceptance. Only the daemon's own refusal is a certain non-send: from
// the message route before it can append or queue the prompt, from a create
// route (each answers 4xx only before a session exists, or after deleting the
// one it made), from the admission check in front of both, or a passkey check
// that was needed and not given (the request is not repeated).
// The daemon was not there to take it: the request never got an answer (the
// daemon is down, or its answer was cut), or the daemon said it takes no new
// work while it restarts, or that its store takes no writes for now (its disk
// is slow or does not answer): the message waits and goes out by itself when it does.
export function daemonAway(err: unknown) {
  const e = err as { status?: number; body?: { draining?: boolean; store_refusing?: boolean } } | null;
  return err instanceof TypeError || (e?.status === 503 && (e.body?.draining === true || e.body?.store_refusing === true));
}

// (`store_refusing`: the daemon's store takes no writes, said by the admission check: the message was not taken.)
export function messageRefused(err: unknown, sid?: string) {
  const e = err as { path?: string; status?: number; body?: { error?: unknown; draining?: boolean; store_refusing?: boolean } } | null;
  if (e?.status === 428) return true;
  if (typeof e?.body?.error !== "string") return false;
  if (sid ? e.path !== `/api/sessions/${sid}/messages` : !CREATES.includes(e.path ?? "")) return false;
  return e.status === 400 || e.status === 403 || e.status === 404 || e.status === 409 || (e.status === 503 && (e.body.draining === true || e.body.store_refusing === true));
}
