// A divider that resizes what is on its two sides: drag it, or focus it and
// use the arrow keys (Shift for bigger steps); a double click or Enter puts
// the default back. The owner of the sizes gets the distance moved since the
// drag began, in px, and decides what fits; it is told when the drag ends, so
// it can move the page directly while dragging and keep the result once.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export function Grip({ label, now, onStart, onMove, onEnd, onReset, className, testid }: {
  label: string;
  now?: number; // the share of the side before the divider, 0 to 100
  onStart: () => void; // a drag or a key step begins: remember the sizes it starts from
  onMove: (dx: number) => void;
  onEnd: () => void; // the drag or key step is over: keep the sizes
  onReset: () => void;
  className?: string;
  testid?: string;
}) {
  const from = useRef<number | null>(null);
  const [drag, setDrag] = useState(false);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    from.current = e.clientX;
    setDrag(true);
    document.documentElement.dataset.resizing = "";
    onStart();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => { if (from.current !== null) onMove(e.clientX - from.current); };
  const up = () => {
    if (from.current === null) return;
    from.current = null;
    onEnd();
    setDrag(false);
    delete document.documentElement.dataset.resizing;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") { e.preventDefault(); return onReset(); }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onStart();
    onMove((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 64 : 16));
    onEnd();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={now === undefined ? undefined : Math.round(now)}
      aria-valuemin={now === undefined ? undefined : 0}
      aria-valuemax={now === undefined ? undefined : 100}
      tabIndex={0}
      title={`${label}: drag, or arrow keys. Double click to reset.`}
      className={`k-grip${className ? ` ${className}` : ""}`}
      data-drag={drag || undefined}
      data-testid={testid}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={onReset}
      onKeyDown={key}
    />
  );
}
