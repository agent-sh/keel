// The second daemon the fleet specs pair with. It must be another daemon: a
// KEEL_PEER_URL that reaches this one (a lane whose own daemon sits on the
// default peer port), or a daemon started on a copy of this one's state, has
// the same daemon id, and a daemon is never paired with itself.
import type { APIRequestContext } from "@playwright/test";

export async function peerProblem(request: APIRequestContext, peer: string): Promise<string | null> {
  const fix = "start a second daemon with a state of its own (scripts/dev.sh <another port>) and set KEEL_PEER_URL and KEEL_PEER_ROOT";
  const up = await request.get(`${peer}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  if (!up) return `no peer daemon at ${peer}: ${fix}`;
  const id = async (base: string) => (await (await request.get(`${base}/api/fleet/identity`, { timeout: 3000 })).json()).daemon_id as string;
  const [here, there] = await Promise.all([id(""), id(peer)]);
  if (here === there) return `the peer at ${peer} is this daemon, or one started on a copy of its state (both are ${here}): ${fix}`;
  return null;
}
