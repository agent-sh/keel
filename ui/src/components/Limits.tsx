// Rate-limit and plan windows, and the account problems that stop turns: a
// meter per window (Settings > Providers), and a chip beside the model picker
// when the session's provider is close to a limit or refuses turns.
import { Popover } from "@base-ui/react/popover";
import { AlertTriangle, ExternalLink, Gauge } from "lucide-react";
import { useEffect, memo } from "react";
import { actions, reportError, useStore, type LimitWindow, type ProviderProblem, type RouteProblem } from "../lib/store.ts";
import { cn, fmtCost, when } from "../lib/utils.ts";
import { popupClass } from "./ui.tsx";

export function fmtUntil(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const amount = (n: number, unit?: LimitWindow["unit"]) =>
  unit === "usd" ? fmtCost(n) : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);

export function WindowMeter({ w, closeAt = 80 }: { w: LimitWindow; closeAt?: number }) {
  const pct = w.used_percent;
  const tone = pct === undefined ? "" : pct >= 100 ? "bg-danger" : pct >= closeAt ? "bg-warn" : "bg-accent";
  const facts = [
    pct !== undefined ? `${Math.round(pct)}% used` : undefined,
    w.remaining !== undefined ? `${amount(w.remaining, w.unit)}${w.limit !== undefined ? ` of ${amount(w.limit, w.unit)}` : ""} left` : undefined,
    w.spent_usd !== undefined ? fmtCost(w.spent_usd) : undefined,
    w.note,
  ].filter(Boolean);
  return (
    <div className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 py-1 text-caption" data-testid="limit-window" data-window={`${w.provider}:${w.id}`}>
      <span className="truncate text-muted" title={w.label}>{w.label}</span>
      {pct !== undefined ? (
        <span className="h-1.5 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={w.label}>
          <span className={cn("block h-full rounded-full", tone)} style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
        </span>
      ) : <span />}
      <span className="whitespace-nowrap tabular-nums text-faint">
        {facts.join(" · ")}
        {w.resets_at_ms ? <span title={when(w.resets_at_ms)}> · resets in {fmtUntil(w.resets_at_ms)}</span> : null}
      </span>
    </div>
  );
}

// What the owner can do about an account state, said once.
export function ProblemNote({ p, label, detail }: { p: ProviderProblem; label: string; detail?: string }) {
  const text = p.kind === "billing"
    ? `${label} refuses turns until its billing is settled. Its models stay listed; pick another provider meanwhile.`
    : `${label} refuses the credential${detail ? ` (${detail})` : ""}. Put a valid one there, then read the listings again.`;
  return (
    <div className={cn("mt-1.5 rounded-md border px-2.5 py-2 text-caption", p.kind === "billing" ? "border-warn/40 bg-warn/5" : "border-danger/40 bg-danger/5")} data-testid="provider-problem" data-kind={p.kind}>
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <AlertTriangle className={cn("size-3.5", p.kind === "billing" ? "text-warn" : "text-danger")} />
        {p.kind === "billing" ? "Billing" : "Credential refused"}
        {p.link && (
          <a className="ml-auto inline-flex items-center gap-1 font-normal text-accent-ink hover:underline" href={p.link} target="_blank" rel="noreferrer">
            {p.kind === "billing" ? "Open billing" : "Open the provider page"} <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="mt-0.5 text-muted">{text}</div>
      <div className="mt-0.5 break-words text-faint" title={when(p.at)}>{p.message}</div>
    </div>
  );
}

// One route of a provider, or one model, its account refuses: new work passes it over until its
// time passes, then its next request clears the mark or marks it again for longer.
export function RouteProblemNote({ p, provider }: { p: RouteProblem; provider: string }) {
  const model = p.route.startsWith("model:");
  const id = model ? p.route.slice(6) : p.route;
  const part = id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id;
  const head = p.kind === "billing" ? "Billing" : p.kind === "access" ? "Model refused" : "Sign-in refused";
  const what = p.kind === "billing" ? "is out of credit or suspended" : p.kind === "access" ? "is not open to this account" : "refuses its sign-in";
  const left = p.open || !p.until ? "Its time is over: new work goes to it again, and its next request clears this or marks it again." : `New work passes it over for ${fmtUntil(p.until)} more, then its next request decides.`;
  return (
    <div className={cn("mt-1.5 rounded-md border px-2.5 py-2 text-caption", p.open ? "border-line bg-sunken" : p.kind === "billing" ? "border-warn/40 bg-warn/5" : "border-danger/40 bg-danger/5")} data-testid="route-problem" data-route={p.route} data-kind={p.kind} data-open={p.open ? "" : undefined}>
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <AlertTriangle className={cn("size-3.5", p.open ? "text-faint" : p.kind === "billing" ? "text-warn" : "text-danger")} />
        {head}
        <code className="truncate rounded-xs bg-code px-1 font-mono font-normal">{part}</code>
        {p.strikes && p.strikes > 1 ? <span className="font-normal text-faint">{p.strikes} times in a row</span> : null}
        {p.link && (
          <a className="ml-auto inline-flex items-center gap-1 font-normal text-accent-ink hover:underline" href={p.link} target="_blank" rel="noreferrer">
            {p.kind === "billing" ? "Open billing" : "Open the provider page"} <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <div className="mt-0.5 text-muted">{model ? "This model" : "This route"} {what}. {left}</div>
      <div className="mt-0.5 break-words text-faint" title={when(p.at)}>{p.message}</div>
    </div>
  );
}

// Beside the model picker: the session's provider is close to a window or
// refuses turns. Nothing shows while all is well.
export const LimitChip = memo(function LimitChip({ model }: { model: string }) {
  const limits = useStore((s) => s.limits);
  const labels = useStore((s) => s.providerLabels);
  useEffect(() => { actions.loadLimits().catch((e) => reportError(e, { at: "limits" })); }, []);
  const provider = model.slice(0, model.indexOf(":"));
  if (!limits || !provider) return null;
  const problem = limits.problems[provider];
  const close = limits.windows.filter((w) => w.provider === provider && limits.close.includes(`${w.provider}:${w.id}`));
  if (!problem && !close.length) return null;
  const top = close.sort((a, b) => (b.used_percent ?? 0) - (a.used_percent ?? 0))[0];
  const label = labels[provider] ?? provider;
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="limit-chip"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-caption font-medium outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/40",
          problem || (top?.used_percent ?? 0) >= 100 ? "text-danger" : "text-warn",
        )}
      >
        {problem ? <AlertTriangle className="size-3.5" /> : <Gauge className="size-3.5" />}
        {problem ? (problem.kind === "billing" ? "Billing" : "Key refused") : `${Math.round(top!.used_percent!)}% of ${top!.label}`}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className={cn(popupClass, "w-[min(28rem,calc(100vw-1.5rem))] p-3")} data-testid="limit-popup">
            <div className="text-ui font-medium">{label}</div>
            {problem && <ProblemNote p={problem} label={label} />}
            {limits.windows.filter((w) => w.provider === provider).map((w) => <WindowMeter key={w.id} w={w} closeAt={limits.close_percent} />)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
