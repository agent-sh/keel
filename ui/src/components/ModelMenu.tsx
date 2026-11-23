import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronLeft, ChevronRight, EyeOff, Image, ImageOff, RefreshCw, Star } from "lucide-react";
import { TriggerLabel, triggerClass } from "./ModelPicker.tsx";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { composing } from "../lib/keys.ts";
import { actions, api, ensureModels, reportError, useStore } from "../lib/store.ts";
import { cn, fmtCost, fmtTokens } from "../lib/utils.ts";
import { buildGroups, buildItems, countLabel, hiddenReason, providerOrder, type Group, type Item } from "../lib/picker.ts";
import { notePick, recentPicks } from "../lib/ui.ts";
import { Kbd } from "./Kbd.tsx";
import { loadPeerModels, usePeerModels } from "../lib/peer-models.ts";
import { machineName } from "../lib/fleet.ts";
import type { Session } from "../../../src/core/types.ts";
import { carriedEffort, stepEffort, switchCost } from "../../../src/engine/switch-rule.ts";

// What a pick carries besides the model: the effort the owner set on its row,
// and Compact first, the row's second action.
export type ModelPick = { effort?: string; compactFirst?: boolean };

// What the session's cache is worth to a switch, read when the menu opens:
// the tokens a request on another model reads again, until when, on which
// model they are cached, and whether the current model can compact first.
type CacheFacts = { cached_tokens: number; warm_until?: number; ran_on: string; can_compact: boolean };

// The lists themselves are built in lib/picker.ts. With no query: favorites,
// recent picks, then one group per provider (the default model's provider,
// then the plan providers, then the rest), each folded to its newest few. A
// query searches every model, an exact route id first and the hidden ones
// last so they can be shown again. Nothing here names a model. A chunk of its
// own (Combobox is large): ModelPicker shows the same trigger until it loads.
// `machine`: the session is another daemon's; its listing is the one offered.
// Read again only when the sessions change, and once for every menu on the page.
const startedFor = new WeakMap<object, string>();
function startedOn(sessions: Record<string, Session>): string {
  let v = startedFor.get(sessions);
  if (v === undefined) startedFor.set(sessions, (v = Object.values(sessions).sort((a, b) => b.created - a.created).map((s) => s.model).join("\n")));
  return v;
}

