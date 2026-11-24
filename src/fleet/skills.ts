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

// A machine's answer is read for the fields a skill has, each of the shape it has and within a bound: a
// malformed entry is left out (one bad entry is not the list's failure). What a skill may do here (its
// allowed-tools, model, effort, fork, hooks) is never read from the machine's object: a skill of another
// machine grants nothing on this one (src/tools/skills.ts adoptPeer), and only its text is read.
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1_536;
export const SKILLS_MAX = 300; // a list longer than this is cut: the listing's budget is a few thousand characters
export const RAW_MAX = 1_000_000; // a skill's text, as the local scan reads one at most
const PATH_MAX = 4_096;
// What a local skill's name is held to (src/tools/skills.ts discoverSkills rejects < > and a zero-width space), and no
// whitespace or control character at all: a name is one word that sits in a line of the prompt.
export const goodName = (n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= NAME_MAX && !/[\s\p{Cc}\p{Cf}<>\u200b-\u200f\u2028\u2029\ufeff]/u.test(n);
const strs = (v: unknown, max = 32, each = NAME_MAX): string[] | undefined => (Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= each) ? (v as string[]) : undefined);
export function readSkill(x: unknown): Skill | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  for (const k of ["description", "dir", "file", "root"]) if (typeof o[k] !== "string" || (o[k] as string).length > (k === "description" ? 100_000 : PATH_MAX)) return null;
  if (!goodName(o.name) || (o.scope !== "personal" && o.scope !== "project" && o.scope !== "plugin")) return null;
  if (o.kind !== "skill" && o.kind !== "command") return null;
  const args = strs(o.arguments);
  if (!args || typeof o.userInvocable !== "boolean" || typeof o.modelInvocable !== "boolean" || typeof o.enabled !== "boolean") return null;
  return {
    name: o.name, description: (o.description as string).slice(0, DESCRIPTION_MAX), dir: o.dir as string, file: o.file as string, root: o.root as string,
    scope: o.scope, kind: o.kind, arguments: args, userInvocable: o.userInvocable, modelInvocable: o.modelInvocable, enabled: o.enabled,
    ...(typeof o.argumentHint === "string" && o.argumentHint.length <= 200 ? { argumentHint: o.argumentHint } : {}),
  };
}
// Only the variables a skill's text may name, each bounded: whatever else a machine sends is not put anywhere.
const VAR = /^(CLAUDE_SKILL_DIR|KEEL_SKILL_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|KEEL_SESSION_ID|user_config\.[A-Za-z0-9_.-]{1,64})$/;
const readVars = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => VAR.test(e[0]) && typeof e[1] === "string" && e[1].length <= PATH_MAX).slice(0, 32)) : {};

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
          const seen = new Set<string>();
          const skills = r.skills.map(readSkill).filter((k): k is Skill => !!k && !seen.has(k.name) && !!seen.add(k.name)).slice(0, SKILLS_MAX);
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
        if (r.raw.length > RAW_MAX) return { error: "its text is longer than this machine reads" };
        // The one asked for (the name may carry the slash the owner typed).
        if (skill.name !== name && skill.name !== name.replace(/^\//, "")) return { error: "it answered with another skill than the one asked for" };
        return { skill, raw: r.raw, vars: readVars(r.vars) };
      },
    };
  };
}
