import { useEffect, useState, type ReactNode } from "react";
import { safety, useSafety } from "../lib/safety.ts";
import { api, reportError } from "../lib/store.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Card, SettingRow } from "./Settings.tsx";

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
          <select
            data-testid="default-mode"
            value={perm?.default_mode ?? ""}
            onChange={(e) => putPerm({ default_mode: e.target.value })}
            className="h-8 rounded-md border border-line bg-raised px-2 text-ui outline-none focus:border-line-strong"
          >
            {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </SettingRow>
        <SettingRow label="Reviewer mode's model" hint="Judges the calls a session in reviewer mode would ask you about. High-risk ones still come to you.">
          <div className="flex items-center gap-2" data-testid="reviewer-model">
            {perm?.reviewer_model ? <ModelPicker value={perm.reviewer_model} onChange={(m) => putPerm({ reviewer_model: m })} compact /> : <>{sameAs}<ModelPicker value="" onChange={(m) => putPerm({ reviewer_model: m })} compact /></>}
            {perm?.reviewer_model && <button className="text-caption text-faint hover:text-fg" onClick={() => putPerm({ reviewer_model: null })}>Reset</button>}
          </div>
        </SettingRow>
        <div className="border-b border-line py-4">
          <div className="text-base font-medium">Reviewer policy</div>
          <div className="mt-0.5 text-ui text-muted">Your own rules for reviewer mode, in plain words. They win over its built-in guidance.</div>
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
