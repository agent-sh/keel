import { Combobox } from "@base-ui/react/combobox";
import { Check, Eye, EyeOff, Image, ImageOff, RefreshCw, Star } from "lucide-react";
import { TriggerLabel, triggerClass } from "./ModelPicker.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { actions, reportError, useStore } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { buildGroups, buildItems, countLabel, hiddenReason, providerOrder, type Group, type Item } from "../lib/picker.ts";
import { notePick, recentPicks } from "../lib/ui.ts";
import { Kbd } from "./Kbd.tsx";
import { loadPeerModels, usePeerModels } from "../lib/peer-models.ts";
import { machineName } from "../lib/fleet.ts";

// The lists themselves are built in lib/picker.ts. With no query: favorites,
// recent picks, then one group per provider (the default model's provider,
// then the plan providers, then the rest), each folded to its newest few. A
// query searches every model, an exact route id first and the hidden ones
// last so they can be shown again. Nothing here names a model. A chunk of its
// own (Combobox is large): ModelPicker shows the same trigger until it loads.
// `machine`: the session is another daemon's; its listing is the one offered.
export function ModelMenu({ value, onChange, compact, openSignal, machine, placeholder }: { value: string; onChange: (id: string) => void; compact?: boolean; openSignal?: number; machine?: string; placeholder?: string }) {
  const [open, setOpen] = useState(!!openSignal);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The highlighted row by id: after a refresh reorders or drops rows, a
  // shortcut acts on that model or on nothing, never on the row that took its place.
  const highlighted = useRef<string | undefined>(undefined);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const local = useStore((s) => s.models);
  const peer = usePeerModels(machine);
  const models = machine ? peer?.models ?? [] : local;
  const sessions = useStore((s) => s.sessions);
  // The default badge is the listing daemon's own default.
  const localDef = useStore((s) => s.defaultModel);
  const def = machine ? peer?.default ?? "" : localDef;
  const pinned = useStore((s) => s.pinned);
  const localLabels = useStore((s) => s.providerLabels);
  const labels = machine ? peer?.labels ?? {} : localLabels;
  const problems = useStore((s) => s.limits?.problems);
  useEffect(() => { if (open) actions.loadLimits().catch((e) => reportError(e, { at: "limits" })); }, [open]);

  // Built once per listing change; a keystroke only filters these.
  const { all, byId, labelOf, order } = useMemo(() => {
    const b = buildItems(models, labels);
    return { ...b, order: providerOrder(b.all, def, b.labelOf) };
  }, [models, labels, def]);
  // Recent: the owner's own picks, else the models sessions were started on.
  const recent = useMemo(() => {
    const picks = recentPicks();
    return picks.length ? picks : Object.values(sessions).sort((a, b) => b.created - a.created).map((s) => s.model);
  }, [sessions, open]);

  const groups = useMemo(
    () => buildGroups({ query, all, byId, order, pinned, recent, expanded, labelOf }),
    [query, all, byId, order, pinned, recent, expanded, labelOf],
  );
  const count = useMemo(() => countLabel(query, all, groups), [query, all, groups]);
  const selected = byId.get(value) ?? null;

  const togglePin = (i: Item) => actions.choose(pinned.includes(i.value) ? { unpin: [i.value] } : { pin: [i.value] }).catch(reportError);
  // Hide asks nothing of the daemon for the default: its row has no Hide either.
  const hide = (i: Item) => {
    if (i.value === def) return setHint("Choose another default before hiding this model.");
    actions.choose({ provider: i.provider, hide: [i.model] }).catch(reportError);
  };
  const showProvider = (i: Item, andModel: boolean) =>
    actions.choose(andModel ? { show_provider: i.provider, provider: i.provider, show: [i.model] } : { show_provider: i.provider }).catch(reportError);
  const show = (i: Item) => (i.hidden === "model" ? actions.choose({ provider: i.provider, show: [i.model] }).catch(reportError) : showProvider(i, i.hidden === "both"));
  const current = () => (held ? (held.gone ? undefined : byId.get(held.id)) : highlighted.current ? byId.get(highlighted.current) : undefined);

  // A listing that changes under an open menu (a refresh, a hide) keeps the
  // highlight on the model, not on its row: Base UI keeps the row index and
  // reports whichever model now sits there, so that report is ignored, the
  // menu marks the held model itself, and Enter and the shortcuts act on it.
  // If the model left the listing, nothing is highlighted and nothing acts
  // until the owner moves with a key or the pointer.
  const [held, setHeld] = useState<{ id: string; gone: boolean } | null>(null);
  const renderedAll = useRef(all);
  renderedAll.current = all;
  const seenAll = useRef(all);
  useLayoutEffect(() => {
    if (seenAll.current === all) return;
    seenAll.current = all;
    const id = held?.id ?? highlighted.current;
    if (!open || !id) return;
    const gone = !byId.has(id);
    setHeld({ id, gone });
    if (gone) setHint("The highlighted model left the listing. Nothing is highlighted: move with the arrows to choose.");
  }, [all]);
  const release = () => { if (held) setHeld(null); };
  const choose = (i: Item) => { notePick(i.value); onChange(i.value); setOpen(false); setQuery(""); };

  return (
    <Combobox.Root
      open={open}
      onOpenChange={(o) => { setOpen(o); setHint(null); setHeld(null); if (!o) setQuery(""); }}
      items={groups}
      filteredItems={groups}
      filter={null}
      autoHighlight
      inputValue={query}
      onInputValueChange={(v, d) => { if (d.reason !== "item-press") { release(); setQuery(v); } }}
      value={selected}
      onValueChange={(v: Item | null) => { if (!v) return; notePick(v.value); onChange(v.value); }}
      onItemHighlighted={(v: Item | undefined, d) => {
        // The row index Base UI kept across a listing change: not the owner's move.
        if (d.reason === "none" && renderedAll.current !== seenAll.current) return;
        if (held && d.reason === "none") return;
        highlighted.current = v?.value;
        release();
        setHint(null);
      }}
      isItemEqualToValue={(a: Item, b: Item) => a.value === b.value}
      itemToStringLabel={(i: Item) => i.label}
    >
      <Combobox.Trigger data-testid="model-picker" className={triggerClass(compact)}>
        <TriggerLabel label={selected ? (all.some((o) => o.label === selected.label && o.value !== selected.value) ? `${selected.label} · ${selected.providerLabel}` : selected.label) : undefined} any={all.length > 0} value={value} placeholder={placeholder} />
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
                  if (held && e.key === "Enter") {
                    e.preventDefault();
                    (e as any).preventBaseUIHandler?.();
                    const i = current();
                    if (i) choose(i);
                    return;
                  }
                  if (!(e.ctrlKey || e.metaKey) || (e.key !== "f" && e.key !== "h")) return;
                  e.preventDefault();
                  const i = current();
                  if (!i) return;
                  if (e.key === "f") togglePin(i);
                  else if (i.hidden) show(i);
                  else hide(i);
                }}
              />
              <span className="shrink-0 whitespace-nowrap pr-1 text-micro tabular-nums text-faint" data-testid="model-count" role="status">{count}</span>
              <button
                type="button"
                title="Read the provider listings again"
                aria-label="Read the provider listings again"
                data-testid="refresh-models"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => (machine ? loadPeerModels(machine, true) : actions.loadModels(true).catch(reportError))}
                className="mr-1.5 grid size-7 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>
            {hint && <div className="border-b border-line px-3 py-1.5 text-caption text-warn" role="status" data-testid="picker-hint">{hint}</div>}
            {machine && (
              <div data-testid="peer-catalog" className={cn("border-b border-line px-3 py-1.5 text-caption", peer?.error ? "text-warn" : "text-faint")}>
                {peer?.error
                  ? `${machineName(machine)}'s listing cannot be read now (${peer.error})${peer.models ? "; the last one it gave is shown" : ""}.`
                  : peer?.models ? `Models ${machineName(machine)} lists: the session runs there.` : `Reading ${machineName(machine)}'s models.`}
              </div>
            )}
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
                    {group.provider && problems?.[group.provider] && (
                      <span className={cn("font-normal", problems[group.provider]!.kind === "billing" ? "text-warn" : "text-danger")} title={problems[group.provider]!.message} data-testid="group-problem">
                        {problems[group.provider]!.kind === "billing" ? "billing" : "key refused"}
                      </span>
                    )}
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
                        aria-label={item.aria}
                        data-held={held && !held.gone && held.id === item.value ? "" : undefined}
                        data-model={item.value}
                        data-provider={item.provider}
                        className={cn(
                          "group/row grid h-8 cursor-default grid-cols-[1rem_1fr_auto] items-center gap-2 rounded-md px-2 text-ui select-none outline-none",
                          held ? "data-held:bg-hover" : "data-highlighted:bg-hover",
                          item.hidden && "text-muted",
                        )}
                      >
                        <Combobox.ItemIndicator className="col-start-1 text-accent">
                          <Check className="size-3.5" />
                        </Combobox.ItemIndicator>
                        <span className="col-start-2 flex min-w-0 items-center gap-1.5">
                          <span className={cn("truncate", item.hidden && "shrink-0 max-w-[55%]")}>{item.label}</span>
                          {item.value === def && <span data-testid="model-default" className="shrink-0 rounded-xs bg-accent-soft px-1 text-micro font-medium text-accent-ink">default</span>}
                          {!group.provider && !item.hidden && <span className="shrink-0 truncate text-micro text-faint">{item.providerLabel}</span>}
                          {item.hidden && <span className="min-w-0 truncate text-micro text-faint" title={`${hiddenReason(item)} (${item.providerLabel})`} data-testid="hidden-reason">{hiddenReason(item)}</span>}
                        </span>
                        <span className="col-start-3 flex items-center gap-1 text-micro tabular-nums text-faint">
                          {!item.hidden && <RowAction
                            label={pinned.includes(item.value) ? "Remove from favorites" : "Add to favorites"}
                            on={pinned.includes(item.value)}
                            testid="pin-model"
                            onPress={() => togglePin(item)}
                          >
                            <Star className={cn("size-3", pinned.includes(item.value) && "fill-current text-brass")} />
                          </RowAction>}
                          {!item.hidden && item.value !== def && (
                            <RowAction label="Hide" on={false} testid="hide-model" onPress={() => hide(item)}>
                              <EyeOff className="size-3" />
                            </RowAction>
                          )}
                          {item.hidden === "model" && <TextAction testid="show-model" label="Show" onPress={() => show(item)} />}
                          {(item.hidden === "provider" || item.hidden === "both") && (
                            <TextAction testid="show-provider" label="Show provider" title={item.hidden === "both" ? `Show ${item.providerLabel} again; this model stays hidden` : `Show ${item.providerLabel} again`} onPress={() => showProvider(item, false)} />
                          )}
                          {item.hidden === "both" && <TextAction testid="show-both" label="Show both" title={`Show ${item.providerLabel} and this model`} onPress={() => showProvider(item, true)} />}
                          {!item.hidden && item.vision === true && <Image className="ml-0.5 size-3" aria-label="Reads images" />}
                          {!item.hidden && item.vision === false && <ImageOff className="ml-0.5 size-3" aria-label="Does not read images" />}
                          {!item.hidden && <span className="w-8 text-right" title="Context window">{item.context ? fmtTokens(item.context) : ""}</span>}
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

// A worded action inside an option, for the choices an icon cannot tell apart.
function TextAction({ label, title, testid, onPress }: { label: string; title?: string; testid: string; onPress: () => void }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      title={title ?? label}
      data-testid={testid}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPress(); }}
      className="shrink-0 rounded-xs px-1.5 py-0.5 text-micro text-accent-ink hover:bg-line"
    >
      {label}
    </span>
  );
}
