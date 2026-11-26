// An ended agent's report, read where the owner is: a surface that floats beside the row that opened it (a row of
// the tree in the list, a row of the Agents list), with the way into the agent's session in its head. The page's
// list of agents leaves the reports out, so it is read when this opens, once per end. Loaded when first opened.
import { Popover } from "@base-ui/react/popover";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { seeAgents } from "../../lib/agent-seen.ts";
import { auto, openSession, type AgentRecord } from "../../lib/automation.ts";
import { reportError } from "../../lib/store.ts";
import { ago } from "../../lib/utils.ts";
import { Markdown } from "../Markdown.tsx";
import type { AgentSaid } from "./bits.tsx";

const read = new Map<string, string | null>();

// `anchor`: what it stands beside when that is not the control that opened it (the whole Agents list, so it covers none of its rows).
export function ReportPeek({ a, title, said, side, anchor, done }: { a: AgentRecord; title: string; said: AgentSaid; side: "left" | "right"; anchor?: Element | null; done: () => void }) {
  const key = `${a.id}:${a.ended ?? 0}:${a.tasks}`;
  const [, loaded] = useState(0);
  useEffect(() => {
    // Read here, its end is seen: the row's mark goes.
    seeAgents([a]);
    if (read.has(key)) return;
    let on = true;
    auto.agentReport(a).then((r) => { read.set(key, r); if (on) loaded((n) => n + 1); }).catch(reportError);
    return () => { on = false; };
  }, [key]);
  const report = read.get(key);
  return (
    <Popover.Portal>
      <Popover.Positioner anchor={anchor ?? undefined} side={side} align="start" sideOffset={10} collisionPadding={8} className="z-50 outline-none">
        <Popover.Popup className="k-surface k-report-peek" data-float="" data-testid="report-peek" aria-label={`Report of ${title}`}>
          <div className="k-surface-head">
            <h2 className="k-surface-title">{title}</h2>
            <span className="k-surface-note">{said.phrase}{a.ended ? `, ${ago(a.ended)}` : ""}</span>
            <span className="k-surface-end">
              <button type="button" className="k-btn" data-testid="report-peek-open" onClick={() => { done(); openSession(a.session_id); }}>Open its session<ExternalLink aria-hidden="true" /></button>
            </span>
          </div>
          <div className="k-report-peek-body" data-testid="report-peek-body" aria-busy={report === undefined || undefined}>
            {report === undefined ? null : report ? <Markdown text={report} sessionId={a.machine ? undefined : a.session_id} /> : <p className="k-empty">It ended with no report.</p>}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  );
}
