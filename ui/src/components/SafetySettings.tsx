import { copyOrSay } from "../lib/copy.ts";
import { useEffect, useState, type ReactNode } from "react";
import { safety, useSafety } from "../lib/safety.ts";
import { api, reportError, failed } from "../lib/store.ts";
import type { WorktreeStatus } from "../lib/worktree.ts";
import { useStore } from "../lib/store.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { enroll, passkeyBlock } from "../lib/presence.ts";
import { Card, SettingRow } from "./Settings.tsx";
import { Select } from "./Select.tsx";
import { Switch } from "@base-ui/react/switch";
import { composing } from "../lib/keys.ts";
import { clock } from "../lib/utils.ts";

type PermSettings = { default_mode: string; reviewer_model: string | null; reviewer_policy: string };

// Settings > Safety: the mode new sessions start in, the model of reviewer
// mode, the model of code reviews, and the parts other safety features add.
export function SafetySettings({ children }: { children?: ReactNode }) {
  const modes = useSafety((s) => s.modes);
  const [perm, setPerm] = useState<PermSettings | null>(null);
  const [reviewModel, setReviewModel] = useState<string | null>(null);
  useEffect(() => {
    if (!modes.length) safety.loadSettings().catch(reportError);
    api<PermSettings>("/api/permissions/settings").then(setPerm).catch(reportError);
    api<{ model: string | null }>("/api/reviews/settings").then((r) => setReviewModel(r.model)).catch(reportError);
  }, []);
  const putPerm = (patch: Partial<PermSettings>) => api<PermSettings>("/api/permissions/settings", { method: "PUT", body: JSON.stringify(patch) }).then(setPerm).catch(reportError);
  const sameAs = <span className="text-caption text-faint">the session's own model</span>;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <SettingRow label="New sessions start in" hint={modes.find((m) => m.id === perm?.default_mode)?.description}>
          <Select
            data-testid="default-mode"
            value={perm?.default_mode ?? ""}
            onChange={(e) => putPerm({ default_mode: e.target.value })}
          >
            {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </SettingRow>
        <SettingRow label="Judge model" hint="Reviews uncovered and flagged calls in Auto, flagged calls the safety rules did not settle in Full auto, and ordinary approvals in Reviewer. Auto sends owner-only actions to you, not to the judge. Unset, your small models answer first, then the session's own model.">
          <div className="flex items-center gap-2" data-testid="reviewer-model">
            {perm?.reviewer_model ? <ModelPicker value={perm.reviewer_model} onChange={(m) => putPerm({ reviewer_model: m })} compact /> : <><span className="text-caption text-faint">your small models</span><ModelPicker value="" onChange={(m) => putPerm({ reviewer_model: m })} compact /></>}
            {perm?.reviewer_model && <button className="text-caption text-faint hover:text-fg" onClick={() => putPerm({ reviewer_model: null })}>Reset</button>}
          </div>
        </SettingRow>
        <div className="border-b border-line py-4">
          <div className="text-base font-medium">Judge policy</div>
          <div className="mt-0.5 text-ui text-muted">Your own rules for the judge, in plain words. They win over its built-in guidance.</div>
          <PolicyBox value={perm?.reviewer_policy ?? ""} onSave={(v) => putPerm({ reviewer_policy: v })} />
        </div>
        <SettingRow label="Code review model" hint="The independent reviewer in the Review panel. Another family than the session's gives a second opinion.">
          <div className="flex items-center gap-2" data-testid="code-review-model">
            {reviewModel ? null : sameAs}
            <ModelPicker value={reviewModel ?? ""} onChange={(m) => api<{ model: string | null }>("/api/reviews/settings", { method: "PUT", body: JSON.stringify({ model: m }) }).then((r) => setReviewModel(r.model)).catch(reportError)} compact />
            {reviewModel && <button className="text-caption text-faint hover:text-fg" onClick={() => api<{ model: string | null }>("/api/reviews/settings", { method: "PUT", body: JSON.stringify({ model: null }) }).then((r) => setReviewModel(r.model)).catch(reportError)}>Reset</button>}
          </div>
        </SettingRow>
      </Card>
      <JudgePrecisionCard />
      <SandboxReadsCard />
      <PasskeysCard />
      <RemoteAccessCard />
      <TrustCard />
      <WorktreesCard />
      {children}
    </div>
  );
}

