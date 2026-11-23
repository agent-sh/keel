// What an inline skill sets for the rest of the turn that loaded it, besides
// its allowed-tools grant (Claude Code's skills frontmatter,
// code.claude.com/docs/en/skills): the model and the effort the turn's next
// requests run at. It holds as the grant does (src/safety/gate.ts grantTurn):
// from the moment the skill loads to the end of the turn, or to the owner's
// next message, whichever comes first. The session's own model and effort are
// never changed. Kept in memory: a restart ends it with the turn.
import { registerHooks } from "../engine/hooks.ts";

// `wider`: the model may be on another provider than the session's (the
// owner's own skill, a plugin's, a repository's the owner trusts himself).
// `next`: the owner's /command that starts a turn: it holds from that turn's
// start. `cmd`: the command's own text, the message that is not the owner's next one.
export type TurnChoice = { model?: string; effort?: string; from: string; wider: boolean; next: boolean; cmd?: string };

const held = new Map<string, TurnChoice>();

// A second skill in the same turn: what it names wins, what it does not name stays.
export function holdChoice(sessionId: string, set: { model?: string; effort?: string }, from: string, wider: boolean, next: boolean, cmd?: string) {
  if (!set.model && !set.effort) return;
  const had = held.get(sessionId);
  const keep = had && had.next === next ? had : undefined;
  const model = set.model ?? keep?.model;
  held.set(sessionId, {
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

registerHooks({
  turnStart: (s) => choiceTurnBegan(s.id),
  turnEnd: (s) => dropChoice(s.id),
  turnChoice: (s) => {
    const c = choiceOf(s.id);
    return c ? { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), from: c.from, wider: c.wider } : undefined;
  },
});
