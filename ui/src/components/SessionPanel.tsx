// The session's own marks and operations, as a side-panel tab: pin, done,
// tags, the step budget, messages from other sessions. Plain controls on the
// shared tokens; the look belongs to the design of the workbench.
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { archive, cloneSession, marks, moveSession, pin, setDone, setMaxSteps, setSkillMode, setTags, writeRecap, type Marks } from "../lib/sessops.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { composing } from "../lib/keys.ts";
import { api, onFeature, reportError } from "../lib/store.ts";
import { seedComposer } from "../lib/ui.ts";
import { openPlaced } from "../lib/looks.ts";
import { ago, cn, fmtCost } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { SessionOrganize } from "./SessionOrganize.tsx";
import { useAuto } from "../lib/automation.ts";

export function Section({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <section className="rounded-lg border border-line bg-raised px-3 py-2" data-testid={testid}>
      <h3 className="pb-1 k-label">{title}</h3>
      {children}
    </section>
  );
}

export function Line({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2 text-ui last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-caption text-faint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export function Toggle({ on, label, onChange, testid }: { on: boolean; label: string; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testid}
      onClick={() => onChange(!on)}
      className="k-switch"
    >
      <span className="k-switch-thumb" />
    </button>
  );
}

export const button = "k-btn shrink-0";
export const field = "h-7 min-w-0 rounded-md border border-line bg-sunken px-2 text-ui outline-none focus:ring-2 focus:ring-ring";

function Tags({ s }: { s: Session }) {
  const tags = s.settings.tags ?? [];
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    setTags(s.id, [...tags, ...t.split(",").map((x) => x.trim()).filter(Boolean)]).catch(reportError);
  };
  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="flex flex-wrap gap-1" data-testid="session-tags">
        {tags.length === 0 && <span className="k-empty">No tags. Tags group sessions in the list and filter it.</span>}
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-xs bg-sunken px-1.5 py-0.5 text-caption text-muted" data-testid="session-tag">
            {t}
            <button type="button" aria-label={`Remove tag ${t}`} className="text-faint hover:text-fg" onClick={() => setTags(s.id, tags.filter((x) => x !== t)).catch(reportError)}>×</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !composing(e) && add()} placeholder="Add a tag" aria-label="Add a tag" data-testid="tag-input" className={cn(field, "flex-1")} />
        <button type="button" className={button} onClick={add} disabled={!text.trim()}>Add</button>
      </div>
    </div>
  );
}

function Steps({ s }: { s: Session }) {
  const [v, setV] = useState(String(s.settings.max_steps ?? ""));
  useEffect(() => setV(String(s.settings.max_steps ?? "")), [s.settings.max_steps]);
  const save = () => {
    const n = v.trim() === "" ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0) return setV(String(s.settings.max_steps ?? ""));
    if (n !== (s.settings.max_steps ?? 0)) setMaxSteps(s.id, n).catch(reportError);
  };
  return (
    <input
      value={v}
      inputMode="numeric"
      placeholder="none"
      aria-label="Step budget"
      data-testid="max-steps"
      onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && !composing(e) && save()}
      className={cn(field, "w-20 text-right tabular-nums")}
    />
  );
}

