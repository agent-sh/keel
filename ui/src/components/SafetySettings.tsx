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
            className="h-8 rounded-md border border-line bg-raised px-2 text-ui outline-none focus:border-line-strong"
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
        className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-ui outline-none placeholder:text-faint focus:border-line-strong"
      />
      <button data-testid="reviewer-policy-save" disabled={v === value} onClick={() => onSave(v)} className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">Save policy</button>
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
    <div className="flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Worktrees</h3>
      <Card>
        <SettingRow label="Keep" hint="Past this many, the worktrees of archived or deleted sessions are removed, each with its working state saved so it can be restored. Running and open sessions keep theirs.">
          <input
            type="number" min={0} max={1000} data-testid="worktree-keep" value={keep ?? ""}
            onChange={(e) => setKeep(Number(e.target.value))}
            onBlur={() => keep !== null && api<{ keep: number }>("/api/worktrees/settings", { method: "PUT", body: JSON.stringify({ keep }) }).then((r) => setKeep(r.keep)).catch(reportError)}
            className="h-8 w-20 rounded-md border border-line bg-raised px-2 text-right text-ui tabular-nums outline-none focus:border-line-strong"
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
              className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover">Prune now</button>
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
    <div className="flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Repository files</h3>
      <Card>
        <SettingRow label="A repository's new instruction files and skills" hint="A changed one always waits for you, and a repository's hook file always does. The Trust panel of a session shows what is held.">
          <Select data-testid="trust-new-files" value={v ?? ""} onChange={(e) => put(e.target.value as "auto" | "ask")} className="h-8 rounded-md border border-line bg-raised px-2 text-ui outline-none focus:border-line-strong">
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
    <button data-testid="passkey-code-new" onClick={() => api<{ code: string; expires: number }>("/api/owner-presence/code", { method: "POST" }).then(setCode).catch(reportError)} className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover">Add a device</button>
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
    <div className="flex flex-col gap-2">
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
              {!info.local && <input data-testid="passkey-code" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder="Code shown at the desk" className="h-8 w-52 rounded-md border border-line bg-raised px-2 font-mono text-ui outline-none placeholder:font-sans focus:border-line-strong" />}
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={info.local ? "This computer" : "This device"} className="h-8 w-44 rounded-md border border-line bg-raised px-2 text-ui outline-none focus:border-line-strong" />
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
    <div className="flex flex-col gap-2">
      <h3 className="px-1 text-ui font-medium text-muted">Remote access</h3>
      <Card>
        <div className="py-4" data-testid="remote-access">
          <p className="text-ui text-muted">
            A request through a tunnel or proxy, from another address or from another account on this machine needs this daemon's access token. Open this link once on the other device; it keeps the token as a cookie. Anyone with the link can use Keel as you.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-code px-2 py-1 font-mono text-caption text-fg" data-testid="remote-access-link">{full.replace(/token=[^&]+/, "token=\u2026")}</code>
            <button data-testid="remote-access-copy" onClick={(e) => copyOrSay(full, e.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })} className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover">{copied ? "Copied" : "Copy link"}</button>
          </div>
          {!link.hosts.length && <p className="k-empty mt-2">No tunnel host is set: start the daemon with KEEL_ALLOWED_HOSTS naming it.</p>}
        </div>
      </Card>
    </div>
  );
}
