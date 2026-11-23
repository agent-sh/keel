// The session's fallback model: when the model declines a request, the turn
// goes on once on this one, which then stays the session's model; when the
// model stays overloaded, that turn goes on on this one and the next turn
// tries the session's model first (src/engine/retry.ts movesToFallback). Shown in
// the message box's bar while it is set (or being chosen); set from a refusal
// card, /fallback or the palette.
import { CornerDownRight, X } from "lucide-react";
import { useSyncExternalStore, memo } from "react";
import { actions, reportError, useStore } from "../lib/store.ts";
import { ModelPicker } from "./ModelPicker.tsx";

// A request from the palette or /fallback to choose one: the chip shows with its picker open.
let choosing: { sid: string; n: number } | null = null;
const subs = new Set<() => void>();
export function chooseFallback(sid: string) {
  choosing = { sid, n: (choosing?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}
const useChoosing = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => choosing);

const done = () => { choosing = null; subs.forEach((f) => f()); };
export const setFallback = (sid: string, model: string | null) => actions.patch(sid, { settings: { fallback: model } }).finally(done);

export const FallbackChip = memo(function FallbackChip({ sessionId }: { sessionId: string }) {
  const ch = useChoosing();
  const fb = useStore((s) => s.sessions[sessionId]?.settings.fallback as string | undefined);
  const open = ch?.sid === sessionId;
  if (!fb && !open) return null;
  return (
    <span className="inline-flex h-8 items-center rounded-md text-caption text-faint" data-testid="fallback-chip" title="If the model declines a request, the turn goes on on this model, which then stays. If the model stays overloaded, that turn goes on on this model and the next one tries the session's model first.">
      <CornerDownRight className="ml-1 size-3.5" />
      <span className="pl-1 max-md:hidden">Fallback</span>
      <ModelPicker compact value={fb ?? ""} openSignal={open ? ch!.n : undefined} onChange={(m) => setFallback(sessionId, m).catch(reportError)} />
      {(fb || open) && (
        <button type="button" aria-label="No fallback model" title="No fallback model" onClick={() => (fb ? setFallback(sessionId, null).catch(reportError) : done())} className="grid size-6 place-items-center rounded-sm hover:bg-hover hover:text-fg">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
});
