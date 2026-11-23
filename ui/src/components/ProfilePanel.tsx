// The session's profile (GET /api/sessions/:id/profile). Read again when the
// session changes (a model, effort or speed pick).
import { useEffect, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { api, reportError } from "../lib/store.ts";
import { cn, fmtSize, fmtTokens } from "../lib/utils.ts";
import { PathText } from "./PathText.tsx";

type Profile = {
  model: { id: string; name: string; provider: string; family: string; context: number; output: number; billing: string; price?: { input: number; output: number } } | null;
  reasoning: { choice?: string; options: { kind: string; levels?: string[] } };
  speed: { choice: string; options: { speed: string; label: string; note?: string }[] };
  tool_profile: { label: string; family: string; edit_grammar: string } | null;
  eager_tools: string[];
  instructions: { files: { path: string; scope: string; bytes: number; included_bytes: number; truncated: boolean }[]; warnings: string[] };
};

function Row({ label, children, testid }: { label: string; children: React.ReactNode; testid?: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 border-b border-line py-2 text-ui last:border-0" data-testid={testid}>
      <span className="text-muted">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

const chip = (on: boolean) => cn("rounded-xs px-1.5 py-0.5 text-caption", on ? "bg-accent-soft font-medium text-accent-ink" : "bg-sunken text-muted");

function route(m: NonNullable<Profile["model"]>) {
  if (m.billing === "subscription") return "plan";
  return m.price ? `$${m.price.input} in, $${m.price.output} out per M` : "price unknown";
}

export function ProfilePanel({ session }: { session: Session }) {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    api<Profile>(`/api/sessions/${session.id}/profile`).then(setP, reportError);
  }, [session.id, session.model, session.settings.effort, session.settings.speed]);
  if (!p) return <p className="p-4 text-ui text-faint">Reading the profile.</p>;
  const m = p.model;
  const levels = p.reasoning.options.levels ?? [];
  const effort = p.reasoning.choice ?? (levels.includes("high") ? "high" : levels[0]);
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="profile-panel">
      <section className="rounded-lg border border-line bg-raised px-3">
        <Row label="Model" testid="profile-model">
          {m ? <><span className="font-medium">{m.name}</span> <span className="break-all text-caption text-faint">{m.id}</span></> : <span className="text-danger">{session.model} is not listed</span>}
        </Row>
        {m && <Row label="Route">{m.provider} · {route(m)}</Row>}
        {m && <Row label="Window">{fmtTokens(m.context)} in{m.output ? `, ${fmtTokens(m.output)} out` : ""}</Row>}
        <Row label="Reasoning" testid="profile-reasoning">
          {levels.length
            ? <span className="flex flex-wrap gap-1">{levels.map((l) => <span key={l} className={chip(l === effort)}>{l}</span>)}</span>
            : <span className="text-faint">the model takes no setting</span>}
        </Row>
        <Row label="Speed" testid="profile-speed">
          <span className="flex flex-wrap gap-1">{p.speed.options.map((o) => <span key={o.speed} title={o.note} className={chip(o.speed === p.speed.choice)}>{o.label}</span>)}</span>
        </Row>
      </section>
      {p.tool_profile && (
        <section className="rounded-lg border border-line bg-raised px-3" data-testid="profile-tools">
          <Row label="Tool profile">{p.tool_profile.label} <span className="text-caption text-faint">({p.tool_profile.family})</span></Row>
          <Row label="Edits with">{p.tool_profile.edit_grammar}</Row>
          <Row label="Tools">
            <span className="flex flex-wrap gap-1">{p.eager_tools.map((t) => <code key={t} className="rounded-xs bg-code px-1 font-mono text-micro text-muted">{t}</code>)}</span>
          </Row>
        </section>
      )}
      <section className="rounded-lg border border-line bg-raised px-3" data-testid="profile-instructions">
        <Row label="Instructions">
          {p.instructions.files.length ? (
            <ul className="flex flex-col gap-1">
              {p.instructions.files.map((f) => (
                <li key={f.path} className="flex items-baseline gap-2" data-scope={f.scope}>
                  <PathText path={f.path} className="font-mono text-caption" />
                  {f.scope === "nested" && <span className="shrink-0 text-micro text-faint" title="Loaded when the work reached its folder">on reach</span>}
                  <span className={cn("shrink-0 text-micro tabular-nums", f.truncated ? "text-warn" : "text-faint")}>{fmtSize(f.bytes)}{f.truncated ? ", cut" : ""}</span>
                </li>
              ))}
            </ul>
          ) : <span className="text-faint">no AGENTS.md or CLAUDE.md above the folder</span>}
        </Row>
      </section>
    </div>
  );
}