// `session`: the menu sets that session's model and effort together: each row
// shows the effort a pick of it runs at (the session's, moved to the nearest
// level the model lists), Left and Right change it on the highlighted row
// (with the search field empty, or with Alt), a press on it steps it, and
// Enter applies both. Each row also says what a switch to it re-reads without
// the prompt cache and what that adds, and offers Compact first (Shift+Enter).
export function ModelMenu({ value, onChange, compact, openSignal, machine, placeholder, session }: { value: string; onChange: (id: string, pick?: ModelPick) => void; compact?: boolean; openSignal?: number; machine?: string; placeholder?: string; session?: string }) {
  const [open, setOpen] = useState(!!openSignal);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The highlighted row by id: after a refresh reorders or drops rows, a
  // shortcut acts on that model or on nothing, never on the row that took its place.
  const highlighted = useRef<string | undefined>(undefined);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  // The whole listing is read when the menu first opens; until then the trigger names its model from the few the page holds.
  const local = useStore((s) => s.models);
  useEffect(() => { if (open) ensureModels().catch((e) => reportError(e, { at: "models" })); }, [open]);
  const peer = usePeerModels(machine);
  const models = machine ? peer?.models ?? [] : local;
  // The models sessions were started on, newest first, as one string: the menu (one in every
  // pane's box) is not drawn again for a change of a session that changes no model.
  const started = useStore((s) => startedOn(s.sessions));
  // The default badge is the listing daemon's own default.
  const localDef = useStore((s) => s.defaultModel);
  const def = machine ? peer?.default ?? "" : localDef;
  const pinned = useStore((s) => s.pinned);
  const localLabels = useStore((s) => s.providerLabels);
  const labels = machine ? peer?.labels ?? {} : localLabels;
  const problems = useStore((s) => s.limits?.problems);
  // The effort each row runs at: what the owner set on it in this opening, else the session's carried over.
  const want = useStore((s) => (session ? s.sessions[session]?.settings.effort : undefined));
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const offered = useMemo(() => new Map(models.map((m) => [m.id, m.efforts ?? []])), [models]);
  const effortOf = (i: Item) => (session ? efforts[i.value] ?? carriedEffort(want, offered.get(i.value) ?? []) : undefined);
  const pickOf = (i: Item): ModelPick | undefined => (session && efforts[i.value] !== undefined ? { effort: efforts[i.value] } : undefined);
  const setEffort = (i: Item, next: string | undefined) => { if (next && next !== effortOf(i)) setEfforts((e) => ({ ...e, [i.value]: next })); };
  const step = (i: Item, by: -1 | 1) => setEffort(i, stepEffort(effortOf(i), offered.get(i.value) ?? [], by));
  const [facts, setFacts] = useState<CacheFacts | null>(null);
  useEffect(() => {
    if (!open || !session) return;
    let live = true;
    api<CacheFacts>(`/api/sessions/${session}/switch-warning`).then((f) => live && setFacts(f)).catch((e) => reportError(e, { at: "model picker" }));
    return () => { live = false; setFacts(null); };
  }, [open, session]);
  const prices = useMemo(() => new Map(models.map((m) => [m.id, m.price])), [models]);
  // What a switch to the row loses: nothing on the model the cache is on, or once the cache is cold.
  const lossOf = (i: Item) => {
    if (!facts || !facts.cached_tokens || i.value === facts.ran_on || (facts.warm_until !== undefined && Date.now() >= facts.warm_until)) return undefined;
    return { tokens: facts.cached_tokens, ...switchCost(facts.cached_tokens, prices.get(facts.ran_on), prices.get(i.value)) };
  };
  useEffect(() => { if (open) actions.loadLimits().catch((e) => reportError(e, { at: "limits" })); }, [open]);

  // Built once per listing change; a keystroke only filters these.
  const { all, byId, labelOf, order } = useMemo(() => {
    const b = buildItems(models, labels);
    return { ...b, order: providerOrder(b.all, def, b.labelOf) };
  }, [models, labels, def]);
  // Recent: the owner's own picks, else the models sessions were started on.
  const recent = useMemo(() => {
    const picks = recentPicks();
    return picks.length ? picks : started ? started.split("\n") : [];
  }, [started, open]);

  const groups = useMemo(
    () => buildGroups({ query, all, byId, order, pinned, recent, expanded, labelOf }),
    [query, all, byId, order, pinned, recent, expanded, labelOf],
  );
  const count = useMemo(() => countLabel(query, all, groups), [query, all, groups]);
  const selected = byId.get(value) ?? null;
  const shown = selected ? (all.some((o) => o.label === selected.label && o.value !== selected.value) ? `${selected.label} · ${selected.providerLabel}` : selected.label) : undefined;

  // Favorites and hidden models are this daemon's own choices: a peer's
  // listing offers no pin or hide (they would land here, not there).
  const own = !machine;
  const togglePin = (i: Item) => own && actions.choose(pinned.includes(i.value) ? { unpin: [i.value] } : { pin: [i.value] }).catch(reportError);
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
  const choose = (i: Item, compactFirst?: boolean) => { notePick(i.value); onChange(i.value, compactFirst ? { ...pickOf(i), compactFirst } : pickOf(i)); setOpen(false); setQuery(""); };
  const canCompact = (i: Item) => !!facts?.can_compact && !!lossOf(i);

  return (
    <Combobox.Root
      open={open}
      onOpenChange={(o) => { setOpen(o); setHint(null); setHeld(null); setEfforts({}); if (!o) setQuery(""); }}
      items={groups}
      filteredItems={groups}
      filter={null}
      autoHighlight
      inputValue={query}
      onInputValueChange={(v, d) => { if (d.reason !== "item-press") { release(); setQuery(v); } }}
      value={selected}
      onValueChange={(v: Item | null) => { if (!v) return; notePick(v.value); onChange(v.value, pickOf(v)); }}
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
      {/* (Named for a screen reader: a combobox is not named by what it shows, and a phone's row
          shows only its mark while a turn runs.) */}
      <Combobox.Trigger data-testid="model-picker" className={triggerClass(compact)} aria-label={`Model: ${shown ?? (value || placeholder || "none chosen")}`}>
        <TriggerLabel label={shown} any={all.length > 0} value={value} placeholder={placeholder} />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={6} className={cn("z-50 outline-none", SHEET.place)}>
          <Combobox.Popup
            aria-label="Choose a model"
            data-testid="model-popup"
            className={cn(
              "@container/picker flex max-h-[min(33rem,var(--available-height))] flex-col overflow-hidden rounded-lg border border-line bg-raised shadow-3",
              // A session's rows carry its effort and Compact first besides: wider, so the name keeps the row's middle.
              session ? "w-[min(36rem,calc(100vw-1.5rem))]" : "w-[min(30rem,calc(100vw-1.5rem))]",
              SHEET.popup,
              "origin-[var(--transform-origin)] transition-[scale,opacity]",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            )}
          >
            <div className="flex shrink-0 flex-wrap items-center border-b border-line">
              <Combobox.Input
                placeholder="Search models"
                className="h-10 min-w-0 flex-1 bg-transparent px-3 text-ui outline-none placeholder:text-faint"
                onKeyDown={(e) => {
                  if (composing(e)) return;
                  // Left and Right move the caret while there is a query to edit; with none (or with Alt) they set the effort.
                  if (session && (e.key === "ArrowLeft" || e.key === "ArrowRight") && (e.altKey || !e.currentTarget.value) && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    const i = current();
                    if (!i || !(offered.get(i.value) ?? []).length) return;
                    e.preventDefault();
                    (e as any).preventBaseUIHandler?.();
                    step(i, e.key === "ArrowLeft" ? -1 : 1);
                    return;
                  }
                  if (session && e.key === "Enter" && e.shiftKey) {
                    const i = current();
                    if (!i || !canCompact(i)) return;
                    e.preventDefault();
                    (e as any).preventBaseUIHandler?.();
                    choose(i, true);
                    return;
                  }
                  if (held && e.key === "Enter") {
                    e.preventDefault();
                    (e as any).preventBaseUIHandler?.();
                    const i = current();
                    if (i) choose(i);
                    return;
                  }
                  if (!own || !(e.ctrlKey || e.metaKey) || (e.key !== "f" && e.key !== "h")) return;
                  e.preventDefault();
                  const i = current();
                  if (!i) return;
                  if (e.key === "f") togglePin(i);
                  else if (i.hidden) show(i);
                  else hide(i);
                }}
              />
              <span className={cn("shrink-0 whitespace-nowrap pr-1 text-micro tabular-nums text-faint", NARROW.count)} data-testid="model-count" role="status">{count}</span>
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
            {hint && <div className="shrink-0 border-b border-line px-3 py-1.5 text-caption text-warn" role="status" data-testid="picker-hint">{hint}</div>}
            {machine && (
              <div data-testid="peer-catalog" className={cn("shrink-0 border-b border-line px-3 py-1.5 text-caption", peer?.error ? "text-warn" : "text-faint")}>
                {peer?.error
                  ? `${machineName(machine)}'s listing cannot be read now (${peer.error})${peer.models ? "; the last one it gave is shown" : ""}.`
                  : peer?.models ? `Models ${machineName(machine)} lists: the session runs there.` : `Reading ${machineName(machine)}'s models.`}
              </div>
            )}
            <Combobox.Empty>
              <div className="k-empty px-3 py-4">No model matches.</div>
            </Combobox.Empty>
            <Combobox.List className="min-h-0 overflow-y-auto overscroll-contain px-1 pb-1 scroll-py-8">
              {(group: Group) => (
                <Combobox.Group key={group.value} items={group.items} className="pb-1 last:pb-0" data-testid="model-group" data-group={group.value}>
                  <Combobox.GroupLabel className="group/head sticky top-0 z-10 flex min-h-7 items-center gap-1.5 bg-raised px-2 text-micro font-medium text-faint">
                    {group.value === "favorites" && <Star className="size-3 shrink-0 fill-current text-brass" />}
                    <span className={cn("truncate", NARROW.wrap)} data-testid="model-group-label">{group.label}</span>
                    {group.provider && <span className="font-normal tabular-nums">{group.total}</span>}
                    {group.plan && <span className="rounded-xs bg-sunken px-1 font-normal text-muted">plan</span>}
                    {group.provider && problems?.[group.provider] && (
                      <span className={cn("font-normal", problems[group.provider]!.kind === "billing" ? "text-warn" : "text-danger")} title={problems[group.provider]!.message} data-testid="group-problem">
                        {problems[group.provider]!.kind === "billing" ? "billing" : "key refused"}
                      </span>
                    )}
                    {own && group.provider && group.provider !== selected?.provider && !def.startsWith(`${group.provider}:`) && (
                      <button
                        type="button"
                        title={`Hide ${group.label} from the picker (search still finds its models)`}
                        aria-label={`Hide ${group.label}`}
                        data-testid="hide-provider"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); actions.choose({ hide_provider: group.provider }).catch(reportError); }}
                        className="ml-auto grid size-ctl-sm shrink-0 place-items-center rounded-xs opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/head:opacity-100 pointer-coarse:size-7 pointer-coarse:opacity-100"
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
                          "group/row relative grid min-h-8 cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1 text-ui select-none outline-none",
                          NARROW.row,
                          held ? "data-held:bg-hover" : "data-highlighted:bg-hover",
                          item.hidden && "text-muted",
                        )}
                      >
                        <Combobox.ItemIndicator className={cn("col-start-1 text-accent", NARROW.mark)}>
                          <Check className="size-3.5" />
                        </Combobox.ItemIndicator>
                        <span className={cn("col-start-2 flex min-w-0 items-center gap-1.5", NARROW.apart)}>
                          <span className={cn("min-w-0 text-balance [overflow-wrap:anywhere]", item.hidden && "max-w-[55%]", NARROW.name)} data-testid="model-name">{item.label}</span>
                          {session && !item.hidden && <CacheCost loss={lossOf(item)} />}
                          {item.value === def && <span data-testid="model-default" className="shrink-0 rounded-xs bg-accent-soft px-1 text-micro font-medium text-accent-ink">default</span>}
                          {!group.provider && !item.hidden && <span className={cn("min-w-16 shrink-[8] truncate text-micro text-faint", NARROW.wrap)} title={item.providerLabel} data-testid="model-provider">{item.providerLabel}</span>}
                          {item.hidden && <span className={cn("min-w-0 truncate text-micro text-faint", NARROW.wrap)} title={`${hiddenReason(item)} (${item.providerLabel})`} data-testid="hidden-reason">{hiddenReason(item)}</span>}
                        </span>
                        <span className={cn("col-start-3 flex items-center gap-1 text-micro tabular-nums text-faint", NARROW.tail)}>
                          <span className={cn("contents", NARROW.actions)}>
                            {session && !item.hidden && canCompact(item) && (
                              <TextAction quiet testid="compact-first" label="Compact first" title={`Summarize the conversation on the current model from its warm cache, then switch (Shift+Enter)`} onPress={() => choose(item, true)} />
                            )}
                            {session && !item.hidden && effortOf(item) && (
                              <EffortChip
                                value={effortOf(item)!}
                                changed={efforts[item.value] !== undefined}
                                onStep={(by) => step(item, by)}
                              />
                            )}
                            {own && !item.hidden && <RowAction
                              label={pinned.includes(item.value) ? "Remove from favorites" : "Add to favorites"}
                              on={pinned.includes(item.value)}
                              testid="pin-model"
                              onPress={() => togglePin(item)}
                            >
                              <Star className={cn("size-3", pinned.includes(item.value) && "fill-current text-brass")} />
                            </RowAction>}
                            {own && !item.hidden && item.value !== def && (
                              <RowAction label="Hide" on={false} testid="hide-model" onPress={() => hide(item)}>
                                <EyeOff className="size-3" />
                              </RowAction>
                            )}
                            {own && item.hidden === "model" && <TextAction testid="show-model" label="Show" onPress={() => show(item)} />}
                            {own && (item.hidden === "provider" || item.hidden === "both") && (
                              <TextAction testid="show-provider" label="Show provider" title={item.hidden === "both" ? `Show ${item.providerLabel} again; this model stays hidden` : `Show ${item.providerLabel} again`} onPress={() => showProvider(item, false)} />
                            )}
                            {own && item.hidden === "both" && <TextAction testid="show-both" label="Show both" title={`Show ${item.providerLabel} and this model`} onPress={() => showProvider(item, true)} />}
                          </span>
                          {!item.hidden && (
                            <span className={cn("contents", NARROW.facts)}>
                              {item.vision === true && <Image className="ml-0.5 size-3 shrink-0" aria-label="Reads images" />}
                              {item.vision === false && <ImageOff className="ml-0.5 size-3 shrink-0" aria-label="Does not read images" />}
                              <span className={cn("w-8 text-right", NARROW.window)} title="Context window">{item.context ? fmtTokens(item.context) : ""}</span>
                            </span>
                          )}
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
            <div className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-micro text-faint [&>span]:whitespace-nowrap", own && NARROW.gone)}>
              {own ? (
                <>
                  {session && <span className="inline-flex items-center gap-1 pointer-coarse:hidden" data-testid="effort-keys"><Kbd keys="arrowleft" /><Kbd keys="arrowright" /> effort</span>}
                  {session && facts?.can_compact && !!facts.cached_tokens && <span className="inline-flex items-center gap-1 pointer-coarse:hidden"><Kbd keys="shift+enter" /> compact first</span>}
                  <span className="inline-flex items-center gap-1 pointer-coarse:hidden"><Kbd keys="mod+f" /> favorite</span>
                  <span className="inline-flex items-center gap-1 pointer-coarse:hidden"><Kbd keys="mod+h" /> hide</span>
                  <span className="ml-auto">Search finds hidden models</span>
                </>
              ) : <span data-testid="peer-choices-note">Favorites and hidden models are set on {machineName(machine!)} itself</span>}
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

// On a phone the chooser is a sheet hung from the top of the window, not a
// popup beside its trigger (the trigger sits low, with room for one row under
// it): the search field stays at the top, clear of an on-screen keyboard, and
// the results get the rest of the window, down to its bottom edge. On a wider
// phone it stands in the middle. A tap beside the sheet still closes it.
// It opens from its own top edge, where it hangs: the origin a popup grows
// from is a point beside its trigger, and for a sheet that reaches the
// window's bottom that point is below it, so it opened past the edge.
const SHEET = {
  place: "max-md:fixed! max-md:inset-3! max-md:bottom-0! max-md:flex max-md:transform-none! max-md:flex-col max-md:items-center max-md:pointer-events-none",
  popup: "max-md:pointer-events-auto max-md:max-h-full max-md:origin-top",
};

// The popup narrower than 24rem (a phone, a large text size; the variant is in
// styles.css): a row is the name on a line of its own, whole, then what it is
// under it, and last a line that starts with its window and ends with its
// actions (it shares the line before when both fit). The count goes under
// the search field and the keyboard hints leave.
const NARROW = {
  row: "picker-narrow:flex picker-narrow:flex-wrap picker-narrow:gap-x-1.5 picker-narrow:gap-y-0.5 picker-narrow:py-1.5 picker-narrow:pl-8",
  mark: "picker-narrow:absolute picker-narrow:left-2 picker-narrow:top-2",
  apart: "picker-narrow:contents",
  tail: "picker-narrow:min-h-7 picker-narrow:flex-[1_0_auto]",
  name: "picker-narrow:max-w-none picker-narrow:basis-full",
  wrap: "picker-narrow:min-w-0 picker-narrow:shrink picker-narrow:whitespace-normal picker-narrow:[overflow-wrap:anywhere]",
  facts: "picker-narrow:order-first picker-narrow:flex picker-narrow:items-center picker-narrow:gap-1",
  window: "picker-narrow:w-auto",
  actions: "picker-narrow:ml-auto picker-narrow:flex picker-narrow:flex-wrap picker-narrow:items-center picker-narrow:justify-end picker-narrow:gap-1",
  count: "picker-narrow:order-last picker-narrow:basis-full picker-narrow:px-3 picker-narrow:pb-1.5",
  gone: "picker-narrow:hidden",
};

// Under a finger an action is the platforms' touch size: 2.9rem is 44px at
// the smallest text size and more at the others.
const FINGER = "pointer-coarse:size-[2.9rem] pointer-coarse:[&>svg]:size-4";

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
        "grid size-ctl-sm shrink-0 place-items-center rounded-xs hover:bg-line hover:text-fg", FINGER,
        on ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 group-data-highlighted/row:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      {children}
    </span>
  );
}

