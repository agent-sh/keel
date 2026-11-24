import { ArrowLeft, Bot, ChevronDown, Info, Keyboard, Menu, Search, SlidersHorizontal } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { settingsSections } from "../lib/extend.ts";
import { CUSTOMIZE_GROUPS, isCustomize } from "../lib/customize-ids.ts";
import { actions, api, reportError, useStore, useModels } from "../lib/store.ts";
import { ASK_USD_DEFAULT } from "../../../src/engine/switch-rule.ts";
import { navigate, savePref, SCALE_NAMES, SCALES, setScale, setTheme, setUI, useUI, type ThemePref } from "../lib/ui.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { settingsFind } from "../lib/settings-find.macro.ts" with { type: "macro" };
import { findSettings } from "../lib/settings-match.ts";
import { everyCommand, composing } from "../lib/keys.ts";
import { ShortcutList } from "./ShortcutSheet.tsx";
import { SmallModels } from "./SmallModels.tsx";
import { NewModelCards } from "./NewModels.tsx";
import { RouteChange } from "./RouteChange.tsx";
import { Seg } from "./Seg.tsx";

// Settings building blocks other lanes reuse for their sections: the kit (components/settings/kit.tsx).
import { Card, SettingRow } from "./settings/kit.tsx";
export { Card, SettingRow };

// One choice of a few: a radio group with one Tab stop, on the option chosen;
// the arrows move to the next option and choose it. Wider than its place (a
// phone, a large text size), it scrolls sideways inside itself and the page
// does not: the control (Seg.tsx) keeps the chosen option in view.
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <Seg label={label} value={value} onChange={onChange} options={options} />
  );
}

// Text size: six steps, each shown as the letter at its size. It scales the
// whole interface (type, spacing, controls), not the page zoom. The six share
// the row's width in equal parts, so all of them fit a phone at any size.
function TextSize() {
  const scale = useUI((s) => s.scale);
  return (
    <Seg
      label="Text size"
      testid="text-size"
      fill
      className="w-56"
      value={scale}
      onChange={setScale}
      options={SCALES.map((v, i) => ({
        value: v,
        label: "A",
        name: `${SCALE_NAMES[i]}, ${Math.round(v * 100)}%`,
        title: `${SCALE_NAMES[i]} (${Math.round(v * 100)}%)`,
        testid: `text-size-${Math.round(v * 100)}`,
        style: { fontSize: `${Math.round(13 * v * 10) / 10}px`, fontWeight: 600 },
      }))}
    />
  );
}

function General() {
  const theme = useUI((s) => s.theme);
  const enterSends = useUI((s) => s.enterSends);
  const scale = useUI((s) => s.scale);
  return (
    <Card>
      <SettingRow label="Theme" hint="Follow the system, or keep one.">
        <Segmented<ThemePref> label="Theme" value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </SettingRow>
      <SettingRow label="Text size" hint={`${SCALE_NAMES[SCALES.indexOf(scale as (typeof SCALES)[number])] ?? "Default"}, ${Math.round(scale * 100)}%.${matchMedia("(pointer: coarse)").matches ? "" : " Ctrl + and Ctrl - step it from anywhere, Ctrl 0 puts the default back."}`}>
        <TextSize />
      </SettingRow>
      {/* A touch screen's keyboard has a return key and no Ctrl or Shift: there the choice is what that key does. */}
      {matchMedia("(pointer: coarse)").matches ? (
        <SettingRow label="Return key" hint={enterSends ? "The return key sends the message." : "The return key makes a new line; Send sends."}>
          <Segmented label="Return key" value={enterSends ? "enter" : "mod"} onChange={(v) => savePref("enterSends", v === "enter")} options={[{ value: "enter", label: "Sends" }, { value: "mod", label: "New line" }]} />
        </SettingRow>
      ) : (
        <SettingRow label="Send with" hint={enterSends ? "Enter sends, Shift Enter makes a new line." : "Ctrl Enter sends, Enter makes a new line."}>
          <Segmented label="Send with" value={enterSends ? "enter" : "mod"} onChange={(v) => savePref("enterSends", v === "enter")} options={[{ value: "enter", label: "Enter" }, { value: "mod", label: "Ctrl Enter" }]} />
        </SettingRow>
      )}
    </Card>
  );
}