function PolicyBox({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="mt-2.5 flex flex-col items-end gap-2">
      <textarea
        data-testid="reviewer-policy"
        value={v}
        onChange={(e) => setV(e.target.value)}
        rows={3}
        placeholder="For example: never allow network uploads; allow package installs from the lock file."
        className="k-field h-auto w-full resize-y py-2"
      />
      <button data-testid="reviewer-policy-save" disabled={v === value} onClick={() => onSave(v)} className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">Save policy</button>
    </div>
  );
}

type PrecisionRow = { key: string; reviewed: number; allowed: number; refused: number; taken_back: number; precision: number | null };
type Precision = { since: number; days: PrecisionRow[]; classes: PrecisionRow[]; total: PrecisionRow };

// A verdict's class in words: who decided, what the rules flagged, and where (precision.ts classKey).
const DECIDER: Record<string, string> = { judge: "Judge", rule: "Keel's rules", reviewer: "Reviewer" };
const FLAGGED: Record<string, string> = {
  ordinary: "ordinary calls", destroys: "destroys work or data", remote: "changes another machine or a service", exposes: "sends credentials out",
  hidden: "runs code not in the command", machine: "reaches past the session", owner: "yours alone to allow", flagged: "flagged calls",
};
const PLACE: Record<string, string> = { own: "in the session's own folders", outside: "outside them", unknown: "" };
function classWords(key: string): { who: string; what: string } {
  const [by = "", flag = "", place = ""] = key.split(":");
  return { who: DECIDER[by] ?? by, what: [FLAGGED[flag] ?? flag, PLACE[place] ?? place].filter(Boolean).join(", ") };
}
// A share when there are enough refusals to say one; else how many of them stood.
const pct = (r: PrecisionRow) => (r.precision !== null ? `${Math.round(r.precision * 100)}%` : r.refused ? `${r.refused - r.taken_back} of ${r.refused}` : "no refusals");

