// Figures, the same on every surface. A Stat is one figure with its name and
// what stands behind it; Stats is a row of them in one frame divided by
// hairlines (a ledger strip that wraps, never a grid of separate cards). A
// Split answers "where did it go": one bar cut in proportion, each part named
// with its amount and share.
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

// `plain`: the same figures standing on the page itself, with no frame.
export function Stats({ children, testid, className, plain }: { children: ReactNode; testid?: string; className?: string; plain?: boolean }) {
  return (
    <div className={cn("group/stats flex flex-wrap", plain ? "gap-x-10 gap-y-4" : "gap-px overflow-hidden rounded-lg border border-line bg-line shadow-1", className)} data-plain={plain || undefined} data-testid={testid}>{children}</div>
  );
}

export function Stat({ label, value, sub, tone, testid }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger"; testid?: string }) {
  return (
    <div className="min-w-0 flex-[1_1_9.5rem] bg-raised px-4 py-3 group-data-[plain]/stats:bg-transparent group-data-[plain]/stats:p-0" data-stat="" data-testid={testid}>
      <div className="k-truncate text-caption text-muted">{label}</div>
      {/* A figure cut short reads as another figure: the whole one is its tooltip. */}
      <div className={cn("mt-1 k-truncate text-title font-semibold tabular-nums", tone === "danger" && "text-danger")} title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}>{value}</div>
      {/* On the page itself the line under a figure is read whole; in a framed strip it keeps to one line. */}
      {sub && <div className="mt-0.5 k-truncate text-caption text-faint group-data-[plain]/stats:whitespace-normal" title={typeof sub === "string" ? sub : undefined}>{sub}</div>}
    </div>
  );
}

// `value` is what the bar is cut by; `also` is the same part in another measure
// (its tokens beside its cost), shown but not drawn.
export type Part = { label: string; value: number; color: string; testid?: string; also?: string };

// The colors of a prompt's parts, the same in every bar and chart.
export const PART = { read: "var(--series-1)", written: "var(--faint)", full: "var(--series-2)", output: "var(--series-3)" } as const;

export function SplitBar({ parts, max, className }: { parts: Part[]; max?: number; className?: string }) {
  const total = max ?? parts.reduce((n, p) => n + p.value, 0);
  return (
    <div className={cn("flex h-2 w-full gap-px overflow-hidden rounded-full bg-sunken", className)} aria-hidden>
      {parts.map((p) => (p.value > 0 ? <div key={p.label} style={{ width: `${total ? (100 * p.value) / total : 0}%`, background: p.color }} /> : null))}
    </div>
  );
}

// `heads` names the columns (the amount, the other measure, what the share is of),
// so a percentage always says its denominator.
export function Split({ parts, format, heads, testid }: { parts: Part[]; format: (v: number) => string; heads?: [string, string, string]; testid?: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const pct = (v: number) => (total ? `${v > 0 && v / total < 0.01 ? "<1" : Math.round((100 * v) / total)}%` : "0%");
  const also = parts.some((p) => p.also !== undefined);
  return (
    // The other measure is a column of its own where the split has the width for it.
    <div className="@container" data-testid={testid}>
      <SplitBar parts={parts} className="h-2.5" />
      <dl className={cn("mt-2.5 grid grid-cols-[auto_1fr_auto_auto] items-baseline gap-x-3 gap-y-1 text-ui", also && "@[19rem]:grid-cols-[auto_1fr_auto_auto_auto]")}>
        {heads && (
          <div className="contents text-micro text-faint" aria-hidden>
            <span /><span />
            <span className="text-right">{heads[0]}</span>
            {also && <span className="hidden text-right @[19rem]:block">{heads[1]}</span>}
            <span className="text-right">{heads[2]}</span>
          </div>
        )}
        {parts.map((p) => (
          <div key={p.label} className="contents" data-testid={p.testid}>
            <span className="size-2 translate-y-[-1px] rounded-xs" style={{ background: p.color }} aria-hidden />
            <dt className="min-w-0 k-truncate text-muted">{p.label}</dt>
            <dd className="text-right font-medium tabular-nums">{format(p.value)}</dd>
            {also && <dd className="hidden text-right text-caption tabular-nums text-muted @[19rem]:block">{p.also}</dd>}
            <dd className="min-w-10 text-right text-caption tabular-nums text-faint">{pct(p.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
