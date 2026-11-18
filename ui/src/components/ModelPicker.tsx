import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actions, useStore } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";

type Item = { value: string; label: string; provider: string; context: number };

export function ModelPicker({ value, onChange, compact, openSignal }: { value: string; onChange: (id: string) => void; compact?: boolean; openSignal?: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const models = useStore((s) => s.models);
  const items = useMemo<Item[]>(
    () => models.map((m) => ({ value: m.id, label: m.name, provider: m.provider, context: m.context })),
    [models],
  );
  const selected = items.find((i) => i.value === value) ?? null;

  return (
    <Combobox.Root
      open={open}
      onOpenChange={setOpen}
      items={items}
      value={selected}
      onValueChange={(v: Item | null) => v && onChange(v.value)}
      isItemEqualToValue={(a: Item, b: Item) => a.value === b.value}
    >
      <Combobox.Trigger
        data-testid="model-picker"
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted hover:bg-hover hover:text-fg",
          "transition-colors",
          compact && "px-1.5",
        )}
      >
        <span className="max-w-40 truncate sm:max-w-56">{selected?.label ?? (items.length ? "Choose a model" : "No models")}</span>
        <ChevronsUpDown className="size-3.5 opacity-60" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={6} className="z-50 outline-none">
          <Combobox.Popup
            aria-label="Choose a model"
            className={cn(
              "w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-raised shadow-3",
              "origin-[var(--transform-origin)] transition-[scale,opacity] duration-150",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            )}
          >
            <div className="flex items-center border-b border-line">
              <Combobox.Input
                placeholder="Search models"
                className="h-10 w-full bg-transparent px-3 text-ui outline-none placeholder:text-faint"
              />
              <button
                type="button"
                title="Refresh the provider listings"
                onClick={() => actions.loadModels(true)}
                className="mr-1.5 grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            <Combobox.Empty>
              <div className="px-3 py-4 text-ui text-muted">No model matches.</div>
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(22rem,var(--available-height))] overflow-y-auto overscroll-contain p-1">
              {(item: Item) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  className={cn(
                    "grid grid-cols-[1rem_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5 text-ui cursor-default select-none outline-none",
                    "data-highlighted:bg-hover",
                  )}
                >
                  <Combobox.ItemIndicator className="col-start-1 text-accent">
                    <Check className="size-3.5" />
                  </Combobox.ItemIndicator>
                  <span className="col-start-2 min-w-0">
                    <span className="block truncate">{item.label}</span>
                    <span className="block truncate text-micro text-faint">{item.provider}</span>
                  </span>
                  <span className="text-micro tabular-nums text-faint" title="Context window">{item.context ? fmtTokens(item.context) : ""}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
