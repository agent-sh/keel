// The owner moves a command that runs in front of a tool call behind it, at any time: the call returns
// with the command's ID, the command goes on, and its end starts the session's next turn. The one place
// for the key, the running card's control and the terminal panel's.
import { announce } from "./announce.ts";
import { tipSay } from "./tips.ts";
import { api, reportError } from "./store.ts";

// The key (a literal Ctrl, also on a Mac: Cmd+Option+B is Safari's bookmarks, Ctrl+B is the sidebar here).
export const BACKGROUND_COMMAND_KEYS = "ctrl+alt+b";

// The shell tools whose call waits on its command: the owner can move the command behind the call.
export const MOVABLE = new Set(["Bash", "run_shell_command"]);

// A command that runs in front of a call is on the page as a running shell call.
export const commandInFront = () => !!document.querySelector('[data-testid="tool-call"][data-kind="shell"][data-state="running"][data-movable]');

// `to`: what the words stand by (the control that was pressed). Names the command by its job or its call, else the newest in front.
export async function moveToBackground(session: string, which: { job?: string; call?: string } = {}, to?: Element | null): Promise<boolean> {
  const path = which.job ? `${which.job}/background` : which.call ? `call/${encodeURIComponent(which.call)}/background` : "background";
  try {
    const r = await api<{ moved: boolean }>(`/api/sessions/${session}/terminal/${path}`, { method: "POST" });
    if (!r.moved) {
      const said = "That command is no longer in front of a call.";
      tipSay(to, said, 3200);
      announce(said);
    } else announce("The command moved to the background.");
    return r.moved;
  } catch (e) {
    reportError(e, { at: "move to background" });
    return false;
  }
}
