// The session's speed, offered only when its model's listing (or its route's
// catalog section) sells one besides standard: Fast, Ultrafast, Flex. Each
// option says what it costs: the per-token price against standard, or on a
// plan the provider's own note ("2x speed, increased usage").
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Zap } from "lucide-react";
import type { ModelInfo, Price, SpeedOffer } from "../../../src/providers/types.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";

const per = (p: Price) => `$${+p.input.toFixed(3)} in · $${+p.output.toFixed(3)} out per M`;

// "2x the standard price", or the prices when the ratio is not one number.
function cost(o: SpeedOffer, m: ModelInfo): string | undefined {
  if (!o.price) return o.note;
  const base = m.price;
  if (!base?.input || !base.output) return per(o.price);
  const ri = o.price.input / base.input;
  const ro = o.price.output / base.output;
  const fmt = (r: number) => `${+r.toFixed(2)}x`;
  return Math.abs(ri - ro) < 0.01 ? `${fmt(ri)} the standard price` : per(o.price);
}

// The offer a session's choice maps to on this model (same rule as the daemon).
const pick = (m: ModelInfo, want?: string) =>
  want ? m.speeds?.find((o) => o.id === want) ?? m.speeds?.find((o) => o.label.toLowerCase() === want.toLowerCase()) : undefined;

export function SpeedPicker({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const model = useStore((s) => s.models.find((m) => m.id === s.sessions[sessionId]?.model));
  if (!session || !model?.speeds?.length) return null;
  const cur = pick(model, session.settings.speed);
  const set = (id: string | null) => actions.patch(sessionId, { settings: { speed: id } }).catch(reportError);
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="speed-picker"
        title="Speed (applies from the next request)"
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-ui outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 data-popup-open:bg-hover",
          cur ? "text-brass" : "text-muted",
        )}
      >
        <Zap className={cn("size-3.5", cur && "fill-current")} /> {cur?.label ?? "Standard"} <ChevronDown className="size-3 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className={cn(popupClass, "w-72")} data-testid="speed-menu">
            <div className="px-2 pt-1 pb-1.5 text-micro text-faint">Speed, from the next request</div>
            <Menu.Item onClick={() => set(null)} className={cn(itemClass, "h-auto py-1.5")} data-testid="speed-option" data-speed="standard">
              <span className="w-3.5 shrink-0">{!cur && <Check className="size-3.5 text-accent" />}</span>
              <span className="flex min-w-0 flex-col">
                <span>Standard</span>
                <span className="text-micro text-faint">{model.price ? per(model.price) : model.billing === "subscription" ? "plan usage" : "price unknown"}</span>
              </span>
            </Menu.Item>
            {model.speeds.map((o) => (
              <Menu.Item key={o.id} onClick={() => set(o.id)} className={cn(itemClass, "h-auto py-1.5")} data-testid="speed-option" data-speed={o.id}>
                <span className="w-3.5 shrink-0">{cur?.id === o.id && <Check className="size-3.5 text-accent" />}</span>
                <span className="flex min-w-0 flex-col">
                  <span>{o.label}</span>
                  {cost(o, model) && <span className="text-micro text-faint">{cost(o, model)}</span>}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
