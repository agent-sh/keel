// The toolkit pages' instrument: a ledger of entries grouped by where each
// comes from, the reader beside it, the file editor, the folder they are seen
// from. Styles in toolkit.css.
import { Switch } from "@base-ui/react/switch";
import { Plus, Search } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, reportError, failed, workspaces } from "../../lib/store.ts";
import { WorkspacePicker } from "../WorkspacePicker.tsx";
import { Seg as Track } from "../Seg.tsx";

export type Mark = "on" | "off" | "need" | "fail" | "work";
const WATCH: Record<Mark, string | undefined> = { on: undefined, off: "idle", need: "need", fail: "fail", work: "work" };
export const MarkDot = ({ m, label }: { m: Mark; label?: string }) => <span className="k-mark" data-watch={WATCH[m]} role="img" aria-label={label ?? m} />;

export const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~");
// A long path keeps its end, where the names that tell folders apart are.
export const tail = (p: string, n = 34) => { const t = tilde(p); return t.length <= n ? t : `…${t.slice(t.length - n + 1)}`; };
export const tok = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

// The folder project entries are seen from, shared by every page while Settings is open.
let folder = "";
const subs = new Set<() => void>();
const setFolder = (f: string) => { folder = f; subs.forEach((s) => s()); };
export function useFolder(): [string, (f: string) => void] {
  const f = useSyncExternalStore((s) => (subs.add(s), () => void subs.delete(s)), () => folder);
  useEffect(() => {
    if (!folder) workspaces().then((r) => folder || setFolder(r.recent[0]?.path ?? r.default)).catch(reportError);
  }, []);
  return [f, setFolder];
}

// The folder line on top of a page, with its tally; `global` pages hold the same for every folder.
export function FolderLine({ tally, global }: { tally?: { n: number; label: string; tone?: "need" | "fail" }[]; global?: string }) {
  const [f, set] = useFolder();
  return (
    <div className="k-folder" data-testid="toolkit-folder">
      {global ? <span className="k-folder-label k-label">{global}</span> : <><span className="k-folder-label k-label">Seen from</span><WorkspacePicker value={f} onChange={set} /></>}
      {tally && (
        <div className="k-tally" data-testid="toolkit-tally">
          {tally.map((t) => <div key={t.label} data-tone={t.tone}><b>{t.n}</b><span>{t.label}</span></div>)}
        </div>
      )}
    </div>
  );
}

export type Entry = { id: string; name: string; desc?: string; aside?: ReactNode; mark: Mark; markLabel?: string; testid?: string; data?: Record<string, string> };
export type Group = { id: string; title: string; path?: string; entries: Entry[] };