// The effort a pick of the row runs at. The arrows step it (shown on the
// highlighted row, and always under a finger); the word is the row's like
// its name, so a press on it picks the row. Changed in this opening: in the
// accent, as what Enter sends.
function EffortChip({ value, changed, onStep }: { value: string; changed: boolean; onStep: (by: -1 | 1) => void }) {
  const hit = (f: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); },
    onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); f(); },
  });
  // Kept in the layout while hidden: the word stays where it is when the row is highlighted.
  const arrow = "invisible grid size-ctl-sm place-items-center rounded-xs hover:bg-line hover:text-fg group-hover/row:visible group-data-highlighted/row:visible pointer-coarse:visible pointer-coarse:size-[2.9rem]";
  return (
    <span className="inline-flex shrink-0 items-center" data-testid="row-effort" data-effort={value} data-changed={changed ? "" : undefined}>
      <span role="button" tabIndex={-1} aria-label="Less effort" title="Less effort (Left)" className={arrow} {...hit(() => onStep(-1))}><ChevronLeft className="size-3" /></span>
      <span
        title={`Effort ${value}: Left and Right change it, Enter applies it with the model`}
        className={cn("rounded-xs px-1 py-0.5 text-micro", changed ? "bg-accent-soft font-medium text-accent-ink" : "text-muted")}
      >
        {value}
      </span>
      <span role="button" tabIndex={-1} aria-label="More effort" title="More effort (Right)" className={arrow} {...hit(() => onStep(1))}><ChevronRight className="size-3" /></span>
    </span>
  );
}

