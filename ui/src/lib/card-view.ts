// A reason that waits on the owner is said once, in its card, while the card is drawn above the message box. The bar, the
// dock's line and the agent's heading say only the state then; they say the reason again when the requests are put away
// with Later (the card is not in view) or when the state has no card of its own.
import { useAway } from "./later.ts";

// The asks whose card the pane draws (src/core/watch.ts names them).
export const CARDED = new Set(["approval", "question", "plan", "secret"]);

export function useCardInView(sessionId: string, st: { watch: string; why?: string }): boolean {
  const away = useAway(sessionId);
  return st.watch === "need" && CARDED.has(st.why ?? "") && away.size === 0;
}
