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

// A machine's answer is read for the fields a skill has, each of the shape it has: a malformed entry is
// left out (one bad entry is not the list's failure), and a field it does not own is dropped.
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
export function readSkill(x: unknown): Skill | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  for (const k of ["name", "description", "dir", "file", "root"]) if (typeof o[k] !== "string") return null;
  if (!o.name || (o.scope !== "personal" && o.scope !== "project" && o.scope !== "plugin")) return null;
  if (o.kind !== "skill" && o.kind !== "command") return null;
  const args = strs(o.arguments);
  if (!args || typeof o.userInvocable !== "boolean" || typeof o.modelInvocable !== "boolean" || typeof o.enabled !== "boolean") return null;
  const f = o.fork as { agent?: unknown; background?: unknown } | undefined;
  const opt = (k: string) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {});
  const list = (k: string) => (strs(o[k]) ? { [k]: o[k] as string[] } : {});
  return {
    name: o.name as string, description: o.description as string, dir: o.dir as string, file: o.file as string, root: o.root as string,
    scope: o.scope, kind: o.kind, arguments: args, userInvocable: o.userInvocable, modelInvocable: o.modelInvocable, enabled: o.enabled,
    ...opt("argumentHint"), ...opt("data"), ...opt("plugin"), ...opt("model"), ...opt("effort"), ...list("allowedTools"), ...list("disallowed"),
    ...(f && typeof f === "object" && typeof f.background === "boolean" ? { fork: { background: f.background, ...(typeof f.agent === "string" ? { agent: f.agent } : {}) } } : {}),
  };
}
const readVars = (v: unknown): Record<string, string> => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {});

// How long the last list read from a machine stands in for one that failed: a machine that restarts is
// not a change of skills, and the prompt's block is made again only when its list really changes.
export const LAST_GOOD_MS = 5 * 60_000;

// `session`: the session as the store holds it now (absent: it is gone).
export function peerSkills(f: Fleet, session: (id: string) => Session | undefined, onError: (e: unknown, machine: string) => void, now: () => number = Date.now): (sessionId: string) => SkillHome | null {
  const good = new Map<string, { at: number; skills: Skill[] }>();
  return (sessionId) => {
    const s = session(sessionId);
    if (!s?.machine) return null;
    const m = f.row(s.machine);
    if (!m) {
      const gone = async () => ({ error: "the session's machine was removed from the fleet" });
      return { machine: "its machine", id: s.machine, list: gone, get: gone };
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
      id: m.id,
      list: async () => {
        const r = await ask<{ skills?: unknown }>("/api/fleet/hands/skills");
        if (!("error" in r) && Array.isArray(r.skills)) {
          const skills = r.skills.map(readSkill).filter((k): k is Skill => !!k);
          good.set(s.id, { at: now(), skills });
          if (good.size > 64) good.delete(good.keys().next().value!);
          return { skills };
        }
        const had = good.get(s.id);
        if (had && now() - had.at < LAST_GOOD_MS) return { skills: had.skills };
        return "error" in r ? r : { error: "it answered with no list" };
      },
      get: async (name) => {
        const r: Record<string, unknown> = await ask<Record<string, unknown>>("/api/fleet/hands/skill", { name });
        if (typeof r.error === "string") return { error: r.error };
        if (r.missing && typeof r.missing === "object") {
          const mm = r.missing as { names?: unknown; held?: unknown };
          return { missing: { names: strs(mm.names) ?? [], ...(typeof mm.held === "string" ? { held: mm.held } : {}) } };
        }
        const skill = readSkill(r.skill);
        if (!skill || typeof r.raw !== "string") return { error: "it answered with a skill this machine cannot read" };
        return { skill, raw: r.raw, vars: readVars(r.vars) };
      },
    };
  };
}