// What a switch to the row adds: the warm prefix read again without the
// cache, priced from the catalog (the new model's write rate against the
// current one's read rate). Tokens alone when the row's model has no price.
function CacheCost({ loss }: { loss?: { tokens: number; cost?: number; cached?: number; extra?: number } }) {
  if (!loss) return null;
  const priced = loss.extra !== undefined;
  const title = `A switch re-reads about ${fmtTokens(loss.tokens)} cached tokens without the prompt cache${loss.cost !== undefined ? `: about ${fmtCost(loss.cost)}${loss.cached !== undefined ? `, against ${fmtCost(loss.cached)} from the cache` : ""}` : "; this model states no price"}`;
  return (
    <span data-testid="row-cache-cost" title={title} className={cn("shrink-0 whitespace-nowrap text-micro tabular-nums", priced ? "text-faint" : "text-warn")}>
      {priced ? `+${fmtCost(loss.extra)}` : `${fmtTokens(loss.tokens)} uncached`}
    </span>
  );
}

// A worded action inside an option, for the choices an icon cannot tell apart.
// `quiet`: shown on the highlighted row only (and always under a finger), as the icons are.
function TextAction({ label, title, testid, onPress, quiet }: { label: string; title?: string; testid: string; onPress: () => void; quiet?: boolean }) {
  return (
    <span
      role="button"
      tabIndex={-1}
      title={title ?? label}
      data-testid={testid}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPress(); }}
      className={cn(
        "shrink-0 rounded-xs px-1.5 py-0.5 text-micro text-accent-ink hover:bg-line pointer-coarse:inline-flex pointer-coarse:min-h-[2.9rem] pointer-coarse:items-center pointer-coarse:px-3",
        // Kept in the layout while hidden: nothing moves under the pointer when the row is highlighted.
        quiet && "invisible group-hover/row:visible group-data-highlighted/row:visible pointer-coarse:visible",
      )}
    >
      {label}
    </span>
  );
}
