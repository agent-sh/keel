// What an inline skill sets for the rest of the turn that loaded it, besides
// its allowed-tools grant (Claude Code's skills frontmatter,
// code.claude.com/docs/en/skills): the model and the effort the turn's next
// requests run at, and the tools it takes out of the turn (disallowed-tools:
// a skill can only narrow what runs, never widen it). It holds as the grant does (src/safety/gate.ts grantTurn):
// from the moment the skill loads to the end of the turn, or to the owner's
// next message, whichever comes first. The session's own model and effort are
// never changed. Kept in memory: a restart ends it with the turn.
import { registerHooks } from "../engine/hooks.ts";

// `wider`: the model may be on another provider than the session's (the
// owner's own skill, a plugin's, a repository's the owner trusts himself).
// `next`: the owner's /command that starts a turn: it holds from that turn's
// start. `cmd`: the command's own text, the message that is not the owner's next one.
// `disallowed`: each rule (`Tool` or `Tool(pattern)`) with the skill that named it.
export type TurnChoice = { model?: string; effort?: string; from: string; wider: boolean; disallowed: { rule: string; skill: string }[]; next: boolean; cmd?: string };

const held = new Map<string, TurnChoice>();

// A second skill in the same turn: what it names wins, what it does not name stays.
// What it takes out adds to what the first took out.
export function holdChoice(sessionId: string, set: { model?: string; effort?: string; disallowed?: string[] }, from: string, wider: boolean, next: boolean, cmd?: string) {
  if (!set.model && !set.effort && !set.disallowed?.length) return;
  const had = held.get(sessionId);
  const keep = had && had.next === next ? had : undefined;
  const model = set.model ?? keep?.model;
  const out = [...(keep?.disallowed ?? [])];
  for (const rule of set.disallowed ?? []) if (!out.some((d) => d.rule === rule)) out.push({ rule, skill: from });
  held.set(sessionId, {
    disallowed: out,
    ...(model ? { model } : {}),
    ...(set.effort ?? keep?.effort ? { effort: set.effort ?? keep?.effort } : {}),
    from: set.model || !keep ? from : keep.from,
    wider: set.model ? wider : (keep?.wider ?? wider),
    next,
    ...(cmd ? { cmd } : {}),
  });
}

// What holds for the turn now (none for a command whose turn has not started).
export function choiceOf(sessionId: string): TurnChoice | undefined {
  const c = held.get(sessionId);
  return c && !c.next ? c : undefined;
}

export function dropChoice(sessionId: string) { held.delete(sessionId); }

export function choiceTurnBegan(sessionId: string) {
  const c = held.get(sessionId);
  if (c?.next) c.next = false;
}

// The owner's message reached the session: the choice ends with it, unless it is the command that made it.
export function choiceOwnerSaid(sessionId: string, text: string) {
  const c = held.get(sessionId);
  if (!c) return;
  if (c.cmd !== undefined && c.cmd === text.trim()) { c.cmd = undefined; return; }
  held.delete(sessionId);
}

// Why a call is refused under the turn's disallowed-tools, or nothing. `names`: every name the call
// answers to (namesOf in src/integrations/hooks.ts), matched with no case as agents' disallowed
// tools are; a rule with a pattern is decided by `holds` (a hook's `if`: a shell command, a file's path).
// (The daemon asks it before every call: src/server/routes/hooks.ts.)
export function disallowedWhy(sessionId: string, names: string[], holds: (rule: string) => boolean): string | undefined {
  const c = choiceOf(sessionId);
  if (!c?.disallowed.length) return undefined;
  const lower = names.map((n) => n.toLowerCase());
  for (const d of c.disallowed) {
    const rule = d.rule.trim();
    if (/^[\w.-]+$/.test(rule) ? lower.includes(rule.toLowerCase()) : holds(rule))
      return `${names[0]} is not allowed while the skill ${d.skill} is active: its disallowed-tools name ${d.rule}. That holds until the end of this turn.`;
  }
  return undefined;
}

registerHooks({
  turnStart: (s) => choiceTurnBegan(s.id),
  turnEnd: (s) => dropChoice(s.id),
  turnChoice: (s) => {
    const c = choiceOf(s.id);
    return c ? { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), from: c.from, wider: c.wider } : undefined;
  },
});
