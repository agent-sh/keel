// A session of Keel's goes on in Claude Code or Codex with one press: its history is written in that harness's
// own transcript format under the harness's own folder (src/integrations/export.ts), a terminal opens on this
// machine with the harness's resume command in the session's folder (src/integrations/terminal-open.ts), and the
// session here is archived with where it went (`settings.moved`), still readable. A copy of a Claude Code or
// Codex session whose original is still there can resume that original instead: nothing is written, and the
// turns taken here stay here. When the harness writes to it, the session shows in the list as one of the
// harness's (src/integrations/outside/), saying it came from here; a moved copy no longer hides its original.
//
// GET  /api/sessions/:id/continue  -> { original?: { harness, source_id, kept_here }, terminal, moved? }
// POST /api/sessions/:id/continue  -> { harness: "claude" | "codex", original?: true } moves it;
//                                     { again: true } opens a terminal on where it went again
// GET  /api/terminal               -> the terminal a move opens now, and whether tmux keeps it (for the settings)
import { statSync } from "node:fs";
import { join } from "node:path";
import type { RouteModule } from "../app.ts";
import type { Moved, Session } from "../../core/types.ts";
import { lineage } from "../../core/tree.ts";
import { exportTo, resumeLine, resumeOf, SAFE_ID } from "../../integrations/export.ts";
import { sharedImports } from "../../integrations/import/service.ts";
import { sourceMachine } from "../../integrations/import/types.ts";
import { openTerminal, terminalFound } from "../../integrations/terminal-open.ts";
import { jobLive, jobsOf } from "../../tools/jobs.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
export const HARNESS_LABEL = { claude: "Claude Code", codex: "Codex" } as const;

// The Keel session that moved to a session of another harness (the one it became there), if any.
export function movedFrom(db: { query: (sql: string) => { get: (...a: string[]) => unknown } }, harness: string, targetId: string): { id: string; title: string } | undefined {
  return (db.query("SELECT id, title FROM sessions WHERE json_extract(settings, '$.moved.target_id') = ? AND json_extract(settings, '$.moved.harness') = ? AND outside IS NULL LIMIT 1").get(targetId, harness) as { id: string; title: string } | null) ?? undefined;
}