// How many of its agents may work at once. Agents that wait on a wait of their own hold no slot;
// an agent asked for, or woken, while every slot works waits in line and goes on when one frees.
type Slots = { limit: number; default_limit: number; own_limit: number | null };
function AgentSlots({ s }: { s: Session }) {
  const [got, setGot] = useState<Slots>();
  const [v, setV] = useState("");
  const all = useAuto((st) => st.agents);
  useEffect(() => {
    let live = true;
    api<Slots>(`/api/sessions/${s.id}/agents`).then((r) => { if (live) { setGot(r); setV(r.own_limit === null ? "" : String(r.own_limit)); } }).catch(reportError);
    return () => { live = false; };
  }, [s.id]);
  const mine = Object.values(all).filter((a) => a.parent_id === s.id);
  const work = mine.filter((a) => a.status === "running").length;
  const line = mine.filter((a) => a.status === "waiting" && a.slot_wait).length;
  const wait = mine.filter((a) => a.status === "waiting" && !a.slot_wait).length;
  const save = () => {
    if (!got) return;
    const n = v.trim() === "" ? null : Number(v);
    if (n !== null && (!Number.isInteger(n) || n < 1)) return setV(got.own_limit === null ? "" : String(got.own_limit));
    if (n === got.own_limit) return;
    api<Slots>(`/api/sessions/${s.id}/agents`, { method: "PATCH", body: JSON.stringify({ limit: n }) }).then((r) => setGot({ ...got, ...r })).catch(reportError);
  };
  const said = [`${work} of ${got?.limit ?? ""} ${work === 1 ? "works" : "work"}`, wait && `${wait} ${wait === 1 ? "waits on a wait of its own" : "wait on waits of their own"}`, line && `${line} in line for a slot`].filter(Boolean).join(", ");
  return (
    <Line label="Agents at once" hint={<>Agents that work at the same time; one that waits holds no slot. Empty: the daemon's {got?.default_limit ?? ""}.<span className="block" data-testid="agent-slots-said">{got ? said : ""}</span></>}>
      <input
        value={v}
        inputMode="numeric"
        placeholder={got ? String(got.default_limit) : ""}
        aria-label="Agents at once"
        data-testid="agent-limit"
        onChange={(e) => setV(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && save()}
        className={cn(field, "w-20 text-right tabular-nums")}
      />
    </Line>
  );
}

function Messages({ s }: { s: Session }) {
  const [m, setM] = useState<Marks | null>(null);
  useEffect(() => { marks.get(s.id).then(setM, reportError); }, [s.id, s.settings.accept_messages, s.settings.peer_turns]);
  const [turns, setTurns] = useState("");
  useEffect(() => { if (m) setTurns(String(m.peer_turns)); }, [m?.peer_turns]);
  if (!m) return null;
  const saveTurns = () => {
    const n = Number(turns);
    if (!Number.isInteger(n) || n < 1) return setTurns(String(m.peer_turns));
    if (n !== m.peer_turns) marks.set(s.id, { peer_turns: n }).then(setM, reportError);
  };
  return (
    <>
      <Line label="Take messages from other sessions" hint="Off: another session's message is refused.">
        <Toggle on={m.accept_messages} label="Take messages from other sessions" testid="accept-messages" onChange={(v) => marks.set(s.id, { accept_messages: v }).then(setM, reportError)} />
      </Line>
      <Line label="Turns they may start" hint="Before you speak here again; past it a message waits for you.">
        <input value={turns} inputMode="numeric" aria-label="Turns other sessions may start" data-testid="peer-turns" disabled={!m.accept_messages}
          onChange={(e) => setTurns(e.target.value.replace(/[^0-9]/g, ""))} onBlur={saveTurns} onKeyDown={(e) => e.key === "Enter" && !composing(e) && saveTurns()}
          className={cn(field, "w-20 text-right tabular-nums")} />
      </Line>
    </>
  );
}

type Digest = { recap?: string; next_prompt?: string; ts_ms: number; recap_seq: number; cost_usd?: number };

// The recap: written on demand on the session's own cached prefix, shown here,
// never part of what the model reads.
function Recap({ s }: { s: Session }) {
  const [d, setD] = useState<Digest | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ digest: Digest | null }>(`/api/sessions/${s.id}/recap`).then((r) => setD(r.digest), reportError);
    return onFeature({ frame: (f) => { if (f.name === "recap" && f.session_id === s.id) setD(f.data); } });
  }, [s.id]);
  const write = () => {
    setBusy(true);
    writeRecap(s.id).then((r) => setD(r), reportError).finally(() => setBusy(false));
  };
  return (
    <Section title="Recap" testid="recap">
      {d?.recap ? (
        <div className="py-1">
          <p className="text-ui" data-testid="recap-text">{d.recap}</p>
          <p className="mt-1 text-caption text-faint">Written {ago(d.ts_ms) === "now" ? "just now" : `${ago(d.ts_ms)} ago`}{d.cost_usd !== undefined ? `, ${fmtCost(d.cost_usd)}` : ""}</p>
          {d.next_prompt && (
            <div className="mt-2 flex items-center gap-2 rounded-md bg-sunken px-2 py-1.5">
              <span className="min-w-0 flex-1 text-caption text-muted"><span className="font-medium text-fg">Next: </span>{d.next_prompt}</span>
              <button type="button" className={button} data-testid="recap-use" onClick={() => seedComposer(d.next_prompt!, s.id)}>Use</button>
            </div>
          )}
        </div>
      ) : (
        <p className="py-1 text-caption text-faint">{d ? "The model wrote no recap." : "Where the session stands, in a sentence or two, for when you come back."}</p>
      )}
      <div className="flex justify-end py-1.5">
        <button type="button" className={button} disabled={busy || !s.head} onClick={write} data-testid="recap-write">{busy ? "Writing" : d ? "Write again" : "Write a recap"}</button>
      </div>
    </Section>
  );
}

