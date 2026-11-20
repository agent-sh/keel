// Turn control and the session tree: queue, resume, compaction, context, head
// (branch switch), fork.
import { leafOf, lineage } from "../../core/tree.ts";
import { bytesPerToken, checkpointAt, contextTokens, COMPACT_SHARE, summaryMessage, utf8Bytes } from "../../engine/compact.ts";
import { resolveAttachments } from "../../engine/attachments.ts";
import { RetryTooLong } from "../../engine/retry.ts";
import { toMessages } from "../../engine/turn.ts";
import { ProviderError } from "../../providers/http.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export const turnRoutes: RouteModule = (deps) => {
  const { store, engine, providers, bus, errors } = deps;
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
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        engine.resumeQueue(s.id, !!b.here);
        return json(queueBody(s.id));
      },
    },
    "/api/sessions/:id/queue/:qid": {
      PATCH: async (req: any) => {
        // The body first: from here on nothing awaits, so the row found is the row changed.
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        const q = store.queueItem(req.params.qid);
        if (engine.isSending(req.params.qid)) return bad("this queued prompt is already sending", 409);
        if (!q || q.session_id !== req.params.id) return bad("no such queued prompt (it may have been sent)", 404);
        if (b.text === undefined && b.steer === undefined && b.position === undefined) return bad("nothing to change");
        let text = b.text === undefined ? undefined : String(b.text).trim();
        // A screenshot or file alone is a prompt, without made-up words.
        if (text === "" && !q.images?.length) return bad("text cannot be empty");
        let pos: number | undefined;
        if (b.position !== undefined) {
          const others = store.queue(q.session_id).filter((x) => x.id !== q.id && x.steer === (b.steer ?? q.steer));
          const i = Math.max(0, Math.min(Number(b.position) || 0, others.length));
          const before = others[i - 1]?.pos ?? (others[0] ? others[0].pos - 2 : 0);
          const after = others[i]?.pos ?? before + 2;
          pos = (before + after) / 2;
        }
        if (!store.updateQueueItem(q.id, { text, steer: b.steer, pos })) return bad("no such queued prompt (it may have been sent)", 404);
        engine.emitQueue(q.session_id);
        return json(queueBody(q.session_id));
      },
      DELETE: (req: any) => {
        if (engine.isSending(req.params.qid)) return bad("this queued prompt is already sending", 409);
        const q = store.queueItem(req.params.qid);
        if (!q || q.session_id !== req.params.id || !store.dequeue(q.id)) return bad("no such queued prompt (it may have been sent)", 404);
        engine.emitQueue(q.session_id);
        return json(queueBody(q.session_id));
      },
    },
    "/api/sessions/:id/queue/:qid/send": {
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        await engine.sendNow(s.id, req.params.qid, !!b.here);
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
        const t = contextTokens(events, s.model);
        const zones: Record<string, number> = { conversation: 0, thinking: 0, tool_calls: 0, tool_results: 0, summary: 0 };
        // The summary is the blocks the checkpoint event produced (they lead the
        // first message), not any text that reads like one.
        const cp = checkpointAt(events);
        const summary = new Map<string, number>();
        if (cp.at >= 0 && events[cp.at]!.data.mode === "summary") {
          for (const b of summaryMessage(events[cp.at]!.data).content) { const k = JSON.stringify(b); summary.set(k, (summary.get(k) ?? 0) + 1); }
        }
        // Sized as the request carries them: attached files resolved for this model, in UTF-8 bytes.
        const messages = resolveAttachments(toMessages(events), { pdf: info?.pdf, name: info?.name ?? s.model });
        messages.forEach((m, i) => {
          for (const b of m.content as any[]) {
            const k = JSON.stringify(b);
            const n = utf8Bytes(k);
            if (i === 0 && summary.get(k)) { summary.set(k, summary.get(k)! - 1); zones.summary! += n; }
            else if (b.type === "tool_result") zones.tool_results! += n;
            else if (b.type === "tool_use") zones.tool_calls! += n;
            else if (b.type === "thinking" || b.type === "redacted_thinking") zones.thinking! += n;
            else zones.conversation! += n;
          }
        });
        const window = info?.context ?? 0;
        return json({
          context_window: window,
          // The listing gave no window: the number is the fallback compaction uses, not the model's.
          context_window_known: !!info && !info.context_assumed,
          context_used_tokens: t.used,
          measured_tokens: t.measured,
          estimated_tokens: t.estimated,
          last_usage: t.last ?? null,
          compacts_at_tokens: s.settings.compact_at ?? Math.floor(window * COMPACT_SHARE),
          zones: Object.entries(zones).map(([key, bytes]) => ({ key, bytes, estimated_tokens: Math.round(bytes / bytesPerToken(s.model)) })),
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
        // `for_model`: the model the session moves to next; the owner's words kept verbatim fit its window too.
        const next = b.for_model ? (await providers.models()).find((m) => m.id === b.for_model) : undefined;
        if (b.for_model && !next) return bad(`model ${b.for_model} is not listed`);
        try {
          const ev = await engine.compactNow(s.id, { focus: b.focus ? String(b.focus).slice(0, 2000) : undefined, next });
          return json({ ok: true, event: ev });
        } catch (e) {
          // A provider's 4xx is a failed summary, not a refusal by this route.
          if (!(e instanceof ProviderError || e instanceof RetryTooLong)) throw e;
          const rec = errors.capture("provider", e, { session: s.id, at: "manual compaction" });
          return json({ error: rec.message, error_id: rec.id }, 502);
        }
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
        const b = (await req.json()) as any;
        const all = store.events(s.id);
        if (!all.some((e) => e.id === b.head_event_id)) return bad("not an event of this session");
        // `reveal`: only switch when the event is not on the branch shown now (also while a turn runs).
        if (b.reveal && lineage(all, s.head).some((e) => e.id === b.head_event_id)) return json({ ok: true, head: s.head });
        if (engine.isRunning(s.id)) return bad("a turn is running", 409);
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
        const cut = b.before ? line.slice(0, -1) : line;
        // A fork ends after a whole step: drop a trailing turn marker left open.
        const copy = cut.filter((e) => e.kind !== "turn_start" || cut.at(-1) !== e);
        // A name given at the fork (`/fork Docs`) is its title; else "<source> (fork n)".
        const named = typeof b.title === "string" ? b.title.trim().slice(0, 200) : "";
        let title = named;
        if (!title) {
          const titles = new Set(store.sessions().concat(store.sessions({ archived: true })).map((x) => x.title));
          const base = `${s.title || "Session"} (fork`;
          title = `${base})`;
          for (let n = 2; titles.has(title); n++) title = `${base} ${n})`;
        }
        // The copy keeps the settings, not the source's pin or done mark.
        const { pinned_ms: _p, done_ms: _d, ...settings } = s.settings;
        const f = store.createSession({ title, model: s.model, workspace: s.workspace, settings });
        store.copyEvents(f.id, copy);
        // Queued prompts are the source's work, not history: they stay there, and the fork says so.
        const left = store.queue(s.id).length;
        store.append(f.id, "note", { kind: "fork", from_session: s.id, from_title: s.title, queue_left: left || undefined, text: `Forked from ${s.title || "a session"}.${left ? ` ${left === 1 ? "One queued message stays" : `${left} queued messages stay`} there.` : ""}` });
        const session = store.session(f.id)!;
        bus.emit({ t: "session", session });
        // `before`: the prompt itself is not copied; its words and attachments go back to the box.
        const prompt = b.before && at.kind === "user" ? at : undefined;
        const text = prompt ? String(prompt.data.text ?? "") : undefined;
        return json({ session, prompt_text: text, prompt_images: prompt?.data.images?.length ? prompt.data.images : undefined, events_copied: copy.length, queue_left: left }, 201);
      },
    },

  };
};
