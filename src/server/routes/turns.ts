// Turn control and the session tree: queue, resume, compaction, context, head
// (branch switch), fork.
import { capsuleReportOf } from "../../automation/agents.ts";
import { ownersMeta } from "../../core/owner.ts";
import { leafOf, lineage } from "../../core/tree.ts";
import { bytesPerToken, checkpointAt, contextTokens, summaryMessage, utf8Bytes } from "../../engine/compact.ts";
import { resolveAttachments } from "../../engine/attachments.ts";
import { ORIGINS, originClass, saving, sizeParts, type Origin } from "../../engine/context-parts.ts";
import { RetryTooLong } from "../../engine/retry.ts";
import { toMessages } from "../../engine/turn.ts";
import { ProviderError } from "../../providers/http.ts";
import type { RouteModule } from "../app.ts";
import { Worktrees } from "../../worktree/manager.ts";
import { join } from "node:path";
import { newInstructions } from "./places.ts";
import { resolveSwitchModel, switchCompactionBlock } from "../switch.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

export const turnRoutes: RouteModule = (deps) => {
  const { store, engine, providers, bus, errors } = deps;
  const queueBody = (id: string) => ({ queue: engine.queued(id), held: engine.isHeld(id) });
  const sessionOr404 = (id: string) => store.session(id);
  const wts = new Worktrees(store, join(store.stateDir, "worktrees"));

  return {
    "/api/sessions/:id/queue": {
      GET: (req: any) => (sessionOr404(req.params.id) ? json(queueBody(req.params.id)) : bad("no such session", 404)),
      DELETE: (req: any) => {
        if (!sessionOr404(req.params.id)) return bad("no such session", 404);
        // A prompt Send now has taken is no longer in the queue to clear.
        // What another session sent is told to it as not delivered (drop).
        const rows = engine.queued(req.params.id);
        for (const q of rows) if (ownersMeta(q.meta)) store.dequeue(q.id);
        engine.drop(rows, "removed");
        engine.emitQueue(req.params.id);
        return json(queueBody(req.params.id));
      },
    },
    // The queued prompts written on a branch the session no longer shows, for a
    // page that holds too little of the session to tell.
    "/api/sessions/:id/queue/off-branch": {
      GET: (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        return json({ off: engine.queued(s.id).filter((q) => engine.offBranch(q)).map((q) => q.id) });
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
          const others = engine.queued(q.session_id).filter((x) => x.id !== q.id && x.steer === (b.steer ?? q.steer));
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
        if (!q || q.session_id !== req.params.id) return bad("no such queued prompt (it may have been sent)", 404);
        // A row another session sent: its sender is told it was removed unread.
        if (!ownersMeta(q.meta)) engine.drop([q], "removed");
        else if (!store.dequeue(q.id)) return bad("no such queued prompt (it may have been sent)", 404);
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
      // Calls off a turn that would continue by itself when a provider's wait is over.
      DELETE: (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        return json({ ok: true, cancelled: engine.cancelContinue(s.id) });
      },
    },

    // The model declined the session's last turn: the owner starts it again from a capsule of its records (no model
    // call, the declined reply left out) and the turn goes on from it.
    "/api/sessions/:id/fresh-start": {
      POST: async (req: any) => {
        const s = sessionOr404(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived || engine.isRunning(s.id)) return bad(s.archived ? "the session is archived" : "a turn is running", 409);
        try {
          const ev = await engine.freshStart(s.id, capsuleReportOf(engine.lineage(s.id)));
          engine.resume(s.id);
          return json({ ok: true, event_id: ev.id });
        } catch (e: any) {
          if (typeof e?.status === "number") return bad(e.message, e.status);
          throw e;
        }
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
        const per = bytesPerToken(s.model);
        // What the request carries beside the conversation, and who wrote the conversation's words.
        const carried = await engine.requestParts(s.id, messages).catch(() => ({ system: [], tools: [], native: false }));
        const byOrigin = new Map<Origin, number>();
        for (let i = Math.max(0, cp.keepFrom); i < events.length; i++) {
          const e = events[i]!;
          const texts = e.kind === "assistant" ? e.data.blocks.filter((b: any) => b.type === "text") : e.kind === "user" || (e.kind === "note" && e.data.model) ? [...(e.data.images ?? []), ...(e.data.text ? [{ type: "text", text: e.data.text }] : [])] : [];
          const who: Origin = e.kind === "assistant" ? "model" : e.kind === "user" ? originClass(e.data) : "harness";
          for (const b of texts) byOrigin.set(who, (byOrigin.get(who) ?? 0) + utf8Bytes(JSON.stringify(b)));
        }
        const split = [...byOrigin.values()].reduce((a, b) => a + b, 0);
        const chat = zones.conversation!;
        const rows: { section: "system" | "tools" | "messages"; key: string; label: string; bytes: number; zone?: string }[] = [
          ...carried.system.map((b) => ({ section: "system" as const, key: b.name, label: b.name, bytes: b.bytes })),
          ...carried.tools.map((g) => ({ section: "tools" as const, key: g.key, label: g.label, bytes: g.bytes })),
          ...ORIGINS.map((o) => ({ section: "messages" as const, key: o.key, label: o.label, zone: "conversation", bytes: split ? Math.round((chat * (byOrigin.get(o.key) ?? 0)) / split) : o.key === "owner" ? chat : 0 })),
          ...([["thinking", "Thinking"], ["tool_calls", "Tool calls"], ["tool_results", "Tool results"], ["summary", "Summary"]] as const).map(([k, label]) => ({ section: "messages" as const, key: k, label, zone: k, bytes: zones[k]! })),
        ];
        // The provider's own count when a reply measured one: the parts are scaled to add up to it.
        const sized = sizeParts(rows.map((r) => r.bytes), per, t.measured > 0 ? t.used : 0);
        const tokens = (section: string) => rows.reduce((n, r, i) => n + (r.section === section ? sized[i]! : 0), 0);
        const parts = {
          measured: t.measured > 0,
          total_tokens: sized.reduce((a, b) => a + b, 0),
          native_tools: carried.native,
          system: { tokens: tokens("system"), blocks: rows.flatMap((r, i) => (r.section === "system" ? [{ key: r.key, label: r.label, tokens: sized[i]! }] : [])) },
          tools: {
            tokens: tokens("tools"),
            groups: carried.tools.map((g) => { const i = rows.findIndex((r) => r.section === "tools" && r.key === g.key); return { key: g.key, label: g.label, kind: g.kind, tools: g.tools, carried: g.carried, tokens: sized[i]!, save: saving(g, carried.native) }; }),
          },
          messages: { tokens: tokens("messages"), rows: rows.flatMap((r, i) => (r.section === "messages" && r.bytes ? [{ key: r.key, label: r.label, tokens: sized[i]! }] : [])) },
        };
        const zoneTokens = (k: string) => rows.reduce((n, r, i) => n + (r.section === "messages" && r.zone === k ? sized[i]! : 0), 0);
        return json({
          context_window: window,
          // The model's learned bytes a token: the page counts a context no reply has measured with it, as the daemon does.
          bytes_per_token: bytesPerToken(s.model),
          // The listing gave no window: the number is the fallback compaction uses, not the model's.
          context_window_known: !!info && !info.context_assumed,
          context_used_tokens: t.used,
          measured_tokens: t.measured,
          estimated_tokens: t.estimated,
          last_usage: t.last ?? null,
          compacts_at_tokens: engine.limitOf(s, window),
          zones: Object.entries(zones).map(([key, bytes]) => ({ key, bytes, estimated_tokens: Math.round(bytes / per), tokens: zoneTokens(key) })),
          parts,
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
        const next = b.for_model ? await resolveSwitchModel(providers, b.for_model) : undefined;
        if (next) {
          const blocked = switchCompactionBlock(providers, s.model);
          if (blocked) return bad(`Cannot compact before switching: ${blocked}`, 409);
        }
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
        const { pinned_ms: _p, done_ms: _d, repairs: _r, ...settings } = s.settings; // (its repairs are recorded as its own)
        const f = store.createSession({ title, model: s.model, workspace: s.workspace, settings });
        // `worktree` ({ name?, base? } or true): the fork works in a worktree of its own, as a clone does, so two
        // forks of one task never write the same folder.
        if (b.worktree) {
          const o = typeof b.worktree === "object" ? b.worktree : {};
          try {
            const { wt, cwd } = await wts.create(f.id, s.workspace, o.name || title, o.base);
            wts.adopt(f.id, wt);
            store.updateSession(f.id, { workspace: cwd });
          } catch (e) {
            store.deleteSession(f.id);
            throw e;
          }
        }
        store.copyEvents(f.id, copy);
        // Queued prompts are the source's work, not history: they stay there, and the fork says so.
        const left = engine.queued(s.id).length;
        store.append(f.id, "note", { kind: "fork", from_session: s.id, from_title: s.title, queue_left: left || undefined, text: `Forked from ${s.title || "a session"}.${left ? ` ${left === 1 ? "One queued message stays" : `${left} queued messages stay`} there.` : ""}` });
        if (b.worktree) {
          const now = store.session(f.id)!;
          const inst = newInstructions(now.workspace, s.workspace);
          bus.emit({ t: "event", event: store.append(f.id, "note", { kind: "folder", model: true, short: `Forked into ${now.workspace}`, text: `[harness] This session was forked into ${now.workspace} (the conversation so far ran in ${s.workspace}). Work there now.${inst ? `\n\nInstructions from the owner's files there:\n\n${inst}` : ""}` }) });
        }
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
