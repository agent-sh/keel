import { useEffect, useState } from "react";
import { auto } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { Card, SettingRow } from "../Settings.tsx";

// Settings > Agents: the advisor the working model may consult.
export default function AgentSettings() {
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const name = useStore((s) => s.models.find((m) => m.id === model)?.name);
  // A saved advisor the listing no longer has: the preference stays, and the
  // page says it cannot be consulted now (a consultation would refuse it).
  const unlisted = useStore((s) => s.loaded.models && !!model && !s.models.some((m) => m.id === model));
  useEffect(() => void auto.advisor().then((r) => setModel(r.model)).catch(reportError), []);
  if (model === undefined) return null;
  const save = (m: string | null) => auto.setAdvisor(m).then((r) => setModel(r.model)).catch(reportError);
  return (
    <div className="flex flex-col gap-4" data-testid="agent-settings">
      <Card>
        <SettingRow
          label="Advisor"
          hint="A second model the working model may consult at decision points (before a large change, on a repeating error, before calling a task done). It reads the conversation, runs no tools, and its tokens are billed at its price. /advisor sets one per session."
        >
          <div className="flex items-center gap-2" data-testid="advisor-setting">
            <ModelPicker value={model ?? ""} onChange={(id) => save(id)} />
            {model && (
              <button type="button" data-testid="advisor-off" onClick={() => save(null)} className="h-8 rounded-md border border-line-strong bg-raised px-3 text-ui hover:bg-hover">
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
