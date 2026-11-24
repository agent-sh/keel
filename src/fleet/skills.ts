// The skills of a session whose tools run on another machine are that
// machine's: listed and read over the paired link (the hands routes there,
// src/fleet/hands-routes.ts), where its own trust and scan rules apply.
// This machine's skills name files and commands that are not where the
// session's commands run. A machine that does not answer gives an error, and
// the caller offers no skills: never this machine's (src/tools/skills.ts).
import type { Skill, SkillHome } from "../tools/skills.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError } from "./link.ts";

type Session = { id: string; workspace: string; machine?: string | null };

// `session`: the session as the store holds it now (absent: it is gone).
export function peerSkills(f: Fleet, session: (id: string) => Session | undefined, onError: (e: unknown, machine: string) => void): (sessionId: string) => SkillHome | null {
  return (sessionId) => {
    const s = session(sessionId);
    if (!s?.machine) return null;
    const m = f.row(s.machine);
    if (!m) {
      const gone = async () => ({ error: "the session's machine was removed from the fleet" });
      return { machine: "its machine", list: gone, get: gone };
    }
    const ask = async <T>(path: string, extra: object = {}): Promise<T | { error: string }> => {
      if (!m.workspace_root) return { error: `${m.name} has no granted directory` };
      try {
        return await f.handsJson<T>(m.id, path, { method: "POST", body: JSON.stringify({ cwd: s.workspace, root: m.workspace_root, session: s.id, ...extra }), idempotent: true });
      } catch (e) {
        // A machine out of reach is no failure of this daemon: it is said by the answer.
        if (!(e instanceof LinkError)) onError(e, m.id);
        return { error: (e as Error).message };
      }
    };
    return {
      machine: m.name,
      list: async () => {
        const r = await ask<{ skills?: Skill[] }>("/api/fleet/hands/skills");
        return "error" in r ? r : Array.isArray(r.skills) ? { skills: r.skills } : { error: "it answered with no list" };
      },
      get: (name) => ask("/api/fleet/hands/skill", { name }),
    };
  };
}
