// The helper's side panel: what it remembers (each item editable and
// removable, and their own additions), what it was told about lately, and
// its mail source. Also the helper's settings section.
import { Check, MailCheck, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { addMemory, checkMail, dropMemory, editMemory, openHelper, setHelper, useHelper, type MemoryItem } from "../lib/helper.ts";
import { reportError } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { Card, SettingRow } from "./Settings.tsx";
import { iconButton } from "./ui.tsx";

const KINDS = ["preference", "decision", "person", "commitment", "fact"];
const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Item({ m }: { m: MemoryItem }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const save = () => {
    if (edit === null) return;
    editMemory(m.id, { text: edit }).then(() => { setEdit(null); setErr(""); }, (e) => setErr(failed(e)));
  };
  return (
    <li className="group border-b border-line py-2 last:border-0" data-testid="memory-item" data-kind={m.kind}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded-xs bg-sunken px-1.5 py-px text-micro text-muted">{m.kind}</span>
        {edit === null ? (
          <p className="min-w-0 flex-1 text-ui leading-snug" data-testid="memory-text">{m.text}</p>
        ) : (
          <textarea
            className="min-h-[3.5rem] min-w-0 flex-1 resize-y rounded-md border border-line bg-sunken px-2 py-1 text-ui outline-none focus:border-accent"
            value={edit} autoFocus data-testid="memory-edit" aria-label="Edit the remembered item"
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === "Escape") setEdit(null); }}
          />
        )}
        <span className={cn("flex shrink-0 gap-0.5", edit === null && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100")}>
          {edit === null ? (
            <>
              <button type="button" className={cn(iconButton, "size-6")} aria-label="Edit" title="Edit" data-testid="memory-edit-button" onClick={() => setEdit(m.text)}><Pencil className="size-3.5" /></button>
              <button type="button" className={cn(iconButton, "size-6 hover:text-danger")} aria-label="Forget" title="Forget" data-testid="memory-delete" onClick={() => dropMemory(m.id).catch(reportError)}><Trash2 className="size-3.5" /></button>
            </>
          ) : (
            <>
              <button type="button" className={cn(iconButton, "size-6")} aria-label="Save" title="Save" data-testid="memory-save" onClick={save}><Check className="size-3.5" /></button>
              <button type="button" className={cn(iconButton, "size-6")} aria-label="Cancel" title="Cancel" onClick={() => setEdit(null)}><X className="size-3.5" /></button>
            </>
          )}
        </span>
      </div>
      <div className="mt-1 pl-0.5 text-micro text-faint">{m.source === "owner" ? "You" : "The helper"}, {ago(m.updated) === "now" ? "just now" : `${ago(m.updated)} ago`}{m.used ? `, recalled ${m.used}x` : ""}</div>
      {err && <p className="mt-1 text-micro text-danger" role="alert">{err}</p>}
    </li>
  );
}

function AddItem() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("fact");
  const [err, setErr] = useState("");
  const add = () => {
    if (!text.trim()) return;
    addMemory(text, kind).then(() => { setText(""); setErr(""); }, (e) => setErr(failed(e)));
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <input
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-sunken px-2 text-ui outline-none placeholder:text-faint focus:border-accent"
          placeholder="Remember something" value={text} data-testid="memory-new" aria-label="Something to remember"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind" className="h-8 w-28">
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </Select>
        <button type="button" className={cn(iconButton, "size-8")} aria-label="Add" title="Add" data-testid="memory-add" onClick={add}><Plus className="size-4" /></button>
      </div>
      {err && <p className="text-micro text-danger" role="alert">{err}</p>}
    </div>
  );
}

export function HelperPanel(_: { session: Session }) {
  const view = useHelper((s) => s.view);
  const memory = useHelper((s) => s.memory);
  const [checked, setChecked] = useState("");
  const events = (view?.events ?? []).slice(-12).reverse();
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4" data-testid="helper-panel">
      <section aria-labelledby="helper-mem">
        <h3 id="helper-mem" className="flex items-baseline gap-2 text-ui font-semibold">
          Remembered <span className="text-caption font-normal tabular-nums text-faint">{memory.length}</span>
        </h3>
        <p className="mt-0.5 text-caption text-muted">What the helper chose to keep. Edit or forget anything; nothing secret is kept.</p>
        {memory.length ? <ul className="mt-2" data-testid="memory-list">{memory.map((m) => <Item key={m.id} m={m} />)}</ul>
          : <p className="mt-3 text-caption text-faint" data-testid="memory-empty">Nothing yet.</p>}
        <AddItem />
      </section>

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
        ) : <p className="mt-2 text-caption text-faint">Nothing since the helper started.</p>}
      </section>

      <section aria-labelledby="helper-mail" className="mt-auto border-t border-line pt-3">
        <h3 id="helper-mail" className="text-ui font-semibold">Mail</h3>
        <p className="mt-0.5 text-caption text-muted" data-testid="helper-mail-status">
          {view?.mail.available ? `${view.mail.label}: ${view.mail.account ?? "connected"}` : `${view?.mail.label ?? "Mail"}: not connected`}
          {view?.mail.available && view.mail_every_min ? `, checked every ${view.mail_every_min} min` : ""}
        </p>
        {view?.mail.available && (
          <button type="button" className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-caption text-muted hover:bg-hover hover:text-fg" data-testid="helper-check"
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
        <SettingRow label="Helper" hint="One conversation that never ends, at the top of the list (Ctrl J). It follows your sessions, checks your mail, and keeps what is worth remembering. Off: no wakes and no mail checks; the conversation and the list stay.">
          <button type="button" role="switch" aria-checked={view.on} data-testid="helper-on" aria-label="Helper on"
            onClick={() => (view.on ? setHelper({ on: false }) : openHelper()).catch(reportError)}
            className={cn("relative flex h-5 w-9 rounded-full p-0.5 transition-colors", view.on ? "bg-accent" : "bg-line-strong")}>
            <span className={cn("size-4 rounded-full bg-raised transition-transform", view.on && "translate-x-4")} />
          </button>
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
        <SettingRow label="Remembered" hint="Kept in this daemon's state. Other agents' MCP servers set up in Settings reach the helper too.">
          <span className="text-ui tabular-nums text-muted">{memory} items</span>
        </SettingRow>
      </Card>
    </div>
  );
}
