import { Combobox } from "@base-ui/react/combobox";
import { Check, Eye, EyeOff, Image, RefreshCw, Star } from "lucide-react";
import { TriggerLabel, triggerClass } from "./ModelPicker.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { actions, reportError, useStore, type ListedModel } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { Kbd } from "./Kbd.tsx";

type Item = {
  value: string; label: string; model: string; provider: string; providerLabel: string;
  context: number; vision?: boolean; plan: boolean; hidden?: "model" | "provider"; key: string; hay: string;
};
type Group = { value: string; label: string; provider?: string; plan?: boolean; total: number; items: Item[] };

// A provider group shows this many models until it is opened or searched.
const CAP = 6;
const RECENT = 5;

// Models as their providers list them. With no query: favorites, recent
// models, then one group per provider (the default model's provider, then the
// plan providers, then the rest), each folded to its newest few. A query
// searches every model, the hidden ones last so they can be shown again.
// Nothing here names a model. A chunk of its own (Combobox is large):
// ModelPicker shows the same trigger until it loads.
export function ModelMenu({ value, onChange, compact, openSignal }: { value: string; onChange: (id: string) => void; compact?: boolean; openSignal?: number }) {
  const [open, setOpen] = useState(!!openSignal);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const highlighted = useRef<Item | undefined>(undefined);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const models = useStore((s) => s.models);
  const sessions = useStore((s) => s.sessions);
  const def = useStore((s) => s.defaultModel);
  const pinned = useStore((s) => s.pinned);
  const labels = useStore((s) => s.providerLabels);
  const hiddenProviders = useStore((s) => s.providers?.choices.hidden_providers);

  // Built once per listing change; a keystroke only filters these.
  const { all, byId, order } = useMemo(() => {
    const offProviders = new Set(hiddenProviders ?? []);
    const item = (m: ListedModel): Item => {
      const providerLabel = labels[m.provider] ?? m.provider;
      return {
        value: m.id, label: m.name, model: m.model, provider: m.provider, providerLabel,
        context: m.context, vision: m.images, plan: m.billing === "subscription",
        hidden: m.hidden ? (offProviders.has(m.provider) ? "provider" : "model") : undefined,
        key: m.id, hay: `${m.name} ${m.model} ${providerLabel} ${m.provider}`.toLowerCase(),
      };
    };
    const all = models.map(item);
    const byId = new Map(all.map((i) => [i.value, i]));
    // Provider order: the default's provider, then plans, then by name.
    const plan = new Set(all.filter((i) => i.plan).map((i) => i.provider));
    const defP = byId.get(def)?.provider;
    const order = [...new Set(all.map((i) => i.provider))].sort((a, b) =>
      Number(b === defP) - Number(a === defP) || Number(plan.has(b)) - Number(plan.has(a)) || (labels[a] ?? a).localeCompare(labels[b] ?? b));
    return { all, byId, order };
  }, [models, labels, def, hiddenProviders]);

  const groups = useMemo((): Group[] => {
    const q = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (i: Item) => q.every((t) => i.hay.includes(t));
    const pins = pinned.map((id) => byId.get(id)).filter((i): i is Item => !!i);
    const pinSet = new Set(pinned);
    const out: Group[] = [];
    const add = (value: string, label: string, items: Item[], extra: Partial<Group> = {}) => items.length && out.push({ value, label, items, total: items.length, ...extra });
    const perProvider = (pool: Item[], fold: boolean) => {
      const by = new Map<string, Item[]>();
      for (const i of pool) (by.get(i.provider) ?? by.set(i.provider, []).get(i.provider)!).push(i);
      for (const p of order) {
        const list = by.get(p);
        if (!list) continue;
        const folded = fold && !expanded.has(p) && list.length > CAP + 2;
        out.push({ value: p, label: labels[p] ?? p, provider: p, plan: list.some((i) => i.plan), total: list.length, items: folded ? list.slice(0, CAP) : list });
      }
    };
    if (!q.length) {
      add("favorites", "Favorites", pins.filter((i) => !i.hidden));
      const recent = [...new Set(Object.values(sessions).sort((a, b) => b.updated - a.updated).map((s) => s.model))]
        .map((id) => byId.get(id)).filter((i): i is Item => !!i && !i.hidden && !pinSet.has(i.value)).slice(0, RECENT);
      add("recent", "Recent", recent);
      perProvider(all.filter((i) => !i.hidden), true);
    } else {
      const found = all.filter(hit);
      add("favorites", "Favorites", pins.filter((i) => !i.hidden && hit(i)));
      perProvider(found.filter((i) => !i.hidden && !pinSet.has(i.value)), false);
      add("hidden", "Hidden", found.filter((i) => i.hidden));
    }
    return out;
  }, [query, all, byId, order, pinned, sessions, expanded, labels]);

  const count = useMemo(() => all.filter((i) => !i.hidden).length, [all]);
  const selected = byId.get(value) ?? null;

  const togglePin = (i: Item) => actions.choose(pinned.includes(i.value) ? { unpin: [i.value] } : { pin: [i.value] }).catch(reportError);
  const toggleHide = (i: Item) =>
    actions.choose(i.hidden === "provider" ? { show_provider: i.provider } : { provider: i.provider, [i.hidden ? "show" : "hide"]: [i.model] }).catch(reportError);

  return (
    <Combobox.Root
      open={open}
      onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}
      items={groups}
      filteredItems={groups}
      filter={null}
      autoHighlight
      inputValue={query}
      onInputValueChange={(v, d) => { if (d.reason !== "item-press") setQuery(v); }}
      value={selected}
      onValueChange={(v: Item | null) => v && onChange(v.value)}
      onItemHighlighted={(v: Item | undefined) => (highlighted.current = v)}
      isItemEqualToValue={(a: Item, b: Item) => a.value === b.value}
      itemToStringLabel={(i: Item) => i.label}
    >
      <Combobox.Trigger data-testid="model-picker" className={triggerClass(compact)}>
        <TriggerLabel label={selected?.label} any={all.length > 0} />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={6} className="z-50 outline-none">
          <Combobox.Popup
            aria-label="Choose a model"
            data-testid="model-popup"
            className={cn(
              "w-[min(30rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-raised shadow-3",
              "origin-[var(--transform-origin)] transition-[scale,opacity] duration-150",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            )}
          >
            <div className="flex items-center border-b border-line">
              <Combobox.Input
                placeholder="Search models"
                className="h-10 w-full bg-transparent px-3 text-ui outline-none placeholder:text-faint"
                onKeyDown={(e) => {
                  const i = highlighted.current;
                  if (!i || !(e.ctrlKey || e.metaKey)) return;
                  if (e.key === "f") { e.preventDefault(); togglePin(i); }
                  if (e.key === "h") { e.preventDefault(); toggleHide(i); }
                }}
              />
              <span className="shrink-0 pr-1 text-micro tabular-nums text-faint" title="Models shown (hidden ones are found by search)">{count}</span>
              <button
                type="button"
                title="Read the provider listings again"
                aria-label="Read the provider listings again"
                onClick={() => actions.loadModels(true).catch(reportError)}
                className="mr-1.5 grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            <Combobox.Empty>
              <div className="px-3 py-4 text-ui text-muted">No model matches.</div>
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(28rem,var(--available-height))] overflow-y-auto overscroll-contain p-1 scroll-py-8">
              {(group: Group) => (
                <Combobox.Group key={group.value} items={group.items} className="pb-1 last:pb-0" data-testid="model-group" data-group={group.value}>
                  <Combobox.GroupLabel className="group/head sticky top-0 z-10 flex h-7 items-center gap-1.5 bg-raised px-2 text-micro font-medium text-faint">
                    {group.value === "favorites" && <Star className="size-3 fill-current text-brass" />}
                    <span className="truncate">{group.label}</span>
                    {group.provider && <span className="font-normal tabular-nums">{group.total}</span>}
                    {group.plan && <span className="rounded-xs bg-sunken px-1 font-normal text-muted">plan</span>}
                    {group.provider && group.provider !== selected?.provider && !def.startsWith(`${group.provider}:`) && (
                      <button
                        type="button"
                        title={`Hide ${group.label} from the picker (search still finds its models)`}
                        aria-label={`Hide ${group.label}`}
                        data-testid="hide-provider"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); actions.choose({ hide_provider: group.provider }).catch(reportError); }}
                        className="ml-auto grid size-5 place-items-center rounded-xs opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/head:opacity-100"
                      >
                        <EyeOff className="size-3" />
                      </button>
                    )}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(item: Item) => (
                      <Combobox.Item
                        key={`${group.value}:${item.key}`}
                        value={item}
                        data-testid="model-option"
                        data-model={item.value}
                        className={cn(
                          "group/row grid h-8 cursor-default grid-cols-[1rem_1fr_auto] items-center gap-2 rounded-md px-2 text-ui select-none outline-none",
                          "data-highlighted:bg-hover",
                          item.hidden && "text-muted",
                        )}
                      >
                        <Combobox.ItemIndicator className="col-start-1 text-accent">
                          <Check className="size-3.5" />
                        </Combobox.ItemIndicator>
                        <span className="col-start-2 flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{item.label}</span>
                          {item.value === def && <span className="shrink-0 rounded-xs bg-accent-soft px-1 text-micro font-medium text-accent-ink">default</span>}
                          {!group.provider && <span className="shrink-0 truncate text-micro text-faint">{item.providerLabel}</span>}
                        </span>
                        <span className="col-start-3 flex items-center gap-1 text-micro tabular-nums text-faint">
                          <RowAction
                            label={pinned.includes(item.value) ? "Remove from favorites" : "Add to favorites"}
                            on={pinned.includes(item.value)}
                            testid="pin-model"
                            onPress={() => togglePin(item)}
                          >
                            <Star className={cn("size-3", pinned.includes(item.value) && "fill-current text-brass")} />
                          </RowAction>
                          {item.value !== def && (
                            <RowAction
                              label={item.hidden === "provider" ? `Show ${item.providerLabel} again` : item.hidden ? "Show again" : "Hide"}
                              on={!!item.hidden}
                              testid="hide-model"
                              onPress={() => toggleHide(item)}
                            >
                              {item.hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                            </RowAction>
                          )}
                          {item.vision && <Image className="ml-0.5 size-3" aria-label="Reads images" />}
                          <span className="w-8 text-right" title="Context window">{item.context ? fmtTokens(item.context) : ""}</span>
                        </span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                  {group.provider && group.items.length < group.total && (
                    <button
                      type="button"
                      data-testid="show-all"
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => setExpanded((s) => new Set(s).add(group.provider!))}
                      className="ml-6 h-7 rounded-md px-2 text-caption text-accent-ink hover:bg-hover"
                    >
                      Show all {group.total}
                    </button>
                  )}
                </Combobox.Group>
              )}
            </Combobox.List>
            <div className="flex items-center gap-3 border-t border-line px-3 py-1.5 text-micro text-faint">
              <span className="inline-flex items-center gap-1"><Kbd keys="mod+f" /> favorite</span>
              <span className="inline-flex items-center gap-1"><Kbd keys="mod+h" /> hide</span>
              <span className="ml-auto">Search finds hidden models</span>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

// A small button inside an option that acts without choosing the option.
function RowAction({ label, on, testid, onPress, children }: { label: string; on: boolean; testid: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      data-testid={testid}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPress(); }}
      className={cn(
        "grid size-5 place-items-center rounded-xs hover:bg-line hover:text-fg",
        on ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-data-highlighted/row:opacity-100",
      )}
    >
      {children}
    </span>
  );
}