export function Ledger({ groups, selected, onSelect, add, children, testid, empty }: {
  groups: Group[]; selected: string | null; onSelect: (id: string) => void;
  add?: { label: string; id: string }[]; children: ReactNode; testid?: string; empty?: string;
}) {
  const [q, setQ] = useState("");
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  const w = q.trim().toLowerCase();
  const shown = groups
    .map((g) => (w ? { ...g, entries: g.entries.filter((e) => `${e.name} ${e.desc ?? ""}`.toLowerCase().includes(w)) } : g))
    .filter((g) => g.entries.length);
  return (
    <div className="k-ledger" data-testid={testid}>
      <div className="k-ledger-list" role="listbox" aria-label="Entries" data-find={total > 8 || undefined}>
        {total > 8 && (
          <label className="k-ledger-find">
            <Search />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find among ${total}`} data-testid="ledger-find" />
          </label>
        )}
        {!shown.length && <p className="k-empty p-4">{empty ?? "Nothing here yet."}</p>}
        {shown.map((g) => (
          <div key={g.id} data-testid="toolkit-group" data-group={g.id}>
            <div className="k-src"><b>{g.title}</b>{g.path && <code title={g.path}>{tail(g.path)}</code>}<i>{g.entries.length}</i></div>
            {g.entries.map((e) => (
              <button
                key={e.id}
                type="button"
                role="option"
                aria-selected={selected === e.id}
                aria-current={selected === e.id}
                data-testid={e.testid ?? "toolkit-entry"}
                data-name={e.name}
                data-mark={e.mark}
                data-off={e.mark === "off" || undefined}
                className={selected === e.id ? "k-entry k-picked" : "k-entry"}
                {...e.data}
                onClick={() => onSelect(e.id)}
              >
                <MarkDot m={e.mark} label={e.markLabel} />
                <span className="k-entry-name">{e.name}</span>
                <span className="k-entry-aside">{e.aside}</span>
                {e.desc && <span className="k-entry-desc">{e.desc}</span>}
              </button>
            ))}
          </div>
        ))}
        {add?.map((a) => (
          <button key={a.id} type="button" data-add className={selected === a.id ? "k-entry k-picked" : "k-entry"} aria-current={selected === a.id} data-testid={`toolkit-add-${a.id}`} onClick={() => onSelect(a.id)}>
            <Plus /><span className="k-entry-name">{a.label}</span>
          </button>
        ))}
      </div>
      <div className="k-reader">{children}</div>
    </div>
  );
}

export function ReaderHead({ title, desc, path, facts, right, children }: { title: string; desc?: ReactNode; path?: string | null; facts?: [string, ReactNode][]; right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="k-reader-head">
      <div className="k-reader-title"><h3 data-testid="reader-title">{title}</h3>{right}</div>
      {desc && <p className="k-reader-desc">{desc}</p>}
      {path && <code className="k-path" title={path}>{tilde(path)}</code>}
      {facts && facts.length > 0 && (
        <dl className="k-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      )}
      {children}
    </div>
  );
}

export const Blank = ({ title, children }: { title: string; children?: ReactNode }) => <div className="k-empty p-6"><b>{title}</b>{children}</div>;

// A mark in a grid of choices (which alert goes where): a box that is ticked or not. A grid
// of switches is a wall of pills; a grid of marks reads as the table it is.
// `mixed`: a row of marks that are not all alike; a press turns them all on.
export function Tick({ on, onChange, label, testid, mixed, disabled, title }: { on: boolean; onChange: (on: boolean) => void; label: string; testid?: string; mixed?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" role="checkbox" aria-checked={mixed ? "mixed" : on} aria-label={label} aria-disabled={disabled || undefined} disabled={disabled} title={title} data-testid={testid} className="k-check" onClick={() => onChange(mixed ? true : !on)} />;
}

export function Toggle({ on, onChange, label, testid }: { on: boolean; onChange: (on: boolean) => void; label: string; testid?: string }) {
  return (
    <Switch.Root checked={on} onCheckedChange={onChange} aria-label={label} data-testid={testid} className="k-switch">
      <Switch.Thumb className="k-switch-thumb" />
    </Switch.Root>
  );
}

export function Seg<T extends string>({ value, options, onChange, label, manual }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; manual?: boolean }) {
  return (
    <Track label={label} manual={manual} value={value} onChange={onChange} options={options.map(([v, l]) => ({ value: v, label: l, testid: `seg-${v}` }))} />
  );
}

// The file itself. Ctrl S saves; amber while it holds changes not saved.
export function FileEditor({ name, text, onSave, readOnly, note, testid = "file-editor" }: {
  name: string; text: string; onSave?: (t: string) => Promise<string | void>; readOnly?: boolean | string; note?: ReactNode; testid?: string;
}) {
  const [draft, setDraft] = useState(text);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const [err, setErr] = useState("");
  const base = useRef(text);
  // A new text from outside (another entry, a reload) replaces the draft; the text a save sent back does not.
  useEffect(() => {
    if (text === base.current) return;
    base.current = text;
    setDraft(text);
    setErr("");
    setState("");
  }, [text, name]);
  const dirty = draft !== base.current;
  const save = async () => {
    if (!onSave || !dirty) return;
    setState("saving");
    setErr("");
    try {
      const msg = await onSave(draft);
      base.current = draft;
      setState("saved");
      if (msg) setErr(msg);
    } catch (e) {
      setState("");
      setErr(failed(e, { at: "kit" }));
    }
  };
  const ro = !!readOnly || !onSave;
  return (
    <div className="k-editor" data-testid={testid}>
      <div className="k-editor-bar">
        <span>{name}</span>
        {dirty ? <span className="k-dirty" data-testid="editor-dirty">edited</span> : state === "saved" ? <span className="k-saved" data-testid="editor-saved">saved</span> : null}
        {ro ? <span className="ml-auto">{typeof readOnly === "string" ? readOnly : "read only"}</span> : (
          <>
            <button type="button" className="k-btn" data-quiet disabled={!dirty} onClick={() => setDraft(base.current)}>Revert</button>
            <button type="button" className="k-btn" data-ink disabled={!dirty || state === "saving"} data-testid="editor-save" onClick={save}>{state === "saving" ? "Saving" : "Save"}</button>
          </>
        )}
      </div>
      {ro ? <pre className="k-editor-pre" data-testid="editor-text">{draft}</pre> : <textarea
        aria-label={name}
        data-testid="editor-text"
        value={draft}
        readOnly={ro}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
          if (e.key === "Tab" && !ro) {
            e.preventDefault();
            const t = e.currentTarget, a = t.selectionStart, b = t.selectionEnd;
            setDraft(draft.slice(0, a) + "  " + draft.slice(b));
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }
        }}
      />}
      {(err || note) && <div className="k-editor-note" data-tone={err ? "fail" : undefined} data-testid="editor-note">{err || note}</div>}
    </div>
  );
}

// A new file from a name and a line saying when it applies, yours or the repository's.
export function NewFile({ kind, scopes, onCreate, hint }: {
  kind: string; scopes: [string, string, string][]; hint: string;
  onCreate: (b: { name: string; description: string; scope: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState(scopes[0]![0]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const where = scopes.find((s) => s[0] === scope)!;
  return (
    <form
      className="k-form"
      data-testid={`new-${kind}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setErr("");
        setBusy(true);
        try { await onCreate({ name: name.trim(), description: description.trim(), scope }); setName(""); setDescription(""); }
        catch (x) { setErr(failed(x, { at: "kit" })); }
        finally { setBusy(false); }
      }}
    >
      <label>Name<input data-mono data-testid="new-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="release-notes" /></label>
      <label>When it applies<textarea data-testid="new-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={hint} /></label>
      <div className="k-form-row">
        <Seg value={scope} options={scopes.map(([v, l]) => [v, l] as [string, string])} onChange={setScope} label="Where it lives" />
        <code className="k-path !mt-0">{tilde(where[2])}</code>
      </div>
      {err && <p className="k-form-err" data-testid="new-error">{err}</p>}
      <div><button type="submit" className="k-btn" data-ink disabled={!name || !description || busy} data-testid="new-create">Create</button></div>
    </form>
  );
}
