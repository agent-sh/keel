import { Select as Base } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";

// A select written like the native one (`value`, `onChange`, <option> and
// <optgroup> children) and drawn by us: the native popup is the browser's or
// the toolkit's, and follows neither theme.
type Opt = { value: string; label: string; disabled?: boolean; group?: string };
type Props = {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  "data-testid"?: string;
};

const text = (n: ReactNode): string => Children.toArray(n).map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? text(c.props.children) : "")).join("");

function options(children: ReactNode, group?: string): Opt[] {
  return Children.toArray(children).flatMap((c): Opt[] => {
    if (!isValidElement<{ value?: string; disabled?: boolean; label?: string; children?: ReactNode }>(c)) return [];
    if (c.type === Fragment) return options(c.props.children, group);
    if (c.type === "optgroup") return options(c.props.children, c.props.label);
    if (c.type !== "option") return [];
    const label = text(c.props.children);
    return [{ value: String(c.props.value ?? label), label, disabled: c.props.disabled, group }];
  });
}

export function Select({ value, onChange, children, className, disabled, ...rest }: Props) {
  const opts = options(children);
  const label = opts.find((o) => o.value === value)?.label ?? value;
  let group: string | undefined;
  return (
    <Base.Root value={value} onValueChange={(v) => onChange({ target: { value: String(v ?? "") } })} disabled={disabled}>
      <Base.Trigger {...rest} data-value={value} className={cn("k-select", className)}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Base.Icon className="flex-none text-faint"><ChevronsUpDown className="size-3.5" /></Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner alignItemWithTrigger={false} sideOffset={4} className="z-[70] outline-none">
          <Base.Popup className={cn(popupClass, "max-h-[min(var(--available-height),22rem)] min-w-[var(--anchor-width)] max-w-[min(36rem,calc(100vw-1rem))] overflow-y-auto")}>
            {opts.map((o) => {
              const head = o.group !== group ? o.group : undefined;
              group = o.group;
              return (
                <Fragment key={o.value}>
                  {head && <div className="px-2.5 pb-1 pt-2 k-label">{head}</div>}
                  <Base.Item value={o.value} disabled={o.disabled} data-value={o.value} className={cn(itemClass, "justify-between")}>
                    <Base.ItemText className="min-w-0 truncate">{o.label}</Base.ItemText>
                    <Base.ItemIndicator className="flex-none"><Check className="size-3.5 text-muted" /></Base.ItemIndicator>
                  </Base.Item>
                </Fragment>
              );
            })}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
