import { KeyRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { KEY_MS, SETTLE_MS } from "../lib/approvals.ts";
import { dropRepeats, keyRefused, keyTried, noteAnswer, useAskKeys, useHold } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
import { secrets, useSecrets, type SecretMeta, type SecretRequest } from "../lib/secrets.ts";
import { reportError, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

const NONE: never[] = [];

// Secret cards above the composer: a request the model waits on (the owner
// types the value; it never enters the conversation), and a notice for each
// secret found in a message or in output, which the owner can name so the
// session's commands get it as a variable.
export function SecretCards({ sessionId }: { sessionId: string }) {
  const requests = useSecrets((s) => s.requests[sessionId] ?? NONE);
  const fresh = useSecrets((s) => s.fresh[sessionId] ?? NONE);
  const all = useSecrets((s) => s.secrets[sessionId] ?? NONE);
  useEffect(() => { secrets.watch(sessionId); }, [sessionId]);
  const found = fresh.map((id) => all.find((x) => x.id === id)).filter((x): x is SecretMeta => !!x);
  if (!requests.length && !found.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      {requests.map((r, i) => <RequestCard key={r.id} r={r} first={i === 0} />)}
      {found.map((m) => <FoundCard key={m.id} m={m} sessionId={sessionId} />)}
    </div>
  );
}

const shell = "animate-in overflow-hidden rounded-2xl border border-line bg-raised shadow-2";
const input = "k-field flex-1 font-mono placeholder:font-sans";
const primary = "h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50";
const quiet = "h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg disabled:opacity-50";

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 pt-3">
      <span className="grid size-6 place-items-center rounded-md bg-accent-soft text-accent"><KeyRound className="size-3.5" /></span>
      <span className="text-ui font-medium">{title}</span>
      {sub && <span className="truncate font-mono text-caption text-faint">{sub}</span>}
    </div>
  );
}

// The card is held to the rule of lib/asks.ts, with one exception: what is
// typed on it is never sent on to the message box. A secret typed at a card
// that shows the keyboard on it would land in the plain box, and Enter would
// send it to the model.
// - A card that takes the keyboard by itself (its pane is worked in, the
//   message box is empty) takes it on the card, never in its field: a word on
//   its way to the message box is not given as the secret. Letters typed on
//   the card are dropped, and the card says how to get to the field: Tab or
//   Enter. A paste on the card goes into the field, masked, and gives nothing.
// - When the owner brought the keyboard here themselves (a row of the home
//   screen, the key that goes to what waits, a step of the sequence), the
//   field has it: there they mean it.
// - Enter gives the value as a key on any answer does: not within the settle
//   time of the keyboard arriving on the card, or of code putting it in the
//   field.
// - A message box that holds a draft keeps the keyboard: the card takes none.
// And only in the session the owner has open: a request of a session that is
// merely on the page (a pane beside it, a phone's page behind the home screen)
// never pulls the keyboard, or the screen, to itself.
const TO_FIELD = "Tab or Enter to type the secret";
function RequestCard({ r, first }: { r: SecretRequest; first: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useAskKeys(root, first);
  const hold = useHold(root);
  // When code last put the keyboard in the field.
  const fieldAt = useRef(-Infinity);
  const toField = () => { fieldAt.current = performance.now(); field.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (hold.own && hold.take && document.activeElement === root.current) toField();
  }, [hold.own, hold.take, hold.at]);
  const [onCard, setOnCard] = useState(false); // the keyboard is on the card itself, not in its field or on a button
  const [dropped, setDropped] = useState(false); // a key typed on the card went nowhere
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The value given is ordinary text (a word, a short number): what the daemon said, for that value. Given again, it is kept.
  const [plain, setPlain] = useState<{ value: string; text: string } | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    noteAnswer(r.id);
    try { await f(); } catch (e) {
      const body = (e as any).body;
      if ((e as any).status === 409 && body?.ordinary) setPlain({ value, text: (e as Error).message });
      else { setErr((e as Error).message); reportError(e, { at: "secret request" }); }
    } finally { setBusy(false); }
  };
  const warned = plain?.value === value ? plain : null;
  return (
    <div
      ref={root}
      tabIndex={-1}
      className={`k-secret-request outline-none ${shell}`}
      data-testid="secret-request"
      data-ask-card=""
      data-ask=""
      data-keys={hold.keys || undefined}
      onFocus={(e) => { setOnCard(e.target === e.currentTarget); if (e.target !== e.currentTarget) setDropped(false); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOnCard(false); setDropped(false); } }}
      onKeyDownCapture={dropRepeats}
      onKeyDown={(e) => {
        // Only keys pressed on the card itself: the field and the buttons keep theirs.
        if (e.target !== e.currentTarget || composing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === "Enter") {
          e.preventDefault();
          // (Not an Enter pressed as the keyboard arrived: it was on its way somewhere else.)
          if (keyRefused(e.currentTarget)) setDropped(true);
          else toField();
        } else if (e.key.length === 1) {
          e.preventDefault();
          setDropped(true);
          // (A key typed nowhere is a key refused: the key settle time runs again from it, lib/asks.ts.)
          keyTried(e.currentTarget);
        }
      }}
      onPaste={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        const text = e.clipboardData.getData("text");
        if (!text) return;
        setValue(text);
        toField();
      }}
    >
      <Head title={`The model asks for ${r.name}`} />
      {r.purpose && <p className="px-4 pt-1.5 text-caption text-muted">{r.purpose}</p>}
      <form className="flex items-center gap-1.5 px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (value) act(() => secrets.give(r.session_id, r.id, value, !!warned)); }}>
        <input
          ref={field}
          type="password"
          autoComplete="off"
          data-testid="secret-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // Enter gives the value as a key on any answer does: not as the keyboard arrives by code, not under a dialog.
          onKeyDown={(e) => {
            if (e.key !== "Enter" || composing(e)) return;
            const no = keyRefused(e.currentTarget, e.repeat) || (performance.now() - fieldAt.current < KEY_MS ? "Not yet: the keyboard has only just arrived" : "");
            if (no) { e.preventDefault(); setErr(no); }
          }}
          placeholder="Paste the value: it goes to commands only, never to the model"
          className={input}
        />
        <button type="submit" disabled={busy || !value} data-testid="secret-give" className={`k-secret-give ${primary}`}>{warned ? "Keep it" : "Give"}</button>
        <button type="button" disabled={busy} data-testid="secret-decline" onClick={() => act(() => secrets.decline(r.session_id, r.id))} className={quiet}>Decline</button>
      </form>
      <p className="px-4 pb-3 -mt-1 text-micro text-faint">
        {err ? <span className="text-danger" role="alert" data-testid="secret-error">{err}</span>
          : warned ? <span className="text-warn" role="alert" data-testid="secret-ordinary">{warned.text}</span>
          // While the keyboard is on the card itself, what gets it into the field. Marked once a key typed here went nowhere.
          : onCard ? <span className={cn("pointer-coarse:hidden", dropped && "text-warn")} role="status" data-testid="secret-hint" data-dropped={dropped || undefined}>{TO_FIELD}{dropped ? ": what is typed here goes nowhere" : ""}</span>
          : `Held in memory for this session as $${r.name}; a restart forgets it.`}
      </p>
    </div>
  );
}

