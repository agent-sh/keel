// A small time chart in plain SVG: lines (2px, gaps where no bucket had data)
// or stacked bars (2px surface gap, 4px rounded top). One y-axis, recessive
// grid, a legend for two or more series, and a crosshair readout of every
// series at the bucket under the pointer or the focused bucket. The readout
// never leaves the chart's width: it stands beside the crosshair when there
// is room on that side. When there is not (a phone, a long series name) it is
// as wide as it needs and no wider than the chart, over the plot's top edge,
// where a finger on the plot does not cover it and the plot stays readable;
// or, when the pane shows too little above the plot for it, inside the plot's
// top, so it is never cut off by what scrolls the chart.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";

export type Series = { label: string; color: string };
export type Point = { t: number; values: (number | null)[] };

const PAD = { top: 8, right: 12, bottom: 22, left: 52 };

// A round step (1, 2 or 5 times a power of ten) that covers v in at most four.
function niceStep(v: number): number {
  if (v <= 0) return 0.25;
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

const timeLabel = (t: number, span: number) =>
  span > 2 * 86_400_000
    ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const fullTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function TimeChart({
  data, series, bucket, since, until, kind = "line", format, max, height = 180, label, unit = 1,
}: {
  data: Point[]; series: Series[]; bucket: number; since: number; until: number;
  kind?: "line" | "bars"; format: (v: number) => string; max?: number; height?: number; label: string;
  unit?: number; // ticks step in round multiples of this (1024 * 1024 for MB)
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  // The width it has, before the first paint: a chart never draws wider than its place.
  useLayoutEffect(() => { if (box.current) setW(Math.max(160, Math.floor(box.current.clientWidth))); }, []);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(160, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t0 = Math.floor(since / bucket) * bucket;
  const t1 = Math.max(t0 + bucket, Math.ceil(until / bucket) * bucket);
  const iw = w - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * iw;
  const slot = (bucket / (t1 - t0)) * iw;
  const top = (p: Point) => (kind === "bars" ? p.values.reduce<number>((n, v) => n + (v ?? 0), 0) : Math.max(0, ...p.values.map((v) => v ?? 0)));
  const step = max ? max / 4 : niceStep(Math.max(0, ...data.map(top)) / unit) * unit;
  const yMax = max ?? Math.max(step, Math.ceil(Math.max(0, ...data.map(top)) / step) * step);
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;
  const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => i * step);
  const xTicks = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  const center = (p: Point) => (kind === "bars" ? x(p.t) + slot / 2 : x(p.t) + slot / 2);

  const lines = series.map((_, si) => {
    const segs: string[] = [];
    let prev: Point | null = null;
    for (const p of data) {
      const v = p.values[si];
      if (v === null || v === undefined) { prev = null; continue; }
      const cmd = prev && p.t - prev.t === bucket && prev.values[si] != null ? "L" : "M";
      segs.push(`${cmd}${center(p).toFixed(1)},${y(v).toFixed(1)}`);
      prev = p;
    }
    return segs.join("");
  });
  const lonely = (si: number, i: number) => {
    const p = data[i]!, a = data[i - 1], b = data[i + 1];
    const has = (q?: Point) => q && q.values[si] != null && Math.abs(q.t - p.t) === bucket;
    return p.values[si] != null && !has(a) && !has(b);
  };

  const hp = hover === null ? null : data[hover];
  // Where the readout goes, from its measured size. Distances are rem, read in
  // pixels at the owner's text size.
  const tip = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; at: "beside" | "above" | "over" } | null>(null);
  useLayoutEffect(() => {
    const el = tip.current, plot = box.current;
    if (!el || !plot || !hp) return setPlace(null);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const tw = el.offsetWidth, c = center(hp), gap = 0.75 * rem;
    const beside = c > w / 2 ? c - gap - tw : c + gap;
    let at: "beside" | "above" | "over" = "beside", left = beside;
    if (beside < 0 || beside + tw > w) {
      left = Math.max(0, Math.min(w - tw, c - tw / 2));
      // What is on screen above the plot: down to the nearest edge that clips it.
      let edge = 0;
      for (let a = plot.parentElement; a; a = a.parentElement) {
        if (getComputedStyle(a).overflowY !== "visible") edge = Math.max(edge, a.getBoundingClientRect().top);
      }
      at = plot.getBoundingClientRect().top - edge >= el.offsetHeight + 0.5 * rem ? "above" : "over";
    }
    setPlace((p) => (p && p.left === left && p.at === at ? p : { left, at }));
  });
  const move = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const px = clientX - r.left;
    let best = -1, bd = Infinity;
    data.forEach((p, i) => { const d = Math.abs(center(p) - px); if (d < bd) { bd = d; best = i; } });
    setHover(best >= 0 && bd < Math.max(24, slot) ? best : null);
  };

  return (
    <figure className="m-0" aria-label={label}>
      {series.length > 1 && (
        <figcaption className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5">
              {kind === "bars"
                ? <span className="size-2.5 rounded-xs" style={{ background: s.color }} />
                : <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />}
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <div
        ref={box}
        className="relative outline-none"
        style={{ height }}
        tabIndex={0}
        onPointerMove={(e) => move(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setHover((h) => Math.max(0, Math.min(data.length - 1, (h ?? (e.key === "ArrowLeft" ? data.length : -1)) + (e.key === "ArrowLeft" ? -1 : 1))));
        }}
      >
        <svg width={w} height={height} className="block overflow-visible" role="img" aria-label={label}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} strokeDasharray={v === 0 ? undefined : "2 4"} />
              <text x={PAD.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="fill-faint text-micro tabular-nums">{v === 0 ? "0" : format(v)}</text>
            </g>
          ))}
          {Array.from({ length: xTicks }, (_, i) => t0 + ((t1 - t0) * i) / (xTicks - 1)).map((t, i) => (
            <text key={t} x={x(t)} y={height - 6} textAnchor={i === 0 ? "start" : i === xTicks - 1 ? "end" : "middle"} className="fill-faint text-micro tabular-nums">
              {timeLabel(t, t1 - t0)}
            </text>
          ))}
          {hp && <line x1={center(hp)} x2={center(hp)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--line-strong)" strokeWidth={1} />}
          {kind === "line" && series.map((s, si) => (
            <g key={s.label}>
              <path d={lines[si]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {data.map((p, i) => lonely(si, i) && <circle key={p.t} cx={center(p)} cy={y(p.values[si]!)} r={3} fill={s.color} />)}
              {hp && hp.values[si] != null && <circle cx={center(hp)} cy={y(hp.values[si]!)} r={4.5} fill={s.color} stroke="var(--raised)" strokeWidth={2} />}
            </g>
          ))}
          {kind === "bars" && data.map((p, i) => {
            const bw = Math.max(2, Math.min(28, slot * 0.7));
            const bx = x(p.t) + (slot - bw) / 2;
            let acc = 0;
            const segs = p.values.map((v, si) => ({ v: v ?? 0, si })).filter((s) => s.v > 0);
            return (
              <g key={p.t} opacity={hover === null || hover === i ? 1 : 0.55}>
                {segs.map(({ v, si }, k) => {
                  const yb = y(acc), yt = y(acc + v);
                  acc += v;
                  const h = Math.max(0, yb - yt - (k ? 2 : 0)); // 2px surface gap between segments
                  const r = k === segs.length - 1 ? Math.min(4, bw / 2, h) : 0;
                  const top = yb - (k ? 2 : 0) - h;
                  const d = `M${bx},${top + h}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${top + h}Z`;
                  return <path key={si} d={d} fill={series[si]!.color} />;
                })}
              </g>
            );
          })}
        </svg>
        {hp && (
          <div
            ref={tip}
            className={cn("pointer-events-none absolute z-10 w-max min-w-[min(9rem,100%)] max-w-full rounded-md border border-line bg-raised px-2.5 py-2 text-caption shadow-2", place?.at === "above" ? "bottom-[calc(100%+0.25rem)]" : "top-1")}
            style={{ left: place?.left ?? 0, visibility: place ? undefined : "hidden" }}
            data-testid="chart-tooltip"
            data-at={place?.at}
          >
            <div className="mb-1 text-micro text-faint">{fullTime(hp.t)}</div>
            {series.map((s, si) => (
              <div key={s.label} className="flex items-baseline gap-2">
                <span className="h-0.5 w-2.5 shrink-0 -translate-y-1 rounded-full" style={{ background: s.color }} />
                <span className="shrink-0 font-medium tabular-nums text-fg">{hp.values[si] == null ? "none" : format(hp.values[si]!)}</span>
                <span className="min-w-0 text-muted">{s.label}</span>
              </div>
            ))}
          </div>
        )}
        {!data.length && <div className="absolute inset-0 grid place-items-center text-ui text-faint">Nothing in this range.</div>}
      </div>
    </figure>
  );
}
