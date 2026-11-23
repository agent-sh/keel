// Where the session's time went, at the head of its timeline: the tree's
// bottleneck as one line, and opened, its wall time by class along the
// critical path (one bar, then each class with its time and share) and each
// agent's own split. Read from GET /api/sessions/:id/hours (src/admin/hours-rows.ts).
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CRITICAL_RULE, HOUR_SHORT, HOUR_WORDS, INFERRED_WORDS, mostlyInferred, ranked, sourcesPhrase, type ClassMs, type HourClass, type TreeHours } from "../../../src/admin/hours-rows.ts";
import { dur } from "../../../src/admin/timeline-rows.ts";
import { openSession } from "../lib/automation.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

const color = (c: HourClass) => `var(--hour-${c})`;
const share = (ms: number, whole: number) => (whole > 0 ? `${Math.round((100 * ms) / whole)}%` : "");

// One bar of a split: each class its width, the largest first; the part of
// a class that no record covers (read from what started the next turn) hatched.
function Bar({ parts, inferred, whole, tall }: { parts: [HourClass, number][]; inferred: ClassMs; whole: number; tall?: boolean }) {
  return (
    <div className={cn("flex w-full overflow-hidden rounded-full bg-sunken", tall ? "h-2" : "h-1.5")} aria-hidden>
      {parts.flatMap(([c, ms]) => {
        const guess = Math.min(ms, inferred[c] ?? 0);
        return [
          ms > guess ? <span key={c} className="h-full" style={{ width: `${(100 * (ms - guess)) / whole}%`, background: color(c) }} /> : null,
          guess > 0 ? <span key={`${c}-inferred`} className="k-hour-inferred h-full" data-testid="hours-bar-inferred" style={{ width: `${(100 * guess) / whole}%`, backgroundColor: color(c) }} /> : null,
        ];
      })}
    </div>
  );
}

export function Hours({ sessionId }: { sessionId: string }) {
  const [t, setT] = useState<TreeHours | null>(null);
  const [open, setOpen] = useState(false);
  // Read again when a turn of the session ends or starts, and when it is opened.
  const status = useStore((s) => s.status[sessionId]?.kind ?? "");
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    api<TreeHours>(`/api/sessions/${encodeURIComponent(sessionId)}/hours`).then((r) => { if (n === seq.current) setT(r); }).catch((e) => reportError(e, { at: "hours" }));
  }, [sessionId, status, open]);
  if (!t || !t.wall_ms) return null;
  const parts = ranked(t.classes);
  const agents = t.members.filter((m) => m.depth > 0).sort((a, b) => b.wall_ms - a.wall_ms);
  return (
    <section className="shrink-0 border-b border-line" aria-label="Where the time went" data-testid="hours" data-top={t.top ?? ""}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]" data-testid="hours-toggle">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} aria-hidden />
        <span className="shrink-0 text-caption font-medium text-fg">Where the time went</span>
        <span className={cn("min-w-0 flex-1 text-caption text-muted", !open && "truncate")} data-testid="hours-line" title={`${t.line} ${CRITICAL_RULE}`}>{t.line}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3" data-testid="hours-detail">
          <div className="flex flex-col gap-1.5">
            <Bar parts={parts} inferred={t.inferred_ms} whole={t.wall_ms} tall />
            <div className="flex flex-wrap items-baseline gap-x-2 text-micro text-faint">
              <span data-testid="hours-rule">{t.agents ? `Along the critical path of this session and ${t.agents} ${t.agents === 1 ? "agent" : "agents"}: while it waits for its agents, the time counts as the agent that ends last, and so on down.` : "Every moment of this session, once."}</span>
              <span className="tabular-nums" data-testid="hours-accounted">{sourcesPhrase(t)}</span>
              {t.inferred > 0 && (
                <span className="inline-flex items-center gap-1" title={`Hatched: ${INFERRED_WORDS}, as no record covers it.`}>
                  <span className="k-hour-inferred size-2 self-center rounded-xs" style={{ backgroundColor: "var(--line-strong)" }} aria-hidden />inferred
                </span>
              )}
            </div>
          </div>
          <ul className="grid grid-cols-[0.625rem_minmax(0,1fr)_auto_2.75rem] items-baseline gap-x-2 gap-y-1 text-caption" data-testid="hours-classes">
            {parts.map(([c, ms]) => {
              const guess = mostlyInferred(t, c);
              return (
              <li key={c} className="contents" data-testid="hours-class" data-class={c} data-inferred={guess ? "" : undefined}>
                <span className={cn("size-2.5 self-center rounded-xs", guess && "k-hour-inferred")} style={{ backgroundColor: color(c) }} aria-hidden />
                <span className={cn("min-w-0 truncate", c === t.top ? "text-fg" : "text-muted")} title={guess ? `Mostly ${INFERRED_WORDS}: no record covers it.` : undefined}>
                  {HOUR_WORDS[c].charAt(0).toUpperCase() + HOUR_WORDS[c].slice(1)}{guess && <span className="text-faint" data-testid="hours-class-inferred">, inferred</span>}
                </span>
                <span className="text-right k-face-figure text-muted">{dur(ms)}</span>
                <span className="text-right k-face-figure text-faint">{share(ms, t.wall_ms)}</span>
              </li>
              );
            })}
          </ul>
          {agents.length > 0 && (
            <div className="flex flex-col gap-1" data-testid="hours-agents">
              <div className="text-micro text-faint">Each agent's own time{agents.length > 8 ? `, the 8 longest of ${agents.length}` : ""}</div>
              {agents.slice(0, 8).map((m) => {
                const own = ranked(m.classes);
                return (
                  <button key={m.session_id} type="button" onClick={() => openSession(m.session_id)} title={own.map(([c, ms]) => `${HOUR_SHORT[c]} ${dur(ms)}${mostlyInferred(m, c) ? " (inferred)" : ""}`).join(", ")}
                    className="-mx-1.5 grid grid-cols-[minmax(0,1fr)_7rem_3.5rem] items-center gap-x-3 rounded-sm px-1.5 py-0.5 text-left text-caption hover:bg-hover max-sm:grid-cols-[minmax(0,1fr)_4.5rem_3.25rem]" data-testid="hours-agent">
                    <span className="min-w-0 truncate text-muted" style={{ paddingLeft: `${(m.depth - 1) * 0.75}rem` }}>{m.title}</span>
                    {m.wall_ms ? <Bar parts={own} inferred={m.inferred_ms} whole={m.wall_ms} /> : <span />}
                    <span className="text-right k-face-figure text-faint">{dur(m.wall_ms)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
