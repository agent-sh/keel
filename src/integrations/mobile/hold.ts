// When a push goes out. Something that needs an answer waits 20 s, is held
// while the owner is at the desk and is dropped once it was answered or read;
// anything else goes at once unless the owner is at the desk. "At the desk" is a
// workbench that reported presence, or a screen the login manager says is
// unlocked. While the owner stays at the desk the check backs off from 1 s,
// doubling, to 20 s, so a held push does not start a process every second.
import { readText } from "../../core/proc.ts";

export const FIRST_WAIT_MS = 20_000;
export const MAX_PROBE_MS = 20_000;

export type HoldDeps = {
  needsAnswer: boolean;
  stillOpen: () => boolean; // not answered and not read
  atDesk: () => boolean | Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  send: () => Promise<void>;
};

// Resolves to whether the push was sent.
export async function holdThenSend(d: HoldDeps): Promise<boolean> {
  if (!d.needsAnswer) {
    if (await d.atDesk()) return false;
    await d.send();
    return true;
  }
  await d.sleep(FIRST_WAIT_MS);
  let wait = 1000;
  for (;;) {
    if (!d.stillOpen()) return false;
    if (!(await d.atDesk())) break;
    await d.sleep(wait);
    wait = Math.min(wait * 2, MAX_PROBE_MS);
  }
  await d.send();
  return true;
}

// The login manager's word on the screen: true only for an unlocked session;
// unknown counts as away.
export async function screenUnlocked(): Promise<boolean> {
  const run = async (argv: string[]) => {
    try {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const out = (await readText(p.stdout)).trim();
      return (await p.exited) === 0 ? out : "";
    } catch {
      return "";
    }
  };
  const id = process.env.XDG_SESSION_ID || (await run(["loginctl", "show-user", String(process.getuid?.() ?? ""), "-p", "Display", "--value"]));
  if (!id) return false;
  return (await run(["loginctl", "show-session", id, "-p", "LockedHint", "--value"])) === "no";
}
