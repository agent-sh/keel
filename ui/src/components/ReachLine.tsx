import { useReachLine } from "../lib/automation.ts";
import { useToldState } from "../lib/watch.ts";
import { useFocus } from "../lib/focus.ts";

// Under a session's cards while any waits on the owner: where a reminder of it reaches when the owner
// is away, said only when a phone is not among the places (src/automation/reminder-schedule.ts). A phone's
// layout leaves the room to the card; the same words stay in Settings > Alerts.
export function ReachLine({ sessionId }: { sessionId: string }) {
  const line = useReachLine();
  const waits = useToldState(sessionId)?.watch === "need";
  // (Focus says nothing beside the cards: Settings > Alerts has these words.)
  const calm = useFocus();
  if (!line || !waits || calm) return null;
  return <p role="status" data-testid="reach-line" className="mb-1.5 pl-0.5 max-md:hidden text-micro text-faint">{line}</p>;
}
