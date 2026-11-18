// Turn control and the session tree: queue, resume, compaction, context, head
// (branch switch), fork.
import { leafOf, lineage } from "../../core/tree.ts";
import { contextTokens, COMPACT_SHARE } from "../../engine/compact.ts";
import { toMessages } from "../../engine/turn.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export const turnRoutes: RouteModule = (deps) => {
  const { store, engine, providers, bus } = deps;
  const queueBody = (id: string) => ({ queue: store.queue(id), held: engine.isHeld(id) });
  const sessionOr404 = (id: string) => store.session(id);

  return {
    "/api/sessions/:id/queue": {
      GET: (req: any) => (sessionOr404(req.params.id) ? json(queueBody(req.params.id)) : bad("no such session", 404)),
      DELETE: (req: any) => {
        if (!sessionOr404(req.params.id)) return bad("no such session", 404);
        for (const q of store.queue(req.params.id)) store.dequeue(q.id);
        engine.emitQueue(req.params.id);
        return json(queueBody(req.params.id));
      },
    },
    "/api/sessions/:id/queue/resume": {
      POST: (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        engine.resumeQueue(s.id);
        return json(queueBody(s.id));
      },
    },
    "/api/sessions/:id/queue/:qid": {
      PATCH: async (req: any) => {
        const q = store.queueItem(req.params.qid);
        if (!q || q.session_id !== req.params.id) return bad("no such queued prompt", 404);
        const b = (await req.json()) as any;
        if (b.text === undefined && b.steer === undefined && b.position === undefined) return bad("nothing to change");
        if (b.text !== undefined && !String(b.text).trim()) return bad("text cannot be empty");
        let pos: number | undefined;
        if (b.position !== undefined) {
          const others = store.queue(q.session_id).filter((x) => x.id !== q.id && x.steer === (b.steer ?? q.steer));
          const i = Math.max(0, Math.min(Number(b.position) || 0, others.length));
          const before = others[i - 1]?.pos ?? (others[0] ? others[0].pos - 2 : 0);
          const after = others[i]?.pos ?? before + 2;
          pos = (before + after) / 2;
        }
        store.updateQueueItem(q.id, { text: b.text?.trim(), steer: b.steer, pos });
        engine.emitQueue(q.session_id);
        return json(queueBody(q.session_id));
      },
      DELETE: (req: any) => {
        const q = store.queueItem(req.params.qid);
        if (!q || q.session_id !== req.params.id) return bad("no such queued prompt", 404);
        store.dequeue(q.id);
        engine.emitQueue(q.session_id);
        return json(queueBody(q.session_id));
      },
    },
    "/api/sessions/:id/queue/:qid/send": {
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        await engine.sendNow(s.id, req.params.qid);
        return json({ ok: true });
      },
    },
    "/api/sessions/:id/resume": {
      POST: (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived || engine.isRunning(s.id)) return bad(s.archived ? "the session is archived" : "a turn is running", 409);
        const last = [...engine.lineage(s.id)].reverse().find((e) => e.kind === "turn_end");
        if (!last || !["interrupted", "error", "max_tokens", "refusal", "restart"].includes(last.data.reason)) return bad("the last turn finished", 409);
        engine.resume(s.id);
        return json({ ok: true });
      },
    },

    // What the context holds and how close it is to the model's window.
    "/api/sessions/:id/context": {
      GET: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        const info = (await providers.models()).find((m) => m.id === s.model);
        const events = engine.lineage(s.id);
        const t = contextTokens(events);
        const zones: Record<string, number> = { conversation: 0, thinking: 0, tool_calls: 0, tool_results: 0, summary: 0 };
        for (const m of toMessages(events)) {
          for (const b of m.content as any[]) {
            const n = JSON.stringify(b).length;
            if (b.type === "tool_result") zones.tool_results! += n;
            else if (b.type === "tool_use") zones.tool_calls! += n;
            else if (b.type === "thinking" || b.type === "redacted_thinking") zones.thinking! += n;
            else if (b.type === "text" && b.text.startsWith("[harness] This conversation was compacted")) zones.summary! += n;
            else zones.conversation! += n;
          }
        }
        const window = info?.context ?? 0;
        return json({
          context_window: window,
          context_used_tokens: t.used,
          measured_tokens: t.measured,
          estimated_tokens: t.estimated,
          last_usage: t.last ?? null,
          compacts_at_tokens: s.settings.compact_at ?? Math.floor(window * COMPACT_SHARE),
          zones: Object.entries(zones).map(([key, bytes]) => ({ key, bytes, estimated_tokens: Math.round(bytes / 4) })),
          usage_total: s.usage,
        });
      },
    },
    "/api/sessions/:id/compact": {
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (engine.isRunning(s.id)) return bad("a turn is running", 409);
        const b = (await req.json().catch(() => ({}))) as any;
        const ev = await engine.compactNow(s.id, { focus: b.focus ? String(b.focus).slice(0, 2000) : undefined });
        return json({ ok: true, event: ev });
      },
    },
    "/api/sessions/:id/clear": {
      POST: (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (engine.isRunning(s.id)) return bad("a turn is running", 409);
        const ev = engine.clear(s.id);
        return json({ checkpoint_event_id: ev.id, undo_head_event_id: ev.data.undo_head });
      },
    },

    // Show another branch: the newest event below the given one becomes the head.
    "/api/sessions/:id/head": {
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (engine.isRunning(s.id)) return bad("a turn is running", 409);
        const b = (await req.json()) as any;
        const all = store.events(s.id);
        if (!all.some((e) => e.id === b.head_event_id)) return bad("not an event of this session");
        // `reveal`: only switch when the event is not on the branch shown now.
        if (b.reveal && lineage(all, s.head).some((e) => e.id === b.head_event_id)) return json({ ok: true, head: s.head });
        const head = b.leaf === false ? b.head_event_id : leafOf(all, b.head_event_id);
        const next = store.updateSession(s.id, { head });
        bus.emit({ t: "session", session: next });
        return json({ ok: true, head });
      },
    },

    // A new session from a copy of this one's branch up to an event (with
    // `before`: up to the event before it; its prompt text goes to the composer).
    "/api/sessions/:id/fork": {
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = (await req.json()) as any;
        const all = store.events(s.id);
        const at = all.find((e) => e.id === b.event_id);
        if (!at) return bad("not an event of this session");
        const line = lineage(all, at.id);
        const copy = b.before ? line.slice(0, -1) : line;
        // A fork ends after a whole step: drop a trailing turn marker left open.
        const titles = new Set(store.sessions().concat(store.sessions({ archived: true })).map((x) => x.title));
        const base = `${s.title || "Session"} (fork`;
        let title = `${base})`;
        for (let n = 2; titles.has(title); n++) title = `${base} ${n})`;
        const f = store.createSession({ title, model: s.model, workspace: s.workspace, settings: s.settings });
        store.copyEvents(f.id, copy.filter((e) => e.kind !== "turn_start" || copy.at(-1) !== e));
        const session = store.session(f.id)!;
        bus.emit({ t: "session", session });
        return json({ session, prompt_text: b.before && at.kind === "user" ? at.data.text : undefined, events_copied: copy.length }, 201);
      },
    },

  };
};
