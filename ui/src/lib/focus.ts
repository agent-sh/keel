// Focus: the way a session is shown while the owner works in it. The
// conversation and the message box at a reading width, the session's title
// in quiet ink above them, and nothing else: no list, no dock, no counts.
// The list comes back laid over the page (a press on the window's left edge,
// or Ctrl B) and goes when a session is picked or on Escape. What needs the
// owner in another session is one quiet line at the bottom edge. A side panel
// opens only when asked for. Ctrl . (and the quiet control at the top right)
// leaves for the full workbench and comes back; the choice is kept.
// Focus is the default. It covers a session's page on a desk; the start
// page, Settings and a phone keep their own layout.
import { registerCommand } from "./keys.ts";
import { PHONE_QUERY } from "./phone.ts";
import { getUI, savePref, setUI, useUI } from "./ui.ts";
import { useEffect, useState } from "react";

export const FOCUS_KEYS = "mod+.";
const desk = () => !matchMedia(PHONE_QUERY).matches;

// Whether the page shows a session in Focus now.
export function focusOn(): boolean {
  const ui = getUI();
  return !ui.workbench && ui.route.name === "session" && desk();
}

function useDesk(): boolean {
  const [d, setD] = useState(desk);
  useEffect(() => {
    const m = matchMedia(PHONE_QUERY);
    const f = () => setD(!m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return d;
}

export function useFocus(): boolean {
  const on = useUI((s) => !s.workbench && s.route.name === "session");
  return useDesk() && on;
}

// Leaves Focus for the workbench, or comes back. A list laid over the page goes with it.
export function toggleFocus(on?: boolean) {
  const next = on ?? getUI().workbench;
  setUI({ peek: false });
  savePref("workbench", !next);
}

registerCommand({
  id: "focus-mode", label: "Focus: the conversation alone, or the full workbench", group: "View", keys: FOCUS_KEYS, inInput: true,
  words: "focus calm zen workbench clean quiet distraction sidebar dock layout",
  run: () => toggleFocus(),
});