export const continueRoutes: RouteModule = (deps) => {
  const { store, bus, engine } = deps;
  const imports = sharedImports(store);
  // The original a copy was made from, when it is a Claude Code or Codex session still on this machine's disk.
  const originalOf = (s: Session) => {
    const l = imports.link(s.id);
    if (!l || (l.harness !== "claude" && l.harness !== "codex") || sourceMachine(l.source_path)) return undefined;
    try { statSync(l.source_path); } catch { return undefined; }
    // The turns taken here since the copy: the original does not have them.
    const kept = (store.db.query("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind = 'turn_start'").get(s.id) as { n: number }).n;
    return { harness: l.harness as "claude" | "codex", source_id: l.source_id, path: l.source_path, kept_here: kept };
  };
  const refusal = (s: Session | null | undefined) => {
    if (!s) return bad("no such session", 404);
    if (s.machine) return bad("its tools run on another machine: move it from that machine's Keel", 409);
    if (s.parent_id) return bad("an agent's session goes on with its parent", 409);
    if (s.outside) return bad("it is a session of another harness already: answer it there, or fork it into Keel first", 409);
    return undefined;
  };
  const open = async (s: Session, m: Moved): Promise<Moved> => {
    const r = await openTerminal({ cwd: m.cwd, line: m.shell_command, name: `${m.harness}-${m.target_id.slice(0, 8)}`, log: join(store.stateDir, "terminals", `${s.id}.log`) });
    const { how: _h, why: _w, ...rest } = m;
    return r.opened ? { ...rest, opened: true, how: r.how } : { ...rest, opened: false, why: r.why };
  };
  return {
    "/api/terminal": { GET: () => json(terminalFound()) },
    "/api/sessions/:id/continue": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        const no = refusal(s);
        if (no) return no;
        const original = originalOf(s!);
        return json({ ...(original ? { original: { harness: original.harness, source_id: original.source_id, kept_here: original.kept_here } } : {}), terminal: terminalFound(), ...(s!.settings.moved ? { moved: s!.settings.moved } : {}) });
      },
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        const no = refusal(s);
        if (no) return no;
        const b = ((await req.json().catch(() => ({}))) ?? {}) as { harness?: unknown; original?: unknown; again?: unknown };
        if (b.again === true) {
          if (!s!.settings.moved) return bad("it has not moved: nothing to open again", 409);
          const moved = await open(s!, s!.settings.moved);
          const next = store.updateSession(s!.id, { settings: { ...s!.settings, moved } });
          bus.emit({ t: "session", session: next });
          return json({ moved, session: next });
        }
        if (b.harness !== "claude" && b.harness !== "codex") return bad("harness is claude or codex");
        if (engine.isRunning(s!.id)) return bad("a turn is running: move it when the turn ends", 409);
        const jobs = jobsOf(s!.id).filter(jobLive);
        if (jobs.length) return bad(`it still runs ${jobs.length} background command${jobs.length > 1 ? "s" : ""}: stop ${jobs.length > 1 ? "them" : "it"} first`, 409);
        // What it becomes there, from its history as it is once nothing runs in it.
        const target = (): Moved | Response => {
          const cur = store.session(s!.id)!;
          if (b.original === true) {
            const o = originalOf(cur);
            if (!o || o.harness !== b.harness) return bad(`it is not a copy of a ${HARNESS_LABEL[b.harness as "claude" | "codex"]} session that is still there`, 409);
            // The id is read from the transcript: it goes on a command line only as an id a harness makes.
            if (!SAFE_ID.test(o.source_id)) return bad(`the original's id in its transcript is not one ${HARNESS_LABEL[o.harness]} makes: resume it there by hand`, 409);
            const resume = resumeOf(o.harness, o.source_id);
            return { harness: o.harness, target_id: o.source_id, path: o.path, cwd: cur.workspace, resume, shell_command: resumeLine(cur.workspace, resume), at: Date.now(), original: true, opened: false,
              ...(o.kept_here ? { notes: [`${o.kept_here} turn${o.kept_here === 1 ? "" : "s"} taken in Keel stay${o.kept_here === 1 ? "s" : ""} in Keel: the original does not have ${o.kept_here === 1 ? "it" : "them"}.`] } : {}) };
          }
          const evs = lineage(store.events(cur.id), cur.head);
          if (!evs.some((e) => e.kind === "user")) return bad("the session has no conversation yet", 409);
          const w = exportTo(b.harness === "claude" ? "claude_code" : "codex", cur, evs);
          return { harness: b.harness as "claude" | "codex", target_id: w.target_id, path: w.path, cwd: w.cwd, resume: w.resume_command, shell_command: w.shell_command, at: w.exported_ms, opened: false, ...(w.notes.length ? { notes: w.notes } : {}) };
        };
        // Archived as the archive route does (src/server/app.ts): the session is stopped, and while it is closing
        // nothing that comes due starts a turn in it; its history is written there and it is archived in that step,
        // so no turn runs on in an archived session or misses the transcript.
        await engine.interrupt(s!.id, "archive");
        const made = await engine.whileClosing([s!.id], async () => {
          while (engine.isRunning(s!.id)) await engine.interrupt(s!.id, "archive");
          const m = target();
          if (m instanceof Response) return m;
          store.updateSession(s!.id, { archived: true, settings: { ...store.session(s!.id)!.settings, moved: m } });
          return m;
        });
        if (made instanceof Response) return made;
        // The terminal opens once it is archived with where it went: the list shows the session it became there,
        // this one stays readable.
        const moved = await open(s!, made);
        const next = store.updateSession(s!.id, { settings: { ...store.session(s!.id)!.settings, moved } });
        bus.emit({ t: "session", session: next });
        return json({ moved, session: next });
      },
    },
  };
};
