import { ChevronsUpDown } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { useStore } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

const ModelMenu = lazy(() => import("./ModelMenu.tsx").then((m) => ({ default: m.ModelMenu })));

export const triggerClass = (compact?: boolean) =>
  cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted transition-colors hover:bg-hover hover:text-fg", compact && "px-1.5");

export function TriggerLabel({ label, any }: { label?: string; any: boolean }) {
  return (
    <>
      <span className="max-w-40 truncate sm:max-w-56">{label ?? (any ? "Choose a model" : "No models")}</span>
      <ChevronsUpDown className="size-3.5 opacity-60" />
    </>
  );
}

// The model picker. Its menu (a Combobox) is a separate chunk that loads right
// after the page; until then the same trigger stands in, and a click on it
// opens the menu once it is there. `openSignal` opens it when it changes.
export function ModelPicker(props: { value: string; onChange: (id: string) => void; compact?: boolean; openSignal?: number }) {
  const atMount = useRef(props.openSignal ?? 0);
  const [clicked, setClicked] = useState(0);
  const label = useStore((s) => s.models.find((m) => m.id === props.value)?.name);
  const any = useStore((s) => s.models.length > 0);
  const signal = (props.openSignal ?? 0) !== atMount.current ? props.openSignal! : clicked;
  return (
    <Suspense
      fallback={
        <button type="button" data-testid="model-picker" className={triggerClass(props.compact)} onClick={() => setClicked((n) => n + 1)}>
          <TriggerLabel label={label} any={any} />
        </button>
      }
    >
      <ModelMenu {...props} openSignal={signal} />
    </Suspense>
  );
}