// How often you took back what the judge or Keel's rules decided without you: a refusal you let one retry of
// through, or the same call you allowed later on a card. Per class and per day, the last seven days.
function JudgePrecisionCard() {
  const [p, setP] = useState<Precision | null>(null);
  useEffect(() => { api<Precision>("/api/permissions/judge?days=7").then(setP).catch(reportError); }, []);
  const th = "px-2 py-1.5 font-normal", td = "px-2 py-1.5 tabular-nums";
  const counts = (r: PrecisionRow) => (
    <>
      <td className={`${td} text-right`}>{r.reviewed}</td>
      <td className={`${td} text-right`}>{r.refused}</td>
      <td className={`${td} text-right ${r.taken_back ? "text-warn" : "text-muted"}`}>{r.taken_back}</td>
      <td className={`${td} text-right font-medium`}>{pct(r)}</td>
    </>
  );
  // (One set of column widths for both tables, so their numbers line up.)
  const cols = <colgroup><col /><col className="w-24" /><col className="w-24" /><col className="w-32" /><col className="w-24" /></colgroup>;
  const head = (first: string) => (
    <thead>
      <tr className="border-b border-line text-left text-caption text-faint">
        <th className={th}>{first}</th><th className={`${th} text-right`}>Reviewed</th><th className={`${th} text-right`}>Refused</th>
        <th className={`${th} text-right`}>Taken back</th><th className={`${th} text-right`}>Stood</th>
      </tr>
    </thead>
  );
  return (
    <div className="k-after-card flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Judge precision</h3>
      <Card>
        <div className="py-4" data-testid="judge-precision">
          <p className="text-ui text-muted">Calls the judge or Keel's rules decided for you in the last seven days. A refusal is taken back when you let one retry of it through, or allow the same call in that session later. Stood is the share of refusals you did not take back, given from five refusals on.</p>
          {!p ? null : p.total.reviewed === 0 ? <p className="k-empty mt-3">No verdicts in the last seven days.</p> : (
            <div className="mt-3 flex flex-col gap-4">
              <table className="w-full table-fixed text-ui" data-testid="judge-precision-classes">
                {cols}{head("Class")}
                <tbody>
                  {p.classes.map((r) => {
                    const w = classWords(r.key);
                    return (
                      <tr key={r.key} className="border-b border-line/60 last:border-0" data-testid="judge-precision-class" data-key={r.key}>
                        <td className="px-2 py-1.5"><span className="font-medium">{w.who}</span> <span className="text-muted">{w.what}</span></td>
                        {counts(r)}
                      </tr>
                    );
                  })}
                  <tr className="border-t border-line" data-testid="judge-precision-total">
                    <td className="px-2 py-1.5 font-medium">All</td>
                    {counts(p.total)}
                  </tr>
                </tbody>
              </table>
              <table className="w-full table-fixed text-ui" data-testid="judge-precision-days">
                {cols}{head("Day")}
                <tbody>
                  {p.days.map((r) => (
                    <tr key={r.key} className="border-b border-line/60 last:border-0" data-testid="judge-precision-day">
                      <td className="px-2 py-1.5 tabular-nums text-muted">{r.key}</td>
                      {counts(r)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

type SandboxReads = {
  read: string[]; env: string[]; workspaces: Record<string, { read?: string[]; ssh_agent?: boolean }>; scopes: string[]; shown: string[];
  hidden_settings: { path: string; note?: string }[]; config_refused?: string[]; bytes: number; available: boolean;
};

// What a sandboxed command may read. The card says what every sandbox
// shows by design, and what it hides; here the owner adds folders, for every
// session or for one folder's, lets a folder's commands use the SSH agent,
// names environment variables a command keeps, and clears what the
// sandboxes hold on disk.
function SandboxReadsCard() {
  const [v, setV] = useState<SandboxReads | null>(null);
  const [scope, setScope] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api<SandboxReads>("/api/permissions/sandbox").then((r) => { setV(r); setScope((s) => s || r.scopes[0] || ""); }).catch(reportError);
  }, []);
  const put = (patch: object) => api<SandboxReads>("/api/permissions/sandbox", { method: "PUT", body: JSON.stringify(patch) })
    .then((r) => { setV(r); setErr(""); }).catch((e) => setErr(failed(e, { at: "SafetySettings" })));
  if (!v) return null;
  const own = (scope && v.workspaces[scope]) || {};
  const mb = v.bytes >= 1024 * 1024 * 1024 ? `${(v.bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : `${Math.round(v.bytes / 1024 / 1024)} MB`;
  return (
    <div className="k-after-card flex flex-col gap-2" data-testid="sandbox-reads">
      <h3 className="px-1 text-ui font-medium text-muted">Sandbox: what commands can read</h3>
      {(v.config_refused ?? []).map((line) => (
        <p key={line} role="alert" data-testid="config-refused" className="rounded-lg border border-danger/40 bg-raised px-3 py-2 text-ui break-words text-danger">{line}</p>
      ))}
      <Card>
        <div className="border-b border-line py-4">
          <div className="text-base font-medium">Every folder</div>
          <div className="mt-0.5 text-ui text-muted">A sandboxed command does not see your home folder. It reads the session's folder, the system, and what is listed below. Add a folder or a file that the commands of every session may read.</div>
          <PathList testid="sandbox-read-all" paths={v.read} onChange={(read) => put({ read })} />
          <details className="mt-3 text-caption text-muted">
            <summary className="cursor-pointer select-none hover:text-fg" data-testid="sandbox-shown-toggle">Readable in every sandbox by design</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5" data-testid="sandbox-by-design">
              <li>The other checkouts of the session's repository (its main checkout and worktrees), read-only.</li>
              <li>Your package caches (cargo, Go, bun, npm, pnpm, uv, pip, Playwright and the like): read as they are; what a command writes there stays in the sandbox.</li>
              <li>Git's global config and ignore file, and version files such as .tool-versions.</li>
              <li>The skills and commands Keel offers the session, the files you attached to it and its artifacts.</li>
              {v.shown.length > 0 && <li>Your toolchains, read-only: <span className="break-all font-mono" data-testid="sandbox-shown">{v.shown.join(", ")}</span></li>}
            </ul>
          </details>
          {v.hidden_settings.length > 0 && (
            <details className="mt-2 text-caption text-muted">
              <summary className="cursor-pointer select-none hover:text-fg" data-testid="sandbox-hidden-toggle">Settings files of yours that are hidden there: {v.hidden_settings.length}</summary>
              <p className="mt-2">A tool inside a sandbox runs without these, so it may behave differently there (another registry, no sign-in).</p>
              <ul className="mt-1 flex flex-col gap-0.5 font-mono" data-testid="sandbox-hidden">{v.hidden_settings.map((h) => <li key={h.path} className="break-all">{h.path}{h.note && <span className="font-sans text-faint"> ({h.note})</span>}</li>)}</ul>
            </details>
          )}
        </div>
        <div className="border-b border-line py-4">
          <div className="text-base font-medium">One folder</div>
          <div className="mt-0.5 text-ui text-muted">For the sessions that work in one repository or folder.</div>
          {v.scopes.length === 0 ? <p className="k-empty mt-3">Nothing yet: open a session in a folder first.</p> : (
            <>
              <Select data-testid="sandbox-scope" value={scope} onChange={(e) => setScope(e.target.value)} className="mt-3 max-w-full font-mono text-caption">
                {v.scopes.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
              <PathList testid="sandbox-read-one" paths={own.read ?? []} onChange={(read) => put({ workspace: { scope, read } })} />
              <label className="mt-3 flex items-start gap-2.5 text-ui">
                <Switch.Root checked={!!own.ssh_agent} onCheckedChange={(on) => put({ workspace: { scope, ssh_agent: on } })} data-testid="sandbox-ssh-agent" className="k-switch mt-0.5">
                  <Switch.Thumb className="k-switch-thumb" />
                </Switch.Root>
                <span>Let its commands use the SSH agent <span className="text-muted">(they can sign in and push with your keys while it is on; they cannot read the keys)</span></span>
              </label>
            </>
          )}
          {err && <p className="mt-3 text-caption text-danger" role="alert" data-testid="sandbox-reads-error">{err}</p>}
        </div>
        <div className="border-b border-line py-4">
          <div className="text-base font-medium">Environment variables</div>
          <div className="mt-0.5 text-ui text-muted">A sandboxed command gets the variables a build needs (PATH, the locale, the toolchains' folders) and none of the rest of the daemon's environment: no variable named as a token, key or password, and a URL in a kept one goes in without its sign-in. Name a variable to pass it on as it is.</div>
          <PathList testid="sandbox-env" paths={v.env} onChange={(env) => put({ env })} placeholder="NAME" label="An environment variable a sandboxed command keeps" />
        </div>
        <SettingRow label="On disk" hint="What sandboxed commands wrote to their own package caches and temp folders. Temp files go after 10 days and a cache layer no command used after 30; clearing removes the temp files and every layer no running command holds.">
          <div className="flex items-center gap-3">
            <span className="text-ui tabular-nums text-muted" data-testid="sandbox-bytes">{mb}</span>
            <button data-testid="sandbox-clear" onClick={() => api<SandboxReads>("/api/permissions/sandbox/clear", { method: "POST", body: "{}" }).then(setV).catch(reportError)}
              className="k-btn k-btn-lg">Clear</button>
          </div>
        </SettingRow>
      </Card>
    </div>
  );
}

// A list of paths (or names) with one field to add to it. An entry is shown whole: a long one wraps.
function PathList({ paths, onChange, testid, placeholder = "~/folder or /path", label = "A folder or file commands may read" }: { paths: string[]; onChange: (next: string[]) => void; testid: string; placeholder?: string; label?: string }) {
  const [add, setAdd] = useState("");
  const commit = () => { const t = add.trim(); if (!t || paths.includes(t)) return; onChange([...paths, t]); setAdd(""); };
  return (
    <div className="mt-3 flex flex-col gap-1.5" data-testid={testid}>
      {paths.map((p) => (
        <div key={p} className="flex items-start gap-2 text-caption">
          <span className="min-w-0 flex-1 break-all font-mono" data-testid="sandbox-read-path">{p}</span>
          <button className="shrink-0 text-faint hover:text-danger" aria-label={`Remove ${p}`} onClick={() => onChange(paths.filter((x) => x !== p))}>Remove</button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) commit(); }}
          placeholder={placeholder} aria-label={label} data-testid="sandbox-read-add"
          className="k-field text-caption min-w-0 flex-1 font-mono"
        />
        <button disabled={!add.trim()} onClick={commit} data-testid="sandbox-read-add-button" className="k-btn k-btn-lg shrink-0">Add</button>
      </div>
    </div>
  );
}

// Managed worktrees: how many to keep, each one's state, and a prune now.
function WorktreesCard() {
  const [keep, setKeep] = useState<number | null>(null);
  const [list, setList] = useState<WorktreeStatus[]>([]);
  const [note, setNote] = useState("");
  const sessions = useStore((s) => s.sessions);
  const load = () => {
    api<{ keep: number }>("/api/worktrees/settings").then((r) => setKeep(r.keep)).catch(reportError);
    api<{ worktrees: WorktreeStatus[] }>("/api/worktrees").then((r) => setList(r.worktrees)).catch(reportError);
  };
  useEffect(load, []);
  const live = list.filter((w) => w.state !== "removed");
  return (
    <div className="k-after-card flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Worktrees</h3>
      <Card>
        <SettingRow label="Keep" hint="Past this many, the worktrees of archived or deleted sessions are removed, each with its working state saved so it can be restored. Running and open sessions keep theirs.">
          <input
            type="number" min={0} max={1000} data-testid="worktree-keep" value={keep ?? ""}
            onChange={(e) => setKeep(Number(e.target.value))}
            onBlur={() => keep !== null && api<{ keep: number }>("/api/worktrees/settings", { method: "PUT", body: JSON.stringify({ keep }) }).then((r) => setKeep(r.keep)).catch(reportError)}
            className="k-field w-20 text-right tabular-nums"
          />
        </SettingRow>
        <div className="py-3">
          {live.length === 0 ? <p className="k-empty">No managed worktrees.</p> : (
            <ul className="flex flex-col gap-1" data-testid="worktree-list">
              {live.map((w) => {
                const s = sessions[w.session_id];
                return (
                  <li key={w.session_id} className="flex items-center gap-2 text-caption">
                    <span className="max-w-[45%] shrink-0 truncate font-mono">{w.branch}</span>
                    <span className="min-w-0 flex-1 truncate text-faint">{s ? (s.archived ? "archived" : s.title || "session") : "session deleted"}</span>
                    <span className={w.state === "parked" ? "shrink-0 text-warn" : "shrink-0 text-muted"}>{w.state}{w.state === "active" && (w.dirty || w.commits_ahead) ? ` · ${w.dirty} changed · ${w.commits_ahead} ahead` : ""}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button data-testid="worktree-prune" onClick={() => api<{ removed: string[] }>("/api/worktrees/prune", { method: "POST", body: "{}" }).then((r) => { setNote(r.removed.length ? `Removed ${r.removed.length}, working state saved.` : "Nothing to prune."); load(); }).catch((e) => setNote(failed(e, { at: "SafetySettings" })))}
              className="k-btn k-btn-lg">Prune now</button>
            {note && <span className="text-caption text-muted" data-testid="worktree-prune-note">{note}</span>}
          </div>
        </div>
      </Card>
    </div>
  );
}

// Whether a repository's new instruction files and skills load on first sight.
function TrustCard() {
  const [v, setV] = useState<"auto" | "ask" | null>(null);
  useEffect(() => { api<{ new_files: "auto" | "ask" }>("/api/trust/settings").then((r) => setV(r.new_files)).catch(reportError); }, []);
  const put = (new_files: "auto" | "ask") => api<{ new_files: "auto" | "ask" }>("/api/trust/settings", { method: "PUT", body: JSON.stringify({ new_files }) }).then((r) => setV(r.new_files)).catch(reportError);
  return (
    <div className="k-after-card flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Repository files</h3>
      <Card>
        <SettingRow label="A repository's new instruction files and skills" hint="A changed one always waits for you, and a repository's hook file always does. The Trust panel of a session shows what is held.">
          <Select data-testid="trust-new-files" value={v ?? ""} onChange={(e) => put(e.target.value as "auto" | "ask")}>
            <option value="auto">Load on first sight</option>
            <option value="ask">Wait for me</option>
          </Select>
        </SettingRow>
      </Card>
    </div>
  );
}

type PresenceInfo = { local: boolean; enrolled: boolean; rp_id: string | null; passkeys: { id: string; rp_id: string; label: string | null; created: number; used: number | null }[] };

// Passkeys: high-risk approvals and authority changes from another device ask
// for one; the desk itself never does.
function PasskeysCard() {
  const [info, setInfo] = useState<PresenceInfo | null>(null);
  const [code, setCode] = useState<{ code: string; expires: number } | null>(null);
  const [typed, setTyped] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const load = () => api<PresenceInfo>("/api/owner-presence").then(setInfo).catch(reportError);
  useEffect(() => { load(); }, []);
  if (!info) return null;
  const here = info.passkeys.filter((p) => p.rp_id === location.hostname);
  const block = passkeyBlock();
  const addDevice = info.local && (
    <button data-testid="passkey-code-new" onClick={() => api<{ code: string; expires: number }>("/api/owner-presence/code", { method: "POST" }).then(setCode).catch(reportError)} className="k-btn k-btn-lg">Add a device</button>
  );
  const doEnroll = async () => {
    setMsg(null);
    try {
      await enroll(label.trim() || (info.local ? "This computer" : "This device"), info.local ? undefined : typed);
      setMsg({ text: "Passkey enrolled." });
      setTyped("");
      load();
    } catch (e) { setMsg({ text: failed(e, { at: "SafetySettings" }), error: true }); }
  };
  return (
    <div className="k-after-card flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Passkeys</h3>
      <Card>
        <div className="py-4" data-testid="passkeys">
          <p className="text-ui text-muted">
            {info.enrolled
              ? "From another device, a high-risk approval and changes that let sessions do more (a looser mode, a grant, trusting a repository's files, these settings) need your passkey, signed over that one action. Here at the desk nothing asks."
              : "With a passkey enrolled, a high-risk approval and changes that let sessions do more need it when they come from another device. Here at the desk nothing asks."}
          </p>
          {info.passkeys.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1" data-testid="passkey-list">
              {info.passkeys.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-caption">
                  <span className="min-w-0 flex-1 truncate">{p.label ?? "Passkey"}</span>
                  <span className="font-mono text-faint">{p.rp_id}</span>
                  <span className="text-faint">{p.used ? `used ${new Date(p.used).toLocaleDateString()}` : "not used yet"}</span>
                  <button className="text-faint hover:text-danger" onClick={() => api(`/api/owner-presence/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(load).catch((e) => setMsg({ text: failed(e, { at: "SafetySettings" }), error: true }))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          {block ? (
            <>
              <p className="mt-3 text-caption text-warn" data-testid="passkey-blocked">
                {block.why}
                {block.localhost && <> To enroll this computer, <a data-testid="passkey-localhost" className="font-medium text-accent-ink underline" href={block.localhost}>open this page at localhost</a>.</>}
              </p>
              {addDevice && <div className="mt-3 flex flex-wrap items-center gap-2">{addDevice}</div>}
            </>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!info.local && <input data-testid="passkey-code" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder="Code shown at the desk" className="k-field w-52 font-mono placeholder:font-sans" />}
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={info.local ? "This computer" : "This device"} className="k-field w-44" />
              <button data-testid="passkey-enroll" disabled={!info.local && !typed.trim()} onClick={doEnroll} className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">
                {here.length ? "Enroll another passkey here" : "Enroll this device"}
              </button>
              {addDevice}
            </div>
          )}
          {code && (
            <p className="mt-3 text-caption text-muted" data-testid="passkey-code-shown">
              On the other device, open Keel over HTTPS, go to Settings, Safety, and enroll it with <span className="rounded bg-code px-1.5 py-0.5 font-mono text-ui text-fg">{code.code}</span> (until {clock(code.expires)}).
            </p>
          )}
          {msg && <p className={msg.error ? "mt-2 text-caption text-danger" : "mt-2 text-caption text-ok"} data-testid="passkey-msg">{msg.text}</p>}
        </div>
      </Card>
    </div>
  );
}

// Remote access: a browser on another device opens this link once (through
// the tunnel or proxy whose host is in KEEL_ALLOWED_HOSTS); without it, any
// request through a proxy is refused. Shown at the desk only.
function RemoteAccessCard() {
  const [link, setLink] = useState<{ path: string; hosts: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api<{ path: string; hosts: string[] }>("/api/remote-access").then(setLink).catch((e) => { failed(e, { at: "remote access" }); setLink(null); }); }, []);
  if (!link) return null;
  const full = link.hosts[0] ? `https://${link.hosts[0]}${link.path}` : link.path;
  return (
    <div className="k-after-card flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Remote access</h3>
      <Card>
        <div className="py-4" data-testid="remote-access">
          <p className="text-ui text-muted">
            A request through a tunnel or proxy, from another address or from another account on this machine needs this daemon's access token. Open this link once on the other device; it keeps the token as a cookie. Anyone with the link can use Keel as you.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-code px-2 py-1 font-mono text-caption text-fg" data-testid="remote-access-link">{full.replace(/token=[^&]+/, "token=\u2026")}</code>
            <button data-testid="remote-access-copy" onClick={(e) => copyOrSay(full, e.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })} className="k-btn k-btn-lg">{copied ? "Copied" : "Copy link"}</button>
          </div>
          {!link.hosts.length && <p className="k-empty mt-2">No tunnel host is set: start the daemon with KEEL_ALLOWED_HOSTS naming it.</p>}
        </div>
      </Card>
    </div>
  );
}
