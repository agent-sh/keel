// A session's dollar cap in its header: a chip with what was spent of it while one is set, and the
// button that sets one while none is. Its popup has the rate of the last ten minutes, what an hour of
// it comes to, and the one press that raises a cap (src/automation/cap-rules.ts says what each is).
import { Popover } from "@base-ui/react/popover";
import { Gauge } from "lucide-react";
import { useState } from "react";
import { capLine, dollars, raisedCap } from "../../../src/automation/cap-rules.ts";
import type { Session } from "../../../src/core/types.ts";
import { raiseCap, setCap, useCap } from "../lib/caps.ts";
import { composing } from "../lib/keys.ts";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { iconButton, popupClass } from "./ui.tsx";

const TONE = { ok: "text-muted", warn: "text-warn", spent: "text-danger" } as const;
const BAR = { ok: "bg-accent", warn: "bg-warn", spent: "bg-danger" } as const;

export function CapControl({ session }: { session: Session }) {
  const cap = useCap(session.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<unknown>) => { setBusy(true); f().catch(reportError).finally(() => setBusy(false)); };
  const give = () => {
    const usd = Number(text.replace(/^\$/, ""));
    if (!Number.isFinite(usd) || usd <= 0) return;
    setText("");
    run(() => setCap(session.id, usd));
  };
  const who = session.parent_id ? "This agent" : "This session";
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid={cap ? "cap-chip" : "cap-set"}
        data-level={cap?.level}
        title={cap ? undefined : "Set a dollar cap for this session and everything it starts"}
        aria-label={cap ? `Dollar cap: ${capLine(cap)}` : "Set a dollar cap"}
        className={cap
          ? cn("k-head-cap inline-flex h-7 items-center gap-1 rounded-md px-2 text-caption tabular-nums outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-hover", TONE[cap.level])
          : cn(iconButton, "size-7")}
      >
        <Gauge className="size-3.5" aria-hidden="true" />
        {cap && <span data-testid="cap-figure">{dollars(cap.spent)} of {dollars(cap.usd)}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className={cn(popupClass, "w-[min(22rem,calc(100vw-1.5rem))] p-3")} data-testid="cap-popup">
            <div className="text-ui font-medium">Dollar cap</div>
            <div className="mt-0.5 text-caption text-muted">{who} and everything it starts. {cap ? "" : "Nothing is capped now."}</div>
            {cap && (
              <div className="mt-2 grid gap-1.5" data-testid="cap-facts" data-level={cap.level}>
                <span className="h-1.5 overflow-hidden rounded-full bg-sunken" role="meter" aria-label="Spent of the cap" aria-valuenow={Math.round(cap.pct * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <span className={cn("block h-full rounded-full", BAR[cap.level])} style={{ width: `${Math.max(2, Math.min(100, cap.pct * 100))}%` }} />
                </span>
                <div className="flex justify-between text-caption tabular-nums"><span className="text-muted">Spent</span><span data-testid="cap-spent">{dollars(cap.spent)} of {dollars(cap.usd)} ({Math.floor(cap.pct * 100)}%)</span></div>
                <div className="flex justify-between text-caption tabular-nums"><span className="text-muted">Rate, last 10 minutes</span><span data-testid="cap-burn">{cap.burn_hour > 0 ? `${dollars(cap.burn_hour)} an hour` : "none"}</span></div>
                <div className="flex justify-between text-caption tabular-nums"><span className="text-muted">Spent in an hour at that rate</span><span data-testid="cap-forecast">{dollars(cap.forecast_hour)}</span></div>
                {cap.level === "spent" && <div className="rounded-md border border-danger/40 bg-danger/5 px-2 py-1.5 text-caption text-fg" data-testid="cap-reached">Reached. New steps and new agents wait until the cap is raised; a step that runs finishes.</div>}
                {cap.level === "warn" && <div className="text-caption text-warn" data-testid="cap-near">Past 80 percent of the cap.</div>}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value.replace(/[^0-9.$]/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && !composing(e) && give()}
                inputMode="decimal"
                placeholder={cap ? "New cap in dollars" : "Cap in dollars"}
                aria-label="Cap in dollars"
                data-testid="cap-input"
                className="k-field k-field-sm w-0 flex-1 tabular-nums"
              />
              <button type="button" disabled={busy || !text} onClick={give} data-testid="cap-apply" className="k-btn">{cap ? "Change" : "Set"}</button>
            </div>
            {cap && (
              <div className="mt-2 flex items-center gap-2">
                <button type="button" disabled={busy} onClick={() => run(() => raiseCap(session.id))} data-testid="cap-raise" data-ink={cap.level !== "ok" || undefined} className="k-btn">
                  Raise to {dollars(raisedCap(cap.usd, cap.spent))}
                </button>
                <button type="button" disabled={busy} onClick={() => run(() => setCap(session.id, null))} data-testid="cap-clear" data-quiet="" className="k-btn">Remove</button>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
