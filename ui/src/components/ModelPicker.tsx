import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Eye, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actions, useStore } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";

type Item = { value: string; label: string; provider: string; context: number; vision?: boolean; key: string };
type Group = { value: string; items: Item[] };

// Models as their providers list them, grouped by provider, with the ones
// used most recently on top. Nothing here names a model.
export function ModelPicker({ value, onChange, compact, openSignal }: { value: string; onChange: (id: string) => void; compact?: boolean; openSignal?: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const models = useStore((s) => s.models);
  const sessions = useStore((s) => s.sessions);
  const def = useStore((s) => s.defaultModel);

  const { groups, all } = useMemo(() => {
    const item = (m: (typeof models)[number], g: string): Item => ({
      value: m.id, label: m.name, provider: m.provider, context: m.context, vision: (m as any).vision, key: `${g}:${m.id}`,
    });
    const byId = new Map(models.map((m) => [m.id, m]));
    const recentIds = [...new Set(Object.values(sessions).sort((a, b) => b.updated - a.updated).map((s) => s.model))]
      .filter((id) => byId.has(id))
      .slice(0, 4);
    const out: Group[] = [];
    if (recentIds.length) out.push({ value: "Recent", items: recentIds.map((id) => item(byId.get(id)!, "recent")) });
    const by = new Map<string, Item[]>();
    for (const m of models) (by.get(m.provider) ?? by.set(m.provider, []).get(m.provider)!).push(item(m, m.provider));
    // The default model's provider first, then the rest by name.
    const defProvider = byId.get(def)?.provider;
    for (const [p, list] of [...by].sort(([a], [b]) => Number(b === defProvider) - Number(a === defProvider) || a.localeCompare(b))) out.push({ value: p, items: list });
    return { groups: out, all: models.map((m) => item(m, m.provider)) };
  }, [models, sessions, def]);
  const selected = all.find((i) => i.value === value) ?? null;

  return (
    <Combobox.Root
      open={open}
      onOpenChange={setOpen}
      items={groups}
      value={selected}
      onValueChange={(v: Item | null) => v && onChange(v.value)}
      isItemEqualToValue={(a: Item, b: Item) => a.value === b.value}
      itemToStringLabel={(i: Item) => `${i.label} ${i.provider}`}
    >
      <Combobox.Trigger
        data-testid="model-picker"
        className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted transition-colors hover:bg-hover hover:text-fg", compact && "px-1.5")}
      >
        <span className="max-w-40 truncate sm:max-w-56">{selected?.label ?? (all.length ? "Choose a model" : "No models")}</span>
        <ChevronsUpDown className="size-3.5 opacity-60" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={6} className="z-50 outline-none">
          <Combobox.Popup
            aria-label="Choose a model"
            className={cn(
              "w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-raised shadow-3",
              "origin-[var(--transform-origin)] transition-[scale,opacity] duration-150",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            )}
          >
            <div className="flex items-center border-b border-line">
              <Combobox.Input placeholder="Search models" className="h-10 w-full bg-transparent px-3 text-ui outline-none placeholder:text-faint" />
              <span className="shrink-0 pr-1 text-micro tabular-nums text-faint">{all.length}</span>
              <button
                type="button"
                title="Read the provider listings again"
                aria-label="Read the provider listings again"
                onClick={() => actions.loadModels(true)}
                className="mr-1.5 grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            <Combobox.Empty>
              <div className="px-3 py-4 text-ui text-muted">No model matches.</div>
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(26rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 scroll-py-8">
              {(group: Group) => (
                <Combobox.Group key={group.value} items={group.items} className="pb-1 last:pb-0">
                  <Combobox.GroupLabel className="sticky top-0 z-10 flex h-7 items-center bg-raised px-2 text-micro font-medium text-faint">
                    {group.value}
                    <span className="ml-1.5 font-normal tabular-nums">{group.value !== "Recent" ? group.items.length : ""}</span>
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(item: Item) => (
                      <Combobox.Item
                        key={item.key}
                        value={item}
                        className={cn(
                          "grid h-8 cursor-default grid-cols-[1rem_1fr_auto] items-center gap-2 rounded-md px-2 text-ui select-none outline-none",
                          "data-highlighted:bg-hover",
                        )}
                      >
                        <Combobox.ItemIndicator className="col-start-1 text-accent">
                          <Check className="size-3.5" />
                        </Combobox.ItemIndicator>
                        <span className="col-start-2 flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{item.label}</span>
                          {item.value === def && <span className="shrink-0 rounded-xs bg-accent-soft px-1 text-micro font-medium text-accent-ink">default</span>}
                          {group.value === "Recent" && <span className="shrink-0 truncate text-micro text-faint">{item.provider}</span>}
                        </span>
                        <span className="flex items-center gap-1.5 text-micro tabular-nums text-faint">
                          {item.vision && <Eye className="size-3" aria-label="Reads images" />}
                          <span title="Context window">{item.context ? fmtTokens(item.context) : ""}</span>
                        </span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
