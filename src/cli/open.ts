import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Client } from "./client.ts";
import { openUrl } from "./client.ts";

// Where `keel open` lands a session: in the desktop app when one is attached to
// the daemon (it says so on its event stream, src/server/shell.ts), else in the
// browser. The app is handed the place the way its own second launch is: its
// program with a keel:// link, which raises the running window. The program is
// KEEL_DESKTOP (words, like KEEL_BROWSER), else `keel-desktop` on the PATH or
// beside this program. With none found, or when the app does not start, the
// browser takes it.
export type Landed = "app" | "browser" | false;

function desktopCommand(): string[] | undefined {
  if (process.env.KEEL_DESKTOP) return process.env.KEEL_DESKTOP.split(" ").filter(Boolean);
  const beside = join(dirname(process.execPath), "keel-desktop");
  const found = Bun.which("keel-desktop") ?? (existsSync(beside) ? beside : undefined);
  return found ? [found] : undefined;
}

// Whether an app is attached to this daemon. A daemon that does not say (an older one, a remote one) has none.
async function attached(c: Client): Promise<boolean> {
  try {
    const r = await fetch(`${c.base}/api/shell`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json() as { attached?: boolean }).attached === true;
  } catch { return false; }
}

export async function openSession(c: Client, sessionId: string): Promise<Landed> {
  const cmd = desktopCommand();
  if (cmd && (await attached(c))) {
    try {
      Bun.spawn([...cmd, "--url", c.base, `keel://session/${sessionId}`], { stdio: ["ignore", "ignore", "ignore"] }).unref();
      return "app";
    } catch { /* the browser takes it */ }
  }
  return openUrl(c.url(sessionId)) ? "browser" : false;
}
