// The helper's side panel: its memory (keyed records the helper keeps and
// the owner searches, edits, adds and deletes), what it was told about
// lately, and its mail source. Also the helper's settings section.
import { Check, MailCheck, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { addMemory, checkMail, dropMemory, editMemory, openHelper, setHelper, useHelper, type MemoryRecord } from "../lib/helper.ts";
import { reportError } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { MemorySweep } from "./MemorySweep.tsx";
import { Select } from "./Select.tsx";
import { Card, SettingRow } from "./Settings.tsx";
import { iconButton } from "./ui.tsx";
import { HelperFace, useHelperName } from "./HelperFace.tsx";
import { HelperIdentity } from "./HelperIdentity.tsx";
import { navigate } from "../lib/ui.ts";
import { composing } from "../lib/keys.ts";

const KINDS = ["fact", "person", "preference", "decision", "commitment", "reference"];
const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = "k-field min-w-0";
const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
// The list shows this many records; the search narrows the rest.
const SHOWN = 60;

// Matches the search box: every word in the key, value, aliases or topics.
const matches = (m: MemoryRecord, q: string) => {
  const hay = `${m.key} ${m.value} ${m.aliases.join(" ")} ${m.topics.join(" ")} ${m.kind}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

function Item({ m }: { m: MemoryRecord }) {
  // An alias that only repeats the value (a label's name) is not shown twice.
  const aliases = m.aliases.filter((a) => a !== m.value.toLowerCase());
  const [edit, setEdit] = useState<{ value: string; aliases: string; topics: string } | null>(null);
  const [err, setErr] = useState("");
  const save = () => {
    if (!edit) return;
    editMemory(m.key, { value: edit.value, aliases: split(edit.aliases), topics: split(edit.topics) }).then(() => { setEdit(null); setErr(""); }, (e) => setErr(failed(e)));
  };
  const keys = (e: React.KeyboardEvent) => { if (composing(e)) return; if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === "Escape") setEdit(null); };
  return (
    <li className="group border-b border-line py-2 last:border-0" data-testid="memory-item" data-key={m.key} data-kind={m.kind}>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-micro text-accent-ink max-md:whitespace-normal max-md:break-all" data-testid="memory-key" title={m.key}>{m.key}</code>
        <span className="shrink-0 rounded-xs bg-sunken px-1.5 py-px text-micro text-muted">{m.kind}</span>
        <span className={cn("flex shrink-0 gap-0.5", !edit && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100")}>
          {!edit ? (
            <>
              <button type="button" className={cn(iconButton, "size-6")} aria-label="Edit" title="Edit" data-testid="memory-edit-button" onClick={() => setEdit({ value: m.value, aliases: m.aliases.join(", "), topics: m.topics.join(", ") })}><Pencil className="size-3.5" /></button>
              <button type="button" className={cn(iconButton, "size-6 hover:text-danger")} aria-label="Delete" title="Delete" data-testid="memory-delete" onClick={() => dropMemory(m.key).catch(reportError)}><Trash2 className="size-3.5" /></button>
            </>
          ) : (
            <>
              <button type="button" className={cn(iconButton, "size-6")} aria-label="Save" title="Save" data-testid="memory-save" onClick={save}><Check className="size-3.5" /></button>
              <button type="button" className={cn(iconButton, "size-6")} aria-label="Cancel" title="Cancel" onClick={() => setEdit(null)}><X className="size-3.5" /></button>
            </>
          )}
        </span>
      </div>
      {!edit ? (
        <p className="mt-0.5 text-ui leading-snug" data-testid="memory-text">{m.value}</p>
      ) : (
        <div className="mt-1 flex flex-col gap-1.5">
          <textarea className={cn(field, "min-h-[3.5rem] resize-y py-1")} value={edit.value} autoFocus data-testid="memory-edit" aria-label="Value" onChange={(e) => setEdit({ ...edit, value: e.target.value })} onKeyDown={keys} />
          <input className={cn(field, "h-7 text-caption")} value={edit.aliases} placeholder="Aliases, comma separated" data-testid="memory-edit-aliases" aria-label="Aliases" onChange={(e) => setEdit({ ...edit, aliases: e.target.value })} onKeyDown={keys} />
          <input className={cn(field, "h-7 text-caption")} value={edit.topics} placeholder="Topics, comma separated" data-testid="memory-edit-topics" aria-label="Topics" onChange={(e) => setEdit({ ...edit, topics: e.target.value })} onKeyDown={keys} />
        </div>
      )}
      {!edit && (aliases.length > 0 || m.topics.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-1" data-testid="memory-terms">
          {aliases.map((a) => <span key={`a${a}`} className="rounded-xs border border-line px-1.5 text-micro text-muted" data-testid="memory-alias">{a}</span>)}
          {m.topics.map((t) => <span key={`t${t}`} className="rounded-xs bg-accent-soft px-1.5 text-micro text-accent-ink" data-testid="memory-topic">#{t}</span>)}
        </div>
      )}
      <div className="mt-1 text-micro text-faint">{m.source === "owner" ? "You" : m.source === "import" ? "Imported" : "The helper"}, {ago(m.updated) === "now" ? "just now" : `${ago(m.updated)} ago`}{m.used ? `, used ${m.used}x` : ""}</div>
      {err && <p className="mt-1 text-micro text-danger" role="alert">{err}</p>}
    </li>
  );
}

function AddItem() {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("fact");
  const [err, setErr] = useState("");
  const add = () => {
    if (!value.trim()) return;
    addMemory({ key: key.trim() || undefined, value, kind }).then(() => { setKey(""); setValue(""); setErr(""); }, (e) => setErr(failed(e)));
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-line p-2">
      <div className="flex gap-1.5">
        <input className={cn(field, "h-7 flex-1 font-mono text-micro")} placeholder="key, such as person.dana (optional)" value={key} data-testid="memory-new-key" aria-label="Key"
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) add(); }} />
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" className="k-field-sm w-28">
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </Select>
      </div>
      <div className="flex gap-1.5">
        <input className={cn(field, "h-8 flex-1")} placeholder="Remember something" value={value} data-testid="memory-new" aria-label="Something to remember"
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) add(); }} />
        <button type="button" className={cn(iconButton, "size-8")} aria-label="Add" title="Add" data-testid="memory-add" onClick={add}><Plus className="size-4" /></button>
      </div>
      {err && <p className="text-micro text-danger" role="alert">{err}</p>}
    </div>
  );
}

function MemoryList() {
  const memory = useHelper((s) => s.memory);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const found = useMemo(() => (q.trim() ? memory.filter((m) => matches(m, q)) : memory), [memory, q]);
  const shown = all ? found : found.slice(0, SHOWN);
  return (
    <section aria-labelledby="helper-mem">
      <h3 id="helper-mem" className="flex items-baseline gap-2 text-ui font-semibold">
        Memory <span className="text-caption font-normal tabular-nums text-faint" data-testid="memory-count">{memory.length}</span>
      </h3>
      <p className="mt-0.5 text-caption text-muted">One fact per key. The helper looks facts up by key or alias instead of reading files again. Edit or delete anything; nothing secret is kept.</p>
      {memory.length > 0 && (
        <label className={cn(field, "mt-2 flex h-8 items-center gap-1.5")}>
          <Search className="size-3.5 shrink-0 text-faint" />
          <input className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" placeholder="Search keys, values, aliases, topics" value={q} data-testid="memory-search" aria-label="Search memory"
            onChange={(e) => { setQ(e.target.value); setAll(false); }} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} />
          {q && <span className="shrink-0 text-micro tabular-nums text-faint" data-testid="memory-found">{found.length}</span>}
        </label>
      )}
      {shown.length ? <ul className="mt-1" data-testid="memory-list">{shown.map((m) => <Item key={m.key} m={m} />)}</ul>
        : <p className="mt-3 text-caption text-faint" data-testid="memory-empty">{q ? "No record matches." : "Nothing yet."}</p>}
      {found.length > shown.length && (
        <button type="button" className="mt-1 text-caption text-muted hover:text-fg" data-testid="memory-more" onClick={() => setAll(true)}>Show all {found.length}</button>
      )}
      <AddItem />
    </section>
  );
}

export function HelperPanel(_: { session: Session }) {
  const view = useHelper((s) => s.view);
  const [checked, setChecked] = useState("");
  const events = (view?.events ?? []).slice(-12).reverse();
  const name = useHelperName();
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4" data-testid="helper-panel">
      <header className="flex items-center gap-3" data-testid="helper-head">
        <HelperFace size="head" testid="helper-head-face" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold" data-testid="helper-head-name">{name}</h2>
          <button type="button" className="text-caption text-muted hover:text-fg" onClick={() => navigate({ name: "settings", section: "helper" })} data-testid="helper-head-edit">Name and picture</button>
        </div>
      </header>
      <MemoryList />

      <MemorySweep compact />

      <section aria-labelledby="helper-ev">
        <h3 id="helper-ev" className="text-ui font-semibold">Lately</h3>
        {events.length ? (
          <ul className="mt-2 space-y-1.5" data-testid="helper-events">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2 text-caption" data-testid="helper-event" data-kind={e.kind}>
                <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", e.level === "wake" ? "bg-warn" : "bg-line-strong")} />
                <span className="min-w-0 flex-1"><span className="text-fg">{e.title}</span>{e.body && <span className="text-muted">: {e.body}</span>}</span>
                <span className="shrink-0 tabular-nums text-faint" title={when(e.ts)}>{ago(e.ts)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="k-empty mt-2">Nothing since the helper started.</p>}
      </section>

      <section aria-labelledby="helper-mail" className="mt-auto border-t border-line pt-3">
        <h3 id="helper-mail" className="text-ui font-semibold">Mail</h3>
        <p className="mt-0.5 text-caption text-muted" data-testid="helper-mail-status">
          {view?.mail.available ? `${view.mail.label}: ${view.mail.account ?? "connected"}` : `${view?.mail.label ?? "Mail"}: not connected`}
          {view?.mail.available && view.mail_every_min ? `, checked every ${view.mail_every_min} min` : ""}
        </p>
        {view?.mail.available && (
          <button type="button" className="k-btn mt-2" data-testid="helper-check"
            onClick={() => checkMail().then((r) => setChecked(r.new ? `${r.new} new, ${r.important} for you` : "Nothing new"), (e) => setChecked(failed(e)))}>
            <MailCheck className="size-3.5" />Check now
          </button>
        )}
        {checked && <span className="ml-2 text-caption text-faint" data-testid="helper-checked">{checked}</span>}
      </section>
    </div>
  );
}

const MINUTES = [0, 5, 10, 15, 30, 60];

export function HelperSettings() {
  const view = useHelper((s) => s.view);
  const memory = useHelper((s) => s.memory.length);
  if (!view) return null;
  const mins = (v: number) => (v ? `${v} min` : "Off");
  return (
    <div className="flex flex-col gap-4" data-testid="helper-settings">
      <Card>
        <HelperIdentity />
        <SettingRow label="Helper" hint="One conversation that never ends, at the top of the list (Ctrl J). It follows your sessions, checks your mail, and keeps what is worth remembering. Off: no wakes and no mail checks; the conversation and the list stay.">
          <div className="flex items-center gap-3">
            {view.on && view.session_id && <button type="button" data-testid="helper-open" onClick={() => openHelper().catch(reportError)} className="k-link rounded-sm text-ui text-accent-ink hover:underline">Open the conversation</button>}
            {/* The switch stays in Settings: turning it on does not take the page to the conversation (the link beside it does). */}
            <button type="button" role="switch" aria-checked={view.on} data-testid="helper-on" aria-label="Helper on"
              onClick={() => setHelper({ on: !view.on }).catch(reportError)}
              className="k-switch">
              <span className="k-switch-thumb" />
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Mail" hint={view.mail.available ? `${view.mail.label} as ${view.mail.account ?? "your account"}. Sending always asks you first, on a card for that message.` : `Not connected: the helper reads the Google sign-in file named by KEEL_GOOGLE_TOKEN (by default the one Hermes keeps).`}>
          <span className={cn("inline-flex items-center gap-1.5 text-ui", view.mail.available ? "text-fg" : "text-muted")}>
            <span className={cn("size-2 rounded-full", view.mail.available ? "bg-ok" : "bg-line-strong")} />{view.mail.available ? "Connected" : "Not connected"}
          </span>
        </SettingRow>
        <SettingRow label="Check new mail" hint="Only mail that needs you wakes the helper; a cheaper model sorts it first.">
          <Select value={String(view.mail_every_min)} onChange={(e) => setHelper({ mail_every_min: Number(e.target.value) }).catch(reportError)} aria-label="Check new mail every" data-testid="helper-mail-every" className="w-28">
            {MINUTES.map((m) => <option key={m} value={String(m)}>{mins(m)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow label="Wakes at most every" hint="A failure, a usage limit, an error spike or important mail wakes the helper; a burst is one wake. The rest waits for your next message.">
          <Select value={String(view.wake_gap_min)} onChange={(e) => setHelper({ wake_gap_min: Number(e.target.value) }).catch(reportError)} aria-label="Wake gap" data-testid="helper-gap" className="w-28">
            {MINUTES.filter(Boolean).map((m) => <option key={m} value={String(m)}>{mins(m)}</option>)}
          </Select>
        </SettingRow>
        <SettingRow label="Memory" hint="Keyed records kept in this daemon's state, searched and edited in the helper's panel. Other agents' MCP servers set up in Settings reach the helper too.">
          <span className="text-ui tabular-nums text-muted">{memory} records</span>
        </SettingRow>
      </Card>
    </div>
  );
}
