// A port range for each session whose commands share the host's loopback (src/tools/session-ports.ts): KEEL_PORT in
// the environment of its commands, its hooks and its worktree's setup. A session in a sandbox has a network of its own
// and gets none. The portal (the Preview panel) names the session that holds the range a port is in.
import { holderOf, portEnv, rangeOf, SCHEMA } from "../../tools/session-ports.ts";
import { registerEnv } from "../../tools/jobs.ts";
import type { RouteModule } from "../app.ts";
import { gate } from "./permissions.ts";

let held: ((port: number) => { session_id: string; title: string; base: number } | null) | undefined;
// Who holds the range a port is in: a session that still exists, with its title.
export const rangeHolder = (port: number) => held?.(port) ?? null;
// The range of a session, as the first of its ten ports (null: it has none: a sandbox, or none left).
export let rangeFor: (sessionId: string) => number | null = () => null;

export const sessionPortRoutes: RouteModule = ({ store }) => {
  store.migrate(SCHEMA);
  held = (port) => {
    const h = holderOf(store.db, port);
    return h ? { ...h, title: store.session(h.session_id)?.title ?? "" } : null;
  };
  rangeFor = (id) => (store.session(id) && gate && !gate.confined(id) ? rangeOf(store.db, id) : null);
  registerEnv((sessionId) => portEnv(rangeFor(sessionId)));
  return {};
};
