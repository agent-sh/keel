import { KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { secrets, useSecrets, type SecretMeta, type SecretRequest } from "../lib/secrets.ts";
import { reportError, failed } from "../lib/store.ts";
import { useUI } from "../lib/ui.ts";

const NONE: never[] = [];

// Secret cards above the composer: a request the model waits on (the owner
// types the value; it never enters the conversation), and a notice for each
// secret found in a message or in output, which the owner can name so the
// session's commands get it as a variable.
export function SecretCards({ sessionId }: { sessionId: string }) {
  const requests = useSecrets((s) => s.requests[sessionId] ?? NONE);
  const fresh = useSecrets((s) => s.fresh[sessionId] ?? NONE);
  const all = useSecrets((s) => s.secrets[sessionId] ?? NONE);
  useEffect(() => { secrets.load(sessionId).catch(reportError); }, [sessionId]);
  const found = fresh.map((id) => all.find((x) => x.id === id)).filter((x): x is SecretMeta => !!x);
  if (!requests.length && !found.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      {requests.map((r) => <RequestCard key={r.id} r={r} />)}
      {found.map((m) => <FoundCard key={m.id} m={m} sessionId={sessionId} />)}
    </div>
  );
}

const shell = "animate-in overflow-hidden rounded-2xl border border-line bg-raised shadow-2";
const input = "h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 font-mono text-ui outline-none placeholder:font-sans placeholder:text-faint focus:border-line-strong";
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

function RequestCard({ r }: { r: SecretRequest }) {
  // The field takes the keyboard only in the session the owner has open (the helm): a request of a
  // session that is merely on the page (a pane beside it, a phone's page behind the home screen)
  // never pulls the keyboard, or the screen, to itself.
  const helm = useUI((x) => x.route.name === "session" && x.route.id === r.session_id);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try { await f(); } catch (e) { setErr((e as Error).message); reportError(e, { at: "secret request" }); } finally { setBusy(false); }
  };
  return (
    <div className={`k-secret-request ${shell}`} data-testid="secret-request">
      <Head title={`The model asks for ${r.name}`} />
      {r.purpose && <p className="px-4 pt-1.5 text-caption text-muted">{r.purpose}</p>}
      <form className="flex items-center gap-1.5 px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (value) act(() => secrets.give(r.session_id, r.id, value)); }}>
        <input
          autoFocus={helm}
          type="password"
          autoComplete="off"
          data-testid="secret-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the value: it goes to commands only, never to the model"
          className={input}
        />
        <button type="submit" disabled={busy || !value} data-testid="secret-give" className={`k-secret-give ${primary}`}>Give</button>
        <button type="button" disabled={busy} data-testid="secret-decline" onClick={() => act(() => secrets.decline(r.session_id, r.id))} className={quiet}>Decline</button>
      </form>
      <p className="px-4 pb-3 -mt-1 text-micro text-faint">{err ? <span className="text-danger">{err}</span> : `Held in memory for this session as $${r.name}; a restart forgets it.`}</p>
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