// Where the session works: move it (the conversation goes on there), or clone
// it into another folder or a worktree of its own.
function Place({ s }: { s: Session }) {
  const [to, setTo] = useState("");
  const [copy, setCopy] = useState(false);
  const [git, setGit] = useState(false);
  const [wt, setWt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const run = (f: () => Promise<string | void>) => {
    setBusy(true);
    setSaid(null);
    f().then((m) => m && setSaid(m), (e) => { setSaid((e as Error).message); if (![400, 409].includes((e as { status?: number }).status ?? 0)) reportError(e, { at: "session folder" }); }).finally(() => setBusy(false));
  };
  const target = to || s.workspace;
  return (
    <Section title="Folder" testid="place">
      <p className="truncate py-1 font-mono text-caption text-muted" title={s.workspace}>{s.workspace}</p>
      <div className="flex flex-wrap items-center gap-2 py-1.5">
        <WorkspacePicker value={target} onChange={setTo} />
        <label className="flex items-center gap-1.5 text-caption text-muted"><input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} data-testid="move-copy" /> Copy its files</label>
        <label className="flex items-center gap-1.5 text-caption text-muted"><input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} data-testid="move-git" /> Make it a git repository</label>
      </div>
      <div className="flex flex-wrap justify-end gap-2 py-1.5">
        <label className="mr-auto flex items-center gap-1.5 text-caption text-muted"><input type="checkbox" checked={wt} onChange={(e) => setWt(e.target.checked)} data-testid="clone-worktree" /> Clone into a new worktree</label>
        <button type="button" className={button} data-testid="clone-session" disabled={busy || s.phase === "working"}
          onClick={() => run(async () => { const r = await cloneSession(s.id, { cwd: to || undefined, worktree: wt ? {} : undefined }); openPlaced(r.session.id, s.id); })}>Clone</button>
        <button type="button" className={button} data-testid="move-session" disabled={busy || s.phase === "working" || (!to && !git) || (to === s.workspace && !git)}
          onClick={() => run(async () => { const r = await moveSession(s.id, { cwd: to && to !== s.workspace ? to : undefined, copy_files: copy || undefined, init_git: git || undefined }); setTo(""); return r.files_copied ? `Moved, ${r.files_copied} files copied.` : "Applied."; })}>{to && to !== s.workspace ? "Move here" : "Apply"}</button>
      </div>
      {said && <p className="pb-1.5 text-caption text-muted" role="status" data-testid="place-said">{said}</p>}
    </Section>
  );
}

