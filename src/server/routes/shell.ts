// The desktop shell's door (desktop/, and the registry in src/server/shell.ts).
// Every route is for the desk only: a page or a program on this machine. A
// remote browser, a tunnel or the phone gets 403, so nothing off the machine
// can open a link on the desktop or take the notifications.
//
// GET  /api/shell          -> { attached, shells: [{ engine, version, since, acks }], running: [title] }
//      `running`: the top-level sessions with a turn at work, by title (what
//      the app names before it stops the daemon).
// GET  /api/shell/events   the shell's stream (server-sent events). The shell
//      is attached while it is open. ?engine= and ?version= name it; ?acks=1
//      says it shows notifications and posts each one's number back. Only
//      such a shell is handed alerts (src/server/shell.ts).
//        hello    { pid, started_ms, needs, snooze_until, stream }   stream: a word of this stream alone
//        needs    { n }                  what waits on the owner, counted as the page's title counts it
//        notify   { key, alert, title, body, urgency, kind, ack }   show this (one per key, the next replaces it)
//        withdraw { key }                take the key's notification down
//        snooze   { until_ms | null }    alerts are held until then
// POST /api/shell/ack      { ack, stream }  the notification numbered `ack`, handed to that stream, is on screen
// POST /api/shell/click    { alert }        -> { path }   where the alert's click leads, read now
import { alertPath } from "../../automation/alerts.ts";
import * as snooze from "../../automation/snooze.ts";
import { isLocal } from "../../safety/presence.ts";
import type { Frame } from "../../core/types.ts";
import type { RouteModule } from "../app.ts";
import { ackShell, attachShell, shellAttached, shellList, tellShells } from "../shell.ts";
import { board } from "./state.ts";

const json = (v: unknown, status = 200) => Response.json(v, { status });
const deskOnly = (req: Request) => (isLocal(req) ? undefined : json({ error: "the desktop shell's routes are for this machine only" }, 403));

export const shellRoutes: RouteModule = (deps) => {
  // What waits on the owner, per top-level session, kept from the state frames while a shell is attached.
  const needs = new Map<string, number>();
  let told = -1;
  const count = () => [...needs.values()].reduce((a, b) => a + b, 0);
  const topLevel = (id: string) => { const s = deps.store.session(id); return !!s && !s.parent_id; };
  const fill = () => {
    needs.clear();
    for (const [id, st] of Object.entries(board?.all() ?? {})) if (st.watch === "need" && topLevel(id)) needs.set(id, st.asks ?? 1);
  };
  // The top-level sessions a stop of the daemon would cut: their own turn, or an agent of theirs, at work.
  const running = () => {
    const titles = new Map<string, string>();
    for (const id of Object.keys(board?.all() ?? {})) {
      if (!deps.engine.isRunning(id)) continue;
      let s = deps.store.session(id);
      for (let hops = 0; s?.parent_id && hops < 8; hops++) s = deps.store.session(s.parent_id);
      if (s) titles.set(s.id, s.title || "Untitled session");
    }
    return [...titles.values()];
  };
  const tellNeeds = () => { const n = count(); if (n !== told) { told = n; tellShells("needs", { n }); } };

  const g = globalThis as { __keelShellOff?: () => void };
  g.__keelShellOff?.();
  g.__keelShellOff = deps.bus.on((f: Frame) => {
    if (f.t !== "feature" || !shellAttached()) return;
    if (f.name === "state" && f.session_id) {
      const st = f.data as { watch?: string; asks?: number } | null;
      if (st?.watch === "need" && topLevel(f.session_id)) needs.set(f.session_id, st.asks ?? 1);
      else needs.delete(f.session_id);
      tellNeeds();
    } else if (f.name === "automation" && f.data?.kind === "snooze" && f.data.data?.session_id === snooze.GLOBAL_ID) {
      tellShells("snooze", { until_ms: f.data.data.snooze?.until_ms ?? null });
    }
  });

  return {
    "/api/shell": { GET: (req: Request) => deskOnly(req) ?? json({ attached: shellAttached(), shells: shellList(), running: running() }) },
    "/api/shell/events": {
      GET: (req: Request) => {
        const no = deskOnly(req);
        if (no) return no;
        const q = new URL(req.url).searchParams;
        const enc = new TextEncoder();
        let detach = () => {};
        let ping: Timer | undefined;
        const stop = () => { detach(); clearInterval(ping); };
        const stream = new ReadableStream({
          start(c) {
            const put = (event: string, data: unknown) => {
              try { c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); return true; } catch { stop(); return false; }
            };
            fill();
            told = count();
            const word = crypto.randomUUID();
            put("hello", { pid: process.pid, started_ms: Math.round(Date.now() - process.uptime() * 1000), needs: told, snooze_until: snooze.global()?.until_ms ?? null, stream: word });
            detach = attachShell({ engine: (q.get("engine") ?? "").slice(0, 40), version: (q.get("version") ?? "").slice(0, 40), acks: q.get("acks") === "1" }, put, () => { clearInterval(ping); try { c.close(); } catch {} }, word);
            // Under the server's idle timeout, and how a shell that died is noticed.
            ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch { stop(); } }, 5000);
            req.signal.addEventListener("abort", () => { stop(); try { c.close(); } catch {} }, { once: true });
          },
          cancel: stop,
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      },
    },
    "/api/shell/ack": {
      POST: async (req: Request) => {
        const b = await req.json().catch(() => ({}));
        return deskOnly(req) ?? (Number.isSafeInteger(b.ack) && typeof b.stream === "string" ? json({ ok: ackShell(b.ack, b.stream) }) : json({ error: "ack is the number a notify event carried, stream the word of the stream it came on" }, 400));
      },
    },
    "/api/shell/click": {
      POST: async (req: Request) => {
        const b = await req.json().catch(() => ({}));
        return deskOnly(req) ?? (typeof b.alert === "string" ? json({ path: alertPath(b.alert) }) : json({ error: "alert is an alert's id" }, 400));
      },
    },
  };
};
