// keel pause [--stop-running] [--status] | keel resume --fleet: the fleet pause from a terminal
// (src/automation/fleet-pause.ts). One switch holds every start the owner did not make: loop runs, timer
// wakes, agents' new turns, follow-ups. A turn the owner's own words start still runs.
import { ago, command, EXIT, printJson, usageError, type Client } from "./client.ts";

export const PAUSE_USAGE = `keel pause [--stop-running] [--status] [--json]
keel resume --fleet [--json]
  Holds every start you did not make until you resume: loop runs, wakes, agents' new turns, follow-ups.
  The hold is kept across a restart. Your own messages still start turns.
      --stop-running   end the turns running now that you did not start, too
      --status         say whether the fleet is paused, and change nothing`;

type Pause = { paused: boolean; since: number | null; stopped?: string[] };
const words = (p: Pause) => (p.paused ? `the fleet is paused (${p.since ? `${ago(p.since)} ago` : "now"}): nothing you did not start runs` : "the fleet is not paused");

export const pauseCmd = command("pause", PAUSE_USAGE, { "stop-running": { type: "boolean" }, status: { type: "boolean" } }, async (v, pos, c) => {
  if (pos.length) return usageError("pause", `unexpected ${pos[0]}`, PAUSE_USAGE);
  if (v.status) {
    const s = await c.get<Pause>("/api/fleet-pause");
    return v.json ? (printJson(s), EXIT.ok) : (console.log(words(s)), EXIT.ok);
  }
  const r = await c.post<Pause>("/api/fleet-pause", { on: true, stop_running: !!v["stop-running"] });
  if (v.json) return (printJson(r), EXIT.ok);
  console.log(`${words(r)}${r.stopped?.length ? `; stopped ${r.stopped.length} running turn${r.stopped.length === 1 ? "" : "s"}` : ""}`);
  return EXIT.ok;
});

// `keel resume --fleet` (the same word resumes a session when it names one).
export const resumeFleet = command("resume", PAUSE_USAGE, { fleet: { type: "boolean" } }, async (v, pos, c: Client) => {
  if (pos.length) return usageError("resume", `--fleet takes no session: ${pos[0]}`, PAUSE_USAGE);
  const r = await c.post<Pause>("/api/fleet-pause", { on: false });
  return v.json ? (printJson(r), EXIT.ok) : (console.log(words(r)), EXIT.ok);
});