function FoundCard({ m, sessionId }: { m: SecretMeta; sessionId: string }) {
  const [name, setName] = useState(m.name ?? "");
  const [err, setErr] = useState("");
  const where = m.source === "prompt" ? "your message" : "the output";
  const save = async () => {
    setErr("");
    try { await secrets.rename(m.id, name.trim() || null); secrets.dismiss(sessionId, m.id); } catch (e) { setErr(failed(e, { at: "SecretCards" })); }
  };
  return (
    <div className={`k-secret-found ${shell}`} data-testid="secret-found">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Head title={`A ${m.kind} in ${where} was kept out of the history`} />
          <p className="px-4 pt-1.5 text-caption text-muted">
            The model and the transcript see <code className="rounded bg-code px-1 font-mono" data-testid="secret-placeholder">{m.placeholder}</code>; a command that uses it runs with the value.
          </p>
        </div>
        <button onClick={() => secrets.dismiss(sessionId, m.id)} className="mt-2.5 mr-2.5 grid size-7 place-items-center rounded-lg text-faint hover:bg-hover hover:text-fg" title="Dismiss" data-testid="secret-dismiss">
          <X className="size-4" />
        </button>
      </div>
      <form className="flex items-center gap-1.5 px-4 py-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input data-testid="secret-name" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} placeholder="Variable name for commands, e.g. GITHUB_TOKEN" className={input} />
        <button type="submit" disabled={!name.trim()} data-testid="secret-save-name" className={primary}>Name it</button>
        <button type="button" data-testid="secret-forget" onClick={() => secrets.forget(m.id).then(() => secrets.dismiss(sessionId, m.id)).catch((e) => setErr(failed(e, { at: "SecretCards" })))} className={quiet}>Forget</button>
      </form>
      {err && <p className="px-4 pb-3 -mt-1 text-micro text-danger">{err}</p>}
    </div>
  );
}
