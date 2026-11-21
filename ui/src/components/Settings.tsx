import { Radio } from "@base-ui/react/radio";
import { ArrowLeft, Bot, Info, Keyboard, Menu, Search, SlidersHorizontal } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { settingsSections } from "../lib/extend.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { navigate, savePref, SCALE_NAMES, SCALES, setScale, setTheme, setUI, useUI, type ThemePref } from "../lib/ui.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { Choices } from "./Choices.tsx";
import { ShortcutList } from "./ShortcutSheet.tsx";
import { SmallModels } from "./SmallModels.tsx";

// Settings building blocks other lanes reuse for their sections.
export function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="k-setting flex flex-col gap-3 border-b border-line py-4 last:border-0 sm:flex-row sm:items-center sm:gap-8">
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-ui text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// One choice of a few: a radio group with one Tab stop, on the option chosen;
// the arrows move to the next option and choose it.
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <Choices aria-label={label} value={value} onValueChange={(v) => onChange(v as T)} className="inline-flex rounded-md border border-line bg-sunken p-0.5">
      {options.map((o) => (
        <Radio.Root
          key={o.value}
          value={o.value}
          nativeButton
          render={<button type="button" />}
          className={cn("h-7 rounded-sm px-3 text-ui text-muted transition-colors", value === o.value ? "bg-raised text-fg shadow-1" : "hover:text-fg")}
        >
          {o.label}
        </Radio.Root>
      ))}
    </Choices>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="k-card rounded-lg border border-line bg-raised px-5 shadow-1">{children}</div>;
}

// Text size: six steps, each shown as the letter at its size. It scales the
// whole interface (type, spacing, controls), not the page zoom. The six share
// the row's width in equal parts, so all of them fit a phone at any size.
function TextSize() {
  const scale = useUI((s) => s.scale);
  return (
    <Choices aria-label="Text size" data-testid="text-size" value={scale} onValueChange={(v) => setScale(v as number)} className="grid w-56 max-w-full grid-cols-6 rounded-md border border-line bg-sunken p-0.5">
      {SCALES.map((v, i) => (
        <Radio.Root
          key={v}
          value={v}
          nativeButton
          render={<button type="button" />}
          aria-label={`${SCALE_NAMES[i]}, ${Math.round(v * 100)}%`}
          title={`${SCALE_NAMES[i]} (${Math.round(v * 100)}%)`}
          data-testid={`text-size-${Math.round(v * 100)}`}
          className={cn("grid h-8 min-w-0 place-items-center rounded-sm font-semibold leading-none text-muted transition-colors", scale === v ? "bg-raised text-fg shadow-1" : "hover:text-fg")}
          style={{ fontSize: `${Math.round(13 * v * 10) / 10}px` }}
        >
          A
        </Radio.Root>
      ))}
    </Choices>
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
      <SettingRow label="Text size" hint={`${SCALE_NAMES[SCALES.indexOf(scale as (typeof SCALES)[number])] ?? "Default"}, ${Math.round(scale * 100)}%. Ctrl + and Ctrl - step it from anywhere, Ctrl 0 puts the default back.`}>
        <TextSize />
      </SettingRow>
      <SettingRow label="Send with" hint={enterSends ? "Enter sends, Shift Enter makes a new line." : "Ctrl Enter sends, Enter makes a new line."}>
        <Segmented label="Send with" value={enterSends ? "enter" : "mod"} onChange={(v) => savePref("enterSends", v === "enter")} options={[{ value: "enter", label: "Enter" }, { value: "mod", label: "Ctrl Enter" }]} />
      </SettingRow>
    </Card>
  );
}

function Models() {
  const models = useStore((s) => s.models);
  const def = useStore((s) => s.defaultModel);
  const [busy, setBusy] = useState(false);
  const byProvider = useMemo(() => {
    const m = new Map<string, typeof models>();
    for (const x of models) (m.get(x.provider) ?? m.set(x.provider, []).get(x.provider)!).push(x);
    return [...m.entries()];
  }, [models]);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SettingRow label="Default model" hint="New sessions start on it. It comes from the daemon's configuration.">
          <span className="text-ui text-muted">{models.find((m) => m.id === def)?.name ?? (def || "None")}</span>
        </SettingRow>
        <SettingRow label="Small models" hint="They read long material for every session (files and logs handed to readers, a long page, new mail), best first; the next one reads when one is not listed or fails. Empty: the cheapest model of the session's own provider.">
          <SmallModels />
        </SettingRow>
        <SettingRow label="Listings" hint={`${models.length} models from ${byProvider.length} providers, as each provider lists them.`}>
          <button
            type="button"
            disabled={busy}
            onClick={() => { setBusy(true); actions.loadModels(true).catch(reportError).finally(() => setBusy(false)); }}
            className="h-8 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50"
          >
            {busy ? "Reading" : "Read again"}
          </button>
        </SettingRow>
      </Card>
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
  { id: "general", label: "General", words: "theme dark light send enter", icon: <SlidersHorizontal className="size-4" />, order: 0, component: General },
  { id: "models", label: "Models", words: "providers listing default model", icon: <Bot className="size-4" />, order: 10, component: Models },
  { id: "keyboard", label: "Keyboard", words: "shortcuts keys hotkeys", icon: <Keyboard className="size-4" />, order: 80, component: ShortcutList },
  { id: "about", label: "About", words: "version daemon", icon: <Info className="size-4" />, order: 100, component: About },
);

