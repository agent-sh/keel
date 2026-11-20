// The owner's small models: the models that read long material for every
// session (readers, a long fetched page, mail triage), best first. A model
// later in the list reads when the one before is not listed, does not hold the
// part, or fails. Empty: the cheapest model of the session's own provider.
import { ArrowUp, X } from "lucide-react";
import { reportError, useStore } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { useSettings } from "./StoragePanel.tsx";

const icon = "grid size-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg disabled:opacity-40";

export function SmallModels() {
  const models = useStore((s) => s.models);
  const [settings, patch] = useSettings();
  if (!settings) return null;
  const ids: string[] = settings.small_models?.ids ?? [];
  const save = (next: string[]) => patch({ small_models: { ids: next } }).catch(reportError);
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:w-[26rem]" data-testid="small-models">
      {ids.map((id, i) => {
        const m = models.find((x) => x.id === id);
        return (
          <div key={id} className="flex h-9 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 text-ui" data-testid="small-model">
            <span className="w-4 text-caption tabular-nums text-faint">{i + 1}</span>
            <span className={cn("min-w-0 flex-1 truncate", !m && "text-faint line-through")} title={id}>{m?.name ?? id}</span>
            {m && <span className="truncate text-caption text-faint">{m.provider}</span>}
            <button type="button" className={icon} aria-label="Move up" disabled={i === 0} onClick={() => save([...ids.slice(0, i - 1), id, ids[i - 1]!, ...ids.slice(i + 1)])}>
              <ArrowUp className="size-3.5" />
            </button>
            <button type="button" className={icon} aria-label={`Remove ${m?.name ?? id}`} onClick={() => save(ids.filter((x) => x !== id))}>
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
      <ModelMenu value="" placeholder={ids.length ? "Add a fallback" : "Add a small model"} onChange={(id) => id && !ids.includes(id) && save([...ids, id])} />
    </div>
  );
}