// One skill the owner may invoke, kept on for every turn until turned off.
function SkillMode({ s }: { s: Session }) {
  const [skills, setSkills] = useState<{ name: string; description: string }[] | null>(null);
  useEffect(() => { api<{ skills: { name: string; description: string }[] }>(`/api/sessions/${s.id}/skill-mode`).then((r) => setSkills(r.skills), reportError); }, [s.id, s.workspace]);
  const mode = s.settings.skill_mode ?? "";
  const pick = skills?.find((k) => k.name === mode);
  return (
    <Section title="Skill mode" testid="skill-mode">
      <Line label="Standing skill" hint={pick ? pick.description.slice(0, 140) : "A skill whose instructions hold on every turn. It reaches the model as a message, so the cached prompt stays."}>
        <Select value={mode} aria-label="Skill mode" data-testid="skill-mode-select" disabled={!skills}
          onChange={(e) => setSkillMode(s.id, e.target.value || null).catch(reportError)} className={cn(field, "max-w-40")}>
          <option value="">Off</option>
          {(skills ?? []).map((k) => <option key={k.name} value={k.name}>{k.name}</option>)}
          {mode && skills && !pick && <option value={mode}>{mode} (not found)</option>}
        </Select>
      </Line>
    </Section>
  );
}

type OwnServer = { name: string; session?: string; target: string; state: string; error?: string };
const SERVER_STATE: Record<string, string> = { ready: "Running", connecting: "Starting", error: "Failed", needs_auth: "Needs sign-in" };

// The tool servers an editor passed with this session (over ACP): programs and
// addresses that run for this session alone. Each is shown as what runs, its
// command and arguments or its address, never an environment or header value.
function EditorServers({ s }: { s: Session }) {
  const [list, setList] = useState<OwnServer[]>([]);
  useEffect(() => {
    const load = () => api<{ servers: OwnServer[] }>(`/api/sessions/${s.id}/mcp`).then((r) => setList(r.servers.filter((x) => x.session)), reportError);
    load();
    return onFeature({ frame: (f) => { if (f.name === "mcp-session" && f.session_id === s.id) load(); } });
  }, [s.id]);
  if (!list.length) return null;
  return (
    <Section title="Tool servers from the editor" testid="editor-servers">
      <p className="pb-1 text-caption text-faint">The editor that opened this session passed them. They run for this session only, with its permissions, and end with it.</p>
      {list.map((x) => (
        <Line key={x.name} label={x.name} hint={<><span className="block break-all font-mono">{x.target}</span>{x.state === "error" && x.error && <span className="block text-danger">{x.error.split("\n")[0]}</span>}</>}>
          <span className={cn("shrink-0 text-caption", x.state === "error" ? "text-danger" : "text-muted")} data-testid="editor-server-state">{SERVER_STATE[x.state] ?? x.state}</span>
        </Line>
      ))}
    </Section>
  );
}

type OwnerServer = { name: string; session?: string; state: string; enabled: boolean; tools: number; bundled?: string };

// The owner's MCP servers for this session alone: a server turned off here offers its tools to no request of this
// session (the others keep it), and a call of one is told why. A tool its conversation loaded stays as it was until
// the prompt cache is cold. Customize > MCP servers is for every session.
function ServersHere({ s }: { s: Session }) {
  const [list, setList] = useState<OwnerServer[] | null>(null);
  useEffect(() => {
    const load = () => api<{ servers: OwnerServer[] }>(`/api/sessions/${s.id}/mcp`).then((r) => setList(r.servers.filter((x) => !x.session)), reportError);
    load();
    return onFeature({ frame: (f) => { if (f.name === "mcp-session" && f.session_id === s.id) load(); } });
  }, [s.id]);
  const off = new Set(s.settings.mcp_off ?? []);
  const shown = (list ?? []).filter((x) => x.enabled || off.has(x.name));
  if (!shown.length) return null;
  const put = (name: string, on: boolean) => api(`/api/sessions/${s.id}/mcp/${encodeURIComponent(name)}/off`, { method: "POST", body: JSON.stringify({ off: !on }) }).catch(reportError);
  return (
    <Section title="MCP servers in this session" testid="session-servers">
      <p className="pb-1 text-caption text-faint">Turn one off to leave its tools out of this session only. A tool it already loaded stays until the prompt cache is cold. Customize, then MCP servers, is for every session.</p>
      {shown.map((x) => (
        <div key={x.name} data-testid="session-server" data-server={x.name} data-off={off.has(x.name) ? "yes" : "no"}>
        <Line label={x.name} hint={`${x.tools} ${x.tools === 1 ? "tool" : "tools"}${x.state !== "ready" && x.state !== "idle" ? ` · ${SERVER_STATE[x.state] ?? x.state}` : ""}`}>
          <Toggle on={!off.has(x.name)} label={`${x.name} in this session`} testid="session-server-toggle" onChange={(v) => void put(x.name, v)} />
        </Line>
        </div>
      ))}
    </Section>
  );
}

