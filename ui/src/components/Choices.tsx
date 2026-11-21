// A radio group whose Tab stop follows its value. Base UI takes the stop
// from the checked option once, when the group is made, and from the focus
// after that, so a value set from elsewhere (a command, a shortcut, another
// control) would leave Tab on the old option. The group is made again when
// its value changes while the focus is outside it; with the focus inside, the
// focus moves to the option now chosen.
import { RadioGroup } from "@base-ui/react/radio-group";
import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

export function Choices({ value, className, ...rest }: ComponentProps<typeof RadioGroup>) {
  const root = useRef<HTMLDivElement>(null);
  const [made, setMade] = useState(0);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    const el = root.current;
    if (!el?.contains(document.activeElement)) return setMade((n) => n + 1);
    const chosen = el.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (chosen !== document.activeElement) chosen?.focus();
  }, [value]);
  return <RadioGroup key={made} ref={root} value={value} className={cn("k-choices", className)} {...rest} />;
}
