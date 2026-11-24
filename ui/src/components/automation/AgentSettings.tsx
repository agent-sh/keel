import { useEffect, useState } from "react";
import { advisorSession, auto, setAdvisorSession } from "../../lib/automation.ts";
import { reportError, useStore, useModels } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { Card, SettingRow } from "../Settings.tsx";

type SessionAdvisor = { model: string | null; own: string | null; default: string | null };
const choice = "h-8 rounded-md border px-3 text-ui";

// A bare /advisor came from a session: its own advisor, chosen here. "Use the
// default" puts it back on the default; the default itself is the card below.
function ThisSession({ id, title, onDone }: { id: string; title: string; onDone: () => void }) {
  const [a, setA] = useState<SessionAdvisor | undefined>(undefined);
  const models = useModels();
  const name = (m: string | null) => (m ? models.find((x) => x.id === m)?.name ?? m : "none");
  useEffect(() => void auto.sessionAdvisor(id).then(setA).catch(reportError), [id]);
  if (!a) return null;
  const save = (m: string | null) => auto.setSessionAdvisor(id, m).then(setA).catch(reportError);
  const inherits = a.own === null;
  return (
    <Card>
      <SettingRow label={`Advisor of "${title}"`} hint="This session's own choice. The default below applies to every session that has none.">
        <div className="flex flex-wrap items-center gap-2" data-testid="advisor-session">
          <ModelPicker value={a.own && a.own !== "off" ? a.own : ""} onChange={(m) => save(m)} />
          <button type="button" data-testid="advisor-session-default" onClick={() => save(null)} className={cn(choice, inherits ? "border-accent text-accent" : "border-line-strong bg-raised hover:bg-hover")}>
            Use the default ({name(a.default)})
          </button>
          <button type="button" data-testid="advisor-session-off" onClick={() => save("off")} className={cn(choice, a.own === "off" ? "border-accent text-accent" : "border-line-strong bg-raised hover:bg-hover")}>
            Off
          </button>
        </div>
      </SettingRow>
      <div className="pb-4 text-caption text-muted" data-testid="advisor-session-current">
        {a.own === "off" ? "This session has no advisor." : inherits ? `This session uses the default: ${name(a.default)}.` : `This session's advisor: ${name(a.own)}.`}
        <button type="button" onClick={onDone} className="k-link ml-2 text-accent hover:underline">Done</button>
      </div>
    </Card>
  );
}

// Customize > Agents: the advisor the working model may consult.
export default function AgentSettings() {
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [from, setFrom] = useState(advisorSession);
  const name = useModels().find((m) => m.id === model)?.name;
  // A saved advisor the listing no longer has: the preference stays, and the
  // page says it cannot be consulted now (a consultation would refuse it).
  const unlisted = useStore((s) => s.loaded.allModels && !!model && !s.models.some((m) => m.id === model));
  useEffect(() => void auto.advisor().then((r) => setModel(r.model)).catch(reportError), []);
  // Leaving the page forgets where it was opened from.
  useEffect(() => () => setAdvisorSession(null), []);
  if (model === undefined) return null;
  const save = (m: string | null) => auto.setAdvisor(m).then((r) => setModel(r.model)).catch(reportError);
  return (
    <div className="flex flex-col gap-4" data-testid="agent-settings">
      {from && <ThisSession id={from.id} title={from.title} onDone={() => { setAdvisorSession(null); setFrom(null); }} />}
      <Card>
        <SettingRow
          label={from ? "Default advisor, for every session" : "Advisor"}
          hint="A second model the working model may consult at decision points (before a large change, on a repeating error, before calling a task done). It reads the conversation, runs no tools, and its tokens are billed at its price. /advisor sets one per session."
        >
          <div className="flex items-center gap-2" data-testid="advisor-setting">
            <ModelPicker value={model ?? ""} onChange={(id) => save(id)} />
            {model && (
              <button type="button" data-testid="advisor-off" onClick={() => save(null)} className="k-btn k-btn-lg">
                None
              </button>
            )}
          </div>
        </SettingRow>
        <div className="pb-4 text-caption text-muted" data-testid="advisor-current">{unlisted
          ? <span className="text-warn">Saved advisor unavailable: {model} is not in its provider's listing now. Choose another or None; it comes back if it is listed again.</span>
          : model ? `Advisor: ${name ?? model}` : "No advisor: the advisor tool tells the model to go on by itself."}</div>
      </Card>
    </div>
  );
}