type AgentSwitch = { id: string; name: string; description?: string; current?: boolean; set?: boolean; held?: true };

// An ACP agent's own on and off options (its boolean config options). The
// owner's setting goes to the agent before its next prompt; one that would let
// the agent act without asking is Keel's permission mode's to decide.
function AgentSwitches({ s }: { s: Session }) {
  const [list, setList] = useState<AgentSwitch[]>([]);
  const acp = s.model.startsWith("acp:");
  useEffect(() => {
    if (!acp) return setList([]);
    api<{ switches: AgentSwitch[] }>(`/api/acp/sessions/${s.id}/switches`).then((r) => setList(r.switches), reportError);
  }, [s.id, s.model, acp, JSON.stringify(s.settings.acp_switches ?? {})]);
  if (!list.length) return null;
  const put = (id: string, value: boolean) =>
    api<{ switches: AgentSwitch[] }>(`/api/acp/sessions/${s.id}/switches`, { method: "PUT", body: JSON.stringify({ id, value }) }).then((r) => setList(r.switches), reportError);
  return (
    <Section title="Agent options" testid="agent-switches">
      <p className="pb-1 text-caption text-faint">The agent's own options. A change reaches it with your next message.</p>
      {list.map((x) => {
        const on = x.set ?? x.current ?? false;
        return (
          <Line key={x.id} label={x.name} hint={x.held ? "It is about what the agent may do without asking: this session's permission mode and sandbox decide that." : x.description}>
            {x.held
              ? <span className="shrink-0 text-caption text-muted" data-testid="agent-switch-held">Held by Keel</span>
              : <Toggle on={on} label={x.name} testid={`agent-switch-${x.id}`} onChange={(v) => put(x.id, v)} />}
          </Line>
        );
      })}
    </Section>
  );
}

export function SessionPanel({ session: s }: { session: Session }) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4" data-testid="session-panel">
      <Section title="Marks" testid="marks">
        <Line label="Pinned" hint="Keeps its pane on the bridge and the top of the list, on every device.">
          <Toggle on={!!s.settings.pinned_ms} label="Pinned" testid="pin-toggle" onChange={(v) => pin(s.id, v).catch(reportError)} />
        </Line>
        <Line label={STATE_WORD.done} hint="The work is finished. Your next message reopens it.">
          <Toggle on={!!s.settings.done_ms} label={STATE_WORD.done} testid="done-toggle" onChange={(v) => setDone(s.id, v).catch(reportError)} />
        </Line>
        <Line label="Step budget" hint="Model steps one turn may take. Empty: no budget.">
          <Steps s={s} />
        </Line>
        {!s.parent_id && <AgentSlots s={s} />}
        <Tags s={s} />
      </Section>
      <SessionOrganize s={s} />
      {!s.parent_id && (
        <Section title="Other sessions" testid="peer-marks">
          <Messages s={s} />
        </Section>
      )}
      <Recap s={s} />
      {!s.machine && <Place s={s} />}
      <SkillMode s={s} />
      <ServersHere s={s} />
      <EditorServers s={s} />
      <AgentSwitches s={s} />
      <Section title="Archive">
        <Line label={s.archived ? "Archived" : "Put it away"} hint={s.archived ? "Restore it to work in it again." : "Stops its turn and background commands; it stays searchable."}>
          <button type="button" className={button} data-testid="panel-archive" onClick={() => archive(s, !s.archived).catch(reportError)}>{s.archived ? "Restore" : "Archive"}</button>
        </Line>
      </Section>
    </div>
  );
}