// Sections grouped by what they are about; a section another lane adds falls in by id, else under More.
const GROUP: Record<string, string> = {
  general: "Working", models: "Working", providers: "Working", keyboard: "Working", voice: "Working",
  mcp: "Toolkit", skills: "Toolkit", commands: "Toolkit", agents: "Toolkit", plugins: "Toolkit", hooks: "Toolkit", instructions: "Toolkit",
  safety: "Safety", alerts: "Safety",
  machines: "Machine", resources: "Machine", storage: "Machine", daemon: "Machine", phone: "Machine", usage: "Machine", logs: "Machine",
  integrations: "Reach", "acp-agents": "Reach", elsewhere: "Reach", export: "Reach", port: "Reach",
  about: "Keel",
};
const ORDER = ["Working", "Toolkit", "Safety", "Machine", "Reach", "More", "Keel"];
const groupOf = (id?: string) => (id ? GROUP[id] ?? "More" : "");
// Sections of figures and lists use the width; forms keep a reading measure.
const WIDE = new Set(["usage", "observability", "experiments", "resources", "storage", "machines", "models", "mcp", "skills", "commands", "agents", "plugins", "hooks", "instructions", "logs", "port"]);

export function Settings({ section }: { section: string }) {
  useSyncExternalStore(settingsSections.subscribe, settingsSections.version);
  const [q, setQ] = useState("");
  const sidebar = useUI((s) => s.sidebar);
  const all = settingsSections.all().sort((a, b) => ORDER.indexOf(groupOf(a.id)) - ORDER.indexOf(groupOf(b.id)) || (a.order ?? 50) - (b.order ?? 50));
  const shown = q ? all.filter((s) => `${s.label} ${s.words ?? ""}`.toLowerCase().includes(q.toLowerCase())) : all;
  const cur = all.find((s) => s.id === section) ?? all[0]!;
  const Body = cur.component;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="settings">
      <header className="k-page-head flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:px-5">
        {!sidebar && (
          <button type="button" aria-label="Show the sidebar" onClick={() => savePref("sidebar", true)} className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg md:hidden">
            <Menu className="size-4" />
          </button>
        )}
        <button type="button" onClick={() => history.length > 1 ? history.back() : navigate({ name: "new" })} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted hover:bg-hover hover:text-fg">
          <ArrowLeft className="size-4" /> Back
        </button>
        <h1 className="text-base font-semibold">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="shrink-0 border-line p-3 md:w-60 md:overflow-y-auto md:border-r md:p-4" aria-label="Settings sections">
          <label className="mb-3 flex h-8 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-ui focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a setting" placeholder="Find a setting" className="w-full min-w-0 bg-transparent outline-none placeholder:text-faint" />
          </label>
          <div className="k-settings-nav flex gap-1 overflow-x-auto md:flex-col md:gap-px">
            {shown.map((s, i) => (
              <Fragment key={s.id}>
              {groupOf(s.id) !== groupOf(shown[i - 1]?.id) && <h3 className="k-settings-group">{groupOf(s.id)}</h3>}
              <button
                type="button"
                onClick={() => navigate({ name: "settings", section: s.id }, true)}
                aria-current={s.id === cur.id ? "page" : undefined}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-ui text-muted hover:bg-hover hover:text-fg",
                  s.id === cur.id && "bg-raised text-fg shadow-1 hover:bg-raised",
                )}
              >
                <span className={s.id === cur.id ? "text-accent" : "text-faint"}>{s.icon}</span>
                {s.label}
              </button>
              </Fragment>
            ))}
          </div>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="k-settings-body px-4 py-6 md:px-12 md:py-10" data-wide={WIDE.has(cur.id) || undefined}>
            <h2 className="mb-5 text-title font-semibold tracking-[-0.015em]" data-testid="settings-title">{cur.label}</h2>
            <Body />
          </div>
        </div>
      </div>
    </div>
  );
}

