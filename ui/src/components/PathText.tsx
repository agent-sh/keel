// A path in one line that keeps its file name in view: cut in the middle to
// the width it is given (measured in its own font), the whole path in its title.
// It takes the free width of its row (flex-1), so what it shows never sizes it.
import { useLayoutEffect, useRef, useState } from "react";
import { fitPath } from "../lib/paths.ts";
import { cn } from "../lib/utils.ts";

let canvas: HTMLCanvasElement | null = null;

export function PathText({ path, className, testid }: { path: string; className?: string; testid?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(path);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const width = el.clientWidth;
      if (!width) return;
      const ctx = (canvas ??= document.createElement("canvas")).getContext("2d")!;
      const st = getComputedStyle(el);
      ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
      setShown(fitPath(path, (s) => ctx.measureText(s).width <= width));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [path]);
  return (
    <span ref={ref} title={path} data-testid={testid} className={cn("block min-w-0 flex-1 overflow-hidden whitespace-nowrap", className)}>
      {shown}
    </span>
  );
}