// The amount a model switch must add before the picker asks (the daemon's model_switch.ask_usd).
function SwitchAskField() {
  const [value, setValue] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  useEffect(() => { api<{ settings: Record<string, any> }>("/api/settings").then((r) => setValue(Number(r.settings.model_switch?.ask_usd ?? ASK_USD_DEFAULT))).catch(reportError); }, []);
  const save = () => {
    if (text === null || value === null) return;
    const v = text.trim() === "" ? 0 : Number(text.trim().replace(/^\$/, ""));
    if (!Number.isFinite(v) || v < 0) return setBad(true);
    setBad(false);
    if (v === value) return setText(null);
    api<{ settings: Record<string, any> }>("/api/settings", { method: "PATCH", body: JSON.stringify({ model_switch: { ask_usd: v } }) })
      .then((r) => { setValue(Number(r.settings.model_switch.ask_usd)); setText(null); })
      .catch((e) => { setBad(true); reportError(e); });
  };
  return (
    <label className={cn("flex h-8 items-center gap-1 rounded-md border bg-raised px-2.5 text-ui", bad ? "border-danger" : "border-line-strong")}>
      <span className="text-muted">$</span>
      <input
        aria-label="Ask before a model switch that adds at least this many US dollars"
        data-testid="switch-ask-usd"
        inputMode="decimal"
        disabled={value === null}
        value={text ?? (value === null ? "" : String(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && (e.currentTarget as HTMLInputElement).blur()}
        className="w-16 bg-transparent text-right tabular-nums outline-none"
      />
    </label>
  );
}

function Models() {
  const models = useModels();
  const def = useStore((s) => s.defaultModel);
  const [busy, setBusy] = useState(false);
  const byProvider = useMemo(() => {
    const m = new Map<string, typeof models>();
    for (const x of models) (m.get(x.provider) ?? m.set(x.provider, []).get(x.provider)!).push(x);
    return [...m.entries()];
  }, [models]);
  return (
    <div className="flex flex-col gap-4">
      <NewModelCards />
      <Card>
        <SettingRow label="Default model" hint="New sessions start on it. It comes from the daemon's configuration.">
          <span className="text-ui text-muted">{models.find((m) => m.id === def)?.name ?? (def || "None")}</span>
        </SettingRow>
        <SettingRow
          label="Ask before a model switch that adds at least"
          hint="A switch that loses the cache asks first when it adds at least this much."
          help="A switch to another model reads the cached conversation again without the cache, and the model picker shows on each row what that adds. A switch asks first when it adds at least this much, when the new model has no price, or when the conversation is past where the new model compacts. 0 asks before every switch that loses a warm cache."
        >
          <SwitchAskField />
        </SettingRow>
        <SettingRow
          label="Small models"
          hint="They read long material and write session titles, best first."
          help="They read long material for every session (files and logs handed to readers, a long page, new mail) and write session titles, best first; the next one reads when one is not listed or fails. Empty: the cheapest model of the session's own provider, and a session's title only from a model cheaper than its own."
        >
          <SmallModels />
        </SettingRow>
        <SettingRow label="Listings" hint={`${models.length} models from ${byProvider.length} providers, as each provider lists them.`}>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setBusy(true); actions.loadModels(true).catch(reportError).finally(() => setBusy(false)); }}
            className="k-btn k-btn-lg"
          >
            {busy ? "Reading" : "Read again"}
          </button>
        </SettingRow>
      </Card>
      <RouteChange />
      {byProvider.map(([p, list]) => (
        <Card key={p}>
          <div className="flex items-center py-3 text-ui font-medium">{p}<span className="ml-2 font-normal text-faint">{list.length}</span></div>
          <div className="-mx-5 border-t border-line">
            {list.map((m) => (
              <div key={m.id} className="flex h-9 items-center gap-3 border-b border-line/60 px-5 text-ui last:border-0">
                <span className="min-w-0 truncate">{m.name}</span>
                {m.id === def && <span className="rounded-xs bg-accent-soft px-1.5 text-micro font-medium text-accent-ink">default</span>}
                <span className="ml-auto text-caption tabular-nums text-faint">{m.context ? `${fmtTokens(m.context)} context` : "context unknown"}</span>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function About() {
  const [h, setH] = useState<any>(null);
  useEffect(() => { fetch("/api/health").then((r) => r.json()).then(setH).catch(reportError); }, []);
  return (
    <Card>
      <SettingRow label="Daemon" hint="The process serving this page.">
        <span className="font-mono text-caption text-muted">{h ? `pid ${h.pid}` : "..."}</span>
      </SettingRow>
      <SettingRow label="Address"><span className="font-mono text-caption text-muted">{location.host}</span></SettingRow>
    </Card>
  );
}

settingsSections.add(
  { id: "general", label: "General", words: "theme dark light mode font text size zoom scale send enter", icon: <SlidersHorizontal className="size-4" />, order: 0, component: General },
  { id: "models", label: "Models", words: "providers listing default model effort reasoning thinking small models route out outage unreachable overloaded move agents another provider", icon: <Bot className="size-4" />, order: 10, component: Models },
  { id: "keyboard", label: "Keyboard", words: "shortcuts keys hotkeys", icon: <Keyboard className="size-4" />, order: 80, component: ShortcutList, find: () => everyCommand().filter((c) => c.keys).map((c) => c.label) },
  { id: "about", label: "About", words: "version daemon", icon: <Info className="size-4" />, order: 100, component: About },
);

// Sections grouped by what the owner comes for, the most used first: the everyday
// settings, what it reaches, this computer, and the rest. A section another lane adds
// falls in by id, else under Advanced. The sections that shape the agent are Customize's
// (lib/customize-ids.ts): Settings' rail leaves them out, and a search in Settings finds
// them under their own group and opens them there.
const SETTINGS_GROUPS: [string, string[]][] = [
  ["Basics", ["general", "models", "providers", "safety", "routes", "network", "alerts", "usage", "keyboard"]],
  ["Customize", CUSTOMIZE_GROUPS.flatMap(([, ids]) => ids)],
  ["Connections", ["machines", "phone", "integrations", "pull-requests", "elsewhere", "acp-agents", "helper"]],
  ["This computer", ["health", "resources", "storage", "leftovers", "logs", "daemon"]],
  ["Advanced", ["telemetry", "observability", "experiments", "about"]],
];
type Kind = "settings" | "customize";
const grouping = (groups: [string, string[]][], other: string) => {
  const group: Record<string, string> = Object.fromEntries(groups.flatMap(([g, ids]) => ids.map((id) => [id, g])));
  const rank: Record<string, number> = Object.fromEntries(groups.flatMap(([, ids]) => ids).map((id, i) => [id, i]));
  const order = groups.map(([g]) => g);
  return { rank, order, of: (id?: string) => (id ? group[id] ?? other : "") };
};
const BY_KIND: Record<Kind, ReturnType<typeof grouping>> = { settings: grouping(SETTINGS_GROUPS, "Advanced"), customize: grouping(CUSTOMIZE_GROUPS, "Extend it") };
// The rows and headings of each section, read from the source when the page is bundled.
const FIND: Record<string, string[]> = settingsFind();
// The groups the rail keeps folded at rest: what the owner rarely comes for. A group opens when the
// section shown is in it, when it is opened by its head, and while a word is searched.
const FOLDED = new Set(["This computer", "Advanced"]);
// One width rule: a page keeps the reading measure (rows, lists, forms), and takes the width only when it
// holds what needs it (a chart, a table of many columns, a list beside its detail). Its id is listed here.
const WIDE = new Set(["usage", "lessons", "routes", "network", "telemetry", "observability", "experiments", "resources", "storage", "leftovers", "health", "machines", "mcp", "lsp", "skills", "commands", "agents", "plugins", "hooks", "instructions", "logs", "port"]);

// A row found by its name is brought into view and marked a moment, once its
// section has drawn it (a section loads on its own: it is watched for, not waited).
// A row that is not drawn (a server since removed, a part shown only in some
// states) is said to be missing, not given up on in silence.
const NAMED_ON_PAGE = ".k-settings-scroll :is(.k-setting > div > div:first-child, h2, h3, h4, .k-label, [data-name], .k-entry-name, .k-surface-title, [data-testid=shortcut-row] > span:first-child)";
function reveal(name: string, missed: (name: string) => void) {
  const norm = (el: Element) => (el.getAttribute("data-name") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  const find = () => {
    const els = [...document.querySelectorAll<HTMLElement>(NAMED_ON_PAGE)];
    return els.find((el) => norm(el) === name) ?? els.find((el) => norm(el).toLowerCase().includes(name.toLowerCase()));
  };
  const mark = (el: HTMLElement) => {
    // A ledger entry opens; a row is brought into view.
    if (el.matches("[data-name]") && el.tagName === "BUTTON") el.click();
    const row = el.closest<HTMLElement>(".k-setting, [data-testid=shortcut-row], [data-name]") ?? el;
    row.scrollIntoView({ block: "center" });
    row.dataset.found = "";
    row.addEventListener("animationend", () => delete row.dataset.found, { once: true });
  };
  const now = find();
  if (now) return mark(now);
  const watch = new MutationObserver(() => { const el = find(); if (el) { watch.disconnect(); clearTimeout(gone); mark(el); } });
  watch.observe(document.body, { childList: true, subtree: true });
  const gone = setTimeout(() => { watch.disconnect(); missed(name); }, 4000);
}

// A wide page keeps the grouped rail beside the section. A narrow one (by the
// page's own width, so the session list and the text size count) names the
// section in a bar under the head: the bar is the section's title and opens
// the same search and grouped list in place of the section.
// Customize is this page on its own sections: one component for both, so a search in Settings that
// opens a Customize section keeps what was typed and the note of a row that is not drawn.
const PAGE: Record<Kind, { title: string; find: string }> = {
  settings: { title: "Settings", find: "Find a setting" },
  customize: { title: "Customize", find: "Find in Customize" },
};
export function Settings({ kind = "settings", section }: { kind?: Kind; section: string }) {
  const { rank: RANK, order: ORDER, of: groupOf } = BY_KIND[kind];
  useSyncExternalStore(settingsSections.subscribe, settingsSections.version);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const jump = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const sidebar = useUI((s) => s.sidebar);
  // The sections of this page's rail; a word typed in Settings also finds the sections of Customize.
  const mine = (s: { id: string }) => isCustomize(s.id) === (kind === "customize");
  const everything = settingsSections.all().filter((s) => mine(s) || (kind === "settings" && q.trim()));
  const all = everything.sort((a, b) => ORDER.indexOf(groupOf(a.id)) - ORDER.indexOf(groupOf(b.id)) || (RANK[a.id] ?? 999) - (RANK[b.id] ?? 999) || (a.order ?? 50) - (b.order ?? 50));
  // The grouped rail stands beside the section only on a wide page (there the bar that opens the list is not drawn);
  // a narrow page's list is the whole list, so the folds are the wide rail's own.
  const [railed, setRailed] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const look = () => setRailed(!jump.current?.offsetParent);
    look();
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // What sections draw at run time (an MCP server, a shortcut's command), read once a word is typed.
  const [live, setLive] = useState<Record<string, string[]>>({});
  const asked = useRef(false);
  useEffect(() => {
    if (!q.trim() || asked.current) return;
    asked.current = true;
    for (const s of all) if (s.find) Promise.resolve().then(s.find).then((names) => setLive((l) => ({ ...l, [s.id]: names })), () => {});
  }, [q]);
  // Each word finds a section by its name and words, and by the rows it holds: those rows are named under it.
  const found = findSettings(all, (id) => [...(FIND[id] ?? []), ...(live[id] ?? [])], q);
  const shown = found.map((f) => f.section);
  const hits = (id: string) => (q.trim() ? found.find((f) => f.section.id === id)?.rows ?? [] : []);
  // A row the search named that the page does not draw now: said under the title.
  const [missing, setMissing] = useState<string | null>(null);
  useEffect(() => setMissing(null), [section]);
  const cur = all.find((s) => s.id === section && mine(s)) ?? all.find(mine) ?? all[0]!;
  const folds = kind === "settings" && railed && !q.trim();
  const foldedGroup = (g: string) => folds && FOLDED.has(g) && !unfolded.has(g) && g !== groupOf(cur.id);
  const Body = cur.component;
  // The section shown has its row in view: on a direct link to a late one, and when the list opens.
  useEffect(() => { list.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: open ? "center" : "nearest" }); }, [cur.id, open]);
  const close = () => { setOpen(false); setQ(""); jump.current?.focus(); };
  // The list's buttons in their order: a section, then the rows found in it.
  const results = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  // From the field: Enter opens the first result (a row found, else its section), Down goes into the list, and on a wide page Escape
  // clears what was typed (on a narrow one it closes the list, as before: the rail's own key).
  const findKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing(e)) return; // an input method's Enter confirms its word, its Escape drops it
    // (The first section's first row when the words named one: it is the closer answer.)
    if (e.key === "Enter" && q.trim()) { e.preventDefault(); const [a, b] = results(); (b?.matches(".k-settings-hit") ? b : a)?.click(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); results()[0]?.focus(); }
    else if (e.key === "Escape" && q && !open) { e.preventDefault(); e.stopPropagation(); setQ(""); }
  };
  // In the list: Up and Down move along it, Up from the first goes back to the field.
  const listKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = results(), at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) find.current?.focus();
    else all[Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };
  // A section reached from elsewhere (the palette, a link, Back) while the list is open: the list gives way to it.
  useEffect(() => setOpen(false), [section]);
  const go = (id: string, row?: string) => {
    navigate(isCustomize(id) ? { name: "customize", section: id } : { name: "settings", section: id }, true);
    setMissing(null);
    if (row) reveal(row, setMissing);
    // Only where the bar is on screen (a narrow page): a rail click on a wide page keeps the search as typed.
    if (open && jump.current?.offsetParent) close();
  };

  return (
    <div ref={root} className="k-settings flex min-h-0 flex-1 flex-col" data-testid={kind} data-kind={kind}>
      <header className="k-page-head k-surface-head">
        {!sidebar && (
          <button type="button" aria-label="Show the sidebar" onClick={() => savePref("sidebar", true)} className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg md:hidden">
            <Menu className="size-4" />
          </button>
        )}
        <button type="button" onClick={() => history.length > 1 ? history.back() : navigate({ name: "new" })} aria-label="Back" className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-muted hover:bg-hover hover:text-fg">
          <ArrowLeft className="size-4" /><span className="k-settings-back-word">Back</span>
        </button>
        <h1 className="k-surface-title min-w-0 truncate">{PAGE[kind].title}</h1>
      </header>
      <div className="k-settings-main">
        <nav className="k-settings-rail" aria-label={`${PAGE[kind].title} sections`} data-open={open || undefined} onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
          <button ref={jump} type="button" className="k-settings-jump" data-testid="settings-jump" aria-expanded={open} aria-controls="settings-sections" onClick={() => (open ? close() : setOpen(true))}>
            <span className="k-settings-jump-icon" aria-hidden>{cur.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="k-settings-jump-group k-label">{groupOf(cur.id)}</span>
              <span className="k-settings-jump-label">{cur.label}</span>
            </span>
            <span className="k-settings-jump-hint">{open ? "Close" : "All sections"}</span>
            <ChevronDown className="k-settings-jump-mark" aria-hidden />
          </button>
          <div id="settings-sections" className="k-settings-sections">
            <label className="k-settings-find">
              <Search className="size-3.5 shrink-0 text-faint" />
              <input ref={find} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={findKey} placeholder={PAGE[kind].find} aria-label={PAGE[kind].find} data-testid="settings-find" className="w-full min-w-0 bg-transparent outline-none placeholder:text-faint" />
            </label>
            <div ref={list} className="k-settings-nav" onKeyDown={listKey}>
              {shown.map((s, i) => (
                <Fragment key={s.id}>
                  {groupOf(s.id) !== groupOf(shown[i - 1]?.id) && (
                    folds && FOLDED.has(groupOf(s.id)) ? (
                      <h3 className="k-settings-group k-label">
                        <button
                          type="button"
                          className="k-settings-fold"
                          data-group={groupOf(s.id)}
                          aria-expanded={!foldedGroup(groupOf(s.id))}
                          onClick={() => setUnfolded((u) => { const n = new Set(u); n.has(groupOf(s.id)) ? n.delete(groupOf(s.id)) : n.add(groupOf(s.id)); return n; })}
                        >
                          {groupOf(s.id)}
                          <ChevronDown className="k-settings-fold-mark" aria-hidden />
                        </button>
                      </h3>
                    ) : <h3 className="k-settings-group k-label">{groupOf(s.id)}</h3>
                  )}
                  {!foldedGroup(groupOf(s.id)) && <button
                    type="button"
                    onClick={() => go(s.id)}
                    aria-current={s.id === cur.id ? "page" : undefined}
                    data-section={s.id}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-md px-2.5 text-ui text-muted hover:bg-hover hover:text-fg",
                      s.id === cur.id && "k-picked",
                    )}
                  >
                    <span className={s.id === cur.id ? "text-accent" : "text-faint"}>{s.icon}</span>
                    {s.label}
                  </button>}
                  {hits(s.id).map((n) => (
                    <button key={n} type="button" className="k-settings-hit" data-testid="settings-hit" title={n} onClick={() => go(s.id, n)}>{n}</button>
                  ))}
                </Fragment>
              ))}
              {shown.length === 0 && <p className="k-empty px-2.5 py-3" data-testid="settings-none">No section matches. Try another word.</p>}
            </div>
          </div>
        </nav>
        <div className="k-settings-scroll" data-testid="settings-scroll">
          <div className="k-settings-body" data-wide={WIDE.has(cur.id) || undefined}>
            <h2 className="k-set-page-title" data-testid="settings-title">{cur.label}</h2>
            {missing && <p className="k-notice mb-4 text-caption text-muted" role="status" data-testid="settings-missing"><span><span className="text-fg">{missing}</span> is not on this page now: it shows when there is one to show.</span></p>}
            <Body />
          </div>
        </div>
      </div>
    </div>
  );
}
