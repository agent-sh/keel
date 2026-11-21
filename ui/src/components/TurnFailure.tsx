// The box a failed turn leaves in the transcript: what failed, and what
// happens next. A turn the provider asked to wait long for continues by
// itself when the wait is over; the box says when, counts down, and lets the
// owner go on now or call it off.
import { CircleAlert, Clock, Play } from "lucide-react";
import type { Session, StoredEvent } from "../../../src/core/types.ts";
import { actions, reportError } from "../lib/store.ts";
import { fmtWait } from "../lib/utils.ts";
import { useNow } from "./Mark.tsx";

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const button = "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

export function TurnFailure({ e, s }: { e: StoredEvent; s: Session }) {
  // Set while the session will go on by itself after this failure, and it is still the last thing in it.
  const due = s.settings.continue_at?.after === e.id ? s.settings.continue_at.at : undefined;
  const now = useNow(due !== undefined);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-ui" data-testid="turn-error" data-event-id={e.id}>
      <div className="flex items-start gap-2.5 text-danger">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="whitespace-pre-wrap break-words">{e.data.message}</span>
      </div>
      {due !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[1.625rem] text-fg" data-testid="continue-at">
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5 shrink-0 text-muted" />
            <span>Continues by itself at <span className="font-medium tabular-nums">{clock(due)}</span></span>
            <span className="tabular-nums text-muted" data-testid="continue-in">{due > now ? `in ${fmtWait(due - now)}` : "now"}</span>
          </span>
          <span className="flex items-center gap-1">
            <button type="button" data-testid="continue-now" className={`${button} bg-accent text-accent-fg hover:bg-accent-hover`} onClick={() => actions.resume(s.id).catch(reportError)}>
              <Play className="size-3" /> Continue now
            </button>
            <button type="button" data-testid="continue-cancel" className={`${button} text-muted hover:bg-hover hover:text-fg`} onClick={() => actions.cancelContinue(s.id).catch(reportError)}>
              Do not continue
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
