import { useEffect, useState } from "react";
import { composing } from "../lib/keys.ts";
import { api, failed, reportError } from "../lib/store.ts";
import { Card, SettingRow } from "./Settings.tsx";

type Candidate = { namespace: string; why: string; count?: number };

// Settings > Safety > Your accounts: the namespaces whose repositories and packages the agent may write to without
// asking you. A push, comment, review, release or publish beyond them is yours alone, in every mode.
export function AccountsCard() {
  const [list, setList] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => { api<{ settings: { accounts?: { namespaces?: string[] } } }>("/api/settings").then((r) => setList(r.settings.accounts?.namespaces ?? [])).catch(reportError); }, []);
  const save = (next: string[]) => api<{ settings: { accounts: { namespaces: string[] } } }>("/api/settings", { method: "PATCH", body: JSON.stringify({ accounts: { namespaces: next } }) })
    .then((r) => { setList(r.settings.accounts.namespaces); setNote(""); return true; })
    .catch((e) => { setNote(failed(e, { at: "AccountsCard" })); return false; });
  const look = () => api<{ candidates: Candidate[] }>("/api/accounts/candidates").then((r) => { setFound(r.candidates); setNote(r.candidates.length ? "" : "Nothing new in your git remotes, gh sign-in or .npmrc."); }).catch(reportError);
  if (!list) return null;
  const add = async (ns: string) => { if (ns.trim() && await save([...list, ns.trim()])) { setTyped(""); setFound((f) => f && f.filter((c) => c.namespace !== ns)); } };
  return (
    <div className="k-after-card flex flex-col gap-2" data-testid="accounts-card">
      <h3 className="px-1 text-ui font-medium text-muted">Your accounts</h3>
      <Card>
        <SettingRow
          label="Namespaces that are yours"
          hint="A git push, a comment, review or release on a repository, or a publish of a package, outside these asks you in every mode, and an agent is refused it. Write GitHub users and organizations as they are, other forges as host/group, packages as npm:@scope, pypi:name or crates:name."
        >
          <div className="flex items-center gap-2">
            <input
              data-testid="accounts-input" value={typed} placeholder="github.com/you" spellCheck={false}
              onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) add(typed).catch(reportError); }}
              className="k-field w-56"
            />
            <button type="button" data-testid="accounts-add" className="k-btn k-btn-lg" disabled={!typed.trim()} onClick={() => add(typed).catch(reportError)}>Add</button>
          </div>
        </SettingRow>
        <div className="border-b border-line py-3 last:border-0">
          {list.length === 0 ? <p className="k-empty" data-testid="accounts-empty">None named yet. Until you name them, every such write asks you.</p> : (
            <ul className="flex flex-col gap-1" data-testid="accounts-list">
              {list.map((n) => (
                <li key={n} className="flex items-center gap-2 text-ui">
                  <span className="min-w-0 flex-1 truncate font-mono">{n}</span>
                  <button type="button" className="text-caption text-faint hover:text-danger" onClick={() => save(list.filter((x) => x !== n)).catch(reportError)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <SettingRow label="Learn them from your config" hint="Reads the owners of the git remotes in the folders your sessions work in, the user gh is signed in as, and the scopes of your .npmrc, once, here. You choose which are yours.">
          <button type="button" data-testid="accounts-look" className="k-btn k-btn-lg" onClick={() => look().catch(reportError)}>Look</button>
        </SettingRow>
        {(found?.length || note) ? (
          <div className="py-3">
            {note && <p className="text-caption text-muted" data-testid="accounts-note">{note}</p>}
            {found?.length ? (
              <ul className="flex flex-col gap-1.5" data-testid="accounts-found">
                {found.map((c) => (
                  <li key={c.namespace} className="flex items-center gap-2 text-ui">
                    <span className="shrink-0 font-mono">{c.namespace}</span>
                    <span className="min-w-0 flex-1 truncate text-caption text-faint">{c.why}</span>
                    <button type="button" data-testid={`accounts-take-${c.namespace}`} className="k-btn" onClick={() => add(c.namespace).catch(reportError)}>Mine</button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
