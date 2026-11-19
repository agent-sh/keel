import { ChevronsUpDown } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { useStore } from "../lib/store.ts";
import { usePeerModels } from "../lib/peer-models.ts";
import { cn } from "../lib/utils.ts";

const ModelMenu = lazy(() => import("./ModelMenu.tsx").then((m) => ({ default: m.ModelMenu })));

export const triggerClass = (compact?: boolean) =>
  cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted transition-colors hover:bg-hover hover:text-fg", compact && "px-1.5");

// A saved model the listing does not have is still named, by its full id,
// and said to be missing once the listing is in (a listing still on its way
// proves nothing). "Choose a model" is only for no selection at all; "No
// models" only once the listing came back empty.
// `placeholder` names what an empty choice means ("Same as the session").
export function TriggerLabel({ label, any, value, placeholder }: { label?: string; any: boolean; value?: string; placeholder?: string }) {
  const loaded = useStore((s) => s.loaded.models);
  const missing = !label && !!value && loaded;
  const text = label ?? (value ? value : placeholder ?? (any ? "Choose a model" : loaded ? "No models" : "Loading models"));
  return (
    <>
      <span className="max-w-40 truncate sm:max-w-56" title={missing ? `${value} is not in the current listing` : undefined}>{text}</span>
      {missing && <span className="shrink-0 text-micro text-warn" data-testid="model-unlisted">not in current listing</span>}
      <ChevronsUpDown className="size-3.5 opacity-60" />
    </>
  );
}

// The model picker. Its menu (a Combobox) is a separate chunk that loads right
// after the page; until then the same trigger stands in, and a click on it
// opens the menu once it is there. `openSignal` opens it when it changes.
// `machine`: the session is that daemon's, and its listing is the one offered.
export function ModelPicker(props: { value: string; onChange: (id: string) => void; compact?: boolean; openSignal?: number; machine?: string; placeholder?: string }) {
  const atMount = useRef(props.openSignal ?? 0);
  const [clicked, setClicked] = useState(0);
  const peer = usePeerModels(props.machine);
  const localLabel = useStore((s) => s.models.find((m) => m.id === props.value)?.name);
  const localAny = useStore((s) => s.models.length > 0);
  const label = props.machine ? peer?.models?.find((m) => m.id === props.value)?.name : localLabel;
  const any = props.machine ? !!peer?.models?.length : localAny;
  const signal = (props.openSignal ?? 0) !== atMount.current ? props.openSignal! : clicked;
  return (
    <Suspense
      fallback={
        <button type="button" data-testid="model-picker" className={triggerClass(props.compact)} onClick={() => setClicked((n) => n + 1)}>
          <TriggerLabel label={label} any={any} value={props.value} placeholder={props.placeholder} />
        </button>
      }
    >
      <ModelMenu {...props} openSignal={signal} />
    </Suspense>
  );
}
