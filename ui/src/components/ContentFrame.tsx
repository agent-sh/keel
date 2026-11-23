// A frame of content: a page a session wrote (an artifact) or a port a session serves (the
// preview). What runs in it is not Keel's, and it gets the keyboard only by the owner's own act
// (lib/frames.ts). One that keeps taking it is stopped: taken off the page, with a line in its
// place and a button that shows it again.
import { useEffect, useRef, useState, type IframeHTMLAttributes, type Ref } from "react";
import { flushSync } from "react-dom";
import { FRAME_ALLOW, STOPPED } from "../lib/frames.ts";
import { cn } from "../lib/utils.ts";

export function ContentFrame({ what, frameRef, className, ...rest }: IframeHTMLAttributes<HTMLIFrameElement> & { what: "page" | "preview"; frameRef?: Ref<HTMLIFrameElement>; "data-testid"?: string }) {
  const [stopped, setStopped] = useState(false);
  const own = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    const el = own.current;
    if (!el || stopped) return;
    // (At once: the frame is off the page before the guard that stopped it returns, so it can
    // take nothing more on its way out.)
    const on = () => flushSync(() => setStopped(true));
    el.addEventListener(STOPPED, on);
    return () => el.removeEventListener(STOPPED, on);
  }, [stopped]);
  if (stopped) {
    // (Its own surface, after the frame's classes: a frame is drawn on white for the page in it,
    // and this line is the panel's.)
    return (
      <div role="status" data-testid="frame-stopped" className={cn(className, "flex flex-col items-start gap-2 bg-bg p-4 text-ui text-muted")}>
        <p>This {what} took the keyboard by itself and was stopped.</p>
        <button type="button" data-testid="frame-show-again" onClick={() => setStopped(false)} className="h-8 rounded-lg border border-line bg-raised px-3 text-ui text-fg hover:bg-hover">Show it again</button>
      </div>
    );
  }
  const set = (el: HTMLIFrameElement | null) => {
    own.current = el;
    if (typeof frameRef === "function") frameRef(el);
    else if (frameRef) (frameRef as { current: HTMLIFrameElement | null }).current = el;
  };
  return <iframe {...rest} ref={set} className={className} allow={FRAME_ALLOW} data-content-frame="" />;
}
