// Whether the daemon the specs drive is a scratch one, decided from what the
// daemon itself says. The specs change and remove what they find there, so a
// KEEL_URL that names a daemon somebody works on must lose nothing: a spec's
// fixture removes the sessions a test made only on a scratch daemon.
//
// Scratch is: the scripted provider is listed (it exists only where
// KEEL_SCRIPTED_PROVIDER is set, which no daemon in use has), or the daemon
// was started as a dev daemon with a state folder that is not the default
// one (scripts/dev.sh names its own).
export type DaemonFacts = { argv?: string[]; state_dir?: string; home?: string; providers?: string[] };

export function isScratch(d: DaemonFacts): boolean {
  if (d.providers?.includes("scripted")) return true;
  if (!d.argv?.includes("--dev") || !d.state_dir || !d.home) return false;
  const clean = (p: string) => p.replace(/\/+$/, "");
  return clean(d.state_dir) !== `${clean(d.home)}/.local/state/keel-bun`;
}
