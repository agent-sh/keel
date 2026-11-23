// Reviews: an independent reviewer (a read-only child session on the model
// the owner picks) over the session's uncommitted work, its branch or one
// commit; findings the owner sends back to the working model or dismisses.
import { registerHooks } from "../../engine/hooks.ts";
import { fixPrompt, parseAnswer, reviewKey, reviewTask, SCHEMA, type Review, type ReviewKind, type Scope } from "../../safety/review.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import { GitError, Worktrees } from "../../worktree/manager.ts";
import type { Deps, RouteModule } from "../app.ts";
import { join } from "node:path";
import { gate } from "./permissions.ts";
import * as agents from "../../automation/agents.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const SCOPES: Scope[] = ["uncommitted", "branch", "commit"];

export const reviewRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, engine, providers, errors } = deps;
  store.migrate(SCHEMA);
  store.migrate("CREATE TABLE IF NOT EXISTS review_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const wts = new Worktrees(store, join(store.stateDir, "worktrees"));

  const all = (sessionId: string): Review[] =>
    store.db.query<{ data: string }, [string]>("SELECT data FROM reviews WHERE session_id = ? ORDER BY created").all(sessionId).map((r) => JSON.parse(r.data));
  const get = (id: string): Review | undefined => {
    const r = store.db.query<{ data: string }, [string]>("SELECT data FROM reviews WHERE id = ?").get(id);
    return r ? JSON.parse(r.data) : undefined;
  };
  const byChild = (childId: string): Review | undefined => {
    const r = store.db.query<{ data: string }, [string]>("SELECT data FROM reviews WHERE child_id = ? AND state = 'running'").get(childId);
    return r ? JSON.parse(r.data) : undefined;
  };
  const save = (r: Review) => {
    store.db.query("INSERT INTO reviews (id, session_id, child_id, state, diff_sha, data, created) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, child_id = excluded.child_id, data = excluded.data")
      .run(r.id, r.session_id, r.child_id, r.state, r.diff_sha256, JSON.stringify(r), r.created);
    bus.emit({ t: "feature", name: "reviews", session_id: r.session_id, data: r });
    return r;
  };
  const setting = (key: string) => store.db.query<{ value: string }, [string]>("SELECT value FROM review_settings WHERE key = ?").get(key)?.value;
  const setSetting = (key: string, value: string | null) => {
    if (value) store.db.query("INSERT INTO review_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    else store.db.query("DELETE FROM review_settings WHERE key = ?").run(key);
  };

  // A review the daemon was running when it stopped has no reviewer any more.
  for (const r of store.db.query<{ data: string }, []>("SELECT data FROM reviews WHERE state = 'running'").all().map((x) => JSON.parse(x.data) as Review))
    save({ ...r, state: "failed", error: "the daemon stopped while the review ran", ended: Date.now() });

  // Reviews the owner asked to stop: their end is "stopped", not a failure.
  const stopping = new Set<string>();
  const finish = (r: Review, reason: string) => {
    if (!r.child_id) return;
    if (stopping.delete(r.id)) { save({ ...r, state: "stopped", error: "Stopped by you", ended: Date.now() }); return; }
    if (reason === "interrupted" || reason === "error" || reason === "refusal") {
      save({ ...r, state: "failed", error: reason === "interrupted" ? "the reviewer's turn was cut off" : `the reviewer's turn ended: ${reason}`, ended: Date.now() });
      return;
    }
    const evs = store.events(r.child_id);
    let text = "";
    for (let i = evs.length - 1; i >= 0 && !text; i--) {
      const e = evs[i]!;
      if (e.kind === "assistant") text = (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    }
    try {
      save({ ...r, ...parseAnswer(text), state: "done", ended: Date.now() });
    } catch (e) {
      save({ ...r, state: "failed", error: (e as Error).message, ended: Date.now() });
    }
  };

  registerHooks({
    turnEnd(s, reason) {
      const r = byChild(s.id);
      if (r) finish(r, reason);
    },
  });

  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  const guard = async (f: () => Promise<Response>) => {
    try { return await f(); } catch (e) {
      if (e instanceof GitError) return bad(e.message, e.status);
      throw e;
    }
  };

  return {
    "/api/reviews/settings": {
      GET: () => json({ model: setting("model") ?? null }),
      PUT: async (req: any) => {
        const b = await body(req);
        if (b.model) await providers.resolve(String(b.model));
        setSetting("model", b.model ? String(b.model) : null);
        return json({ model: setting("model") ?? null });
      },
    },
    "/api/sessions/:id/reviews": {
      GET: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        // A review of uncommitted work that has since been committed whole is tied to that
        // commit: its findings are about the commit now, not about work still to commit.
        const list = all(s.id);
        const open = list.filter((r) => r.scope === "uncommitted" && r.state === "done" && r.from && r.to && !r.committed);
        for (const r of open) {
          const of = r.agent_id ? store.session(agents.get(r.agent_id)?.session_id ?? "") : s;
          const sha = of ? await wts.committedAs(of, r.from!, r.to!).catch(() => null) : null;
          if (sha) Object.assign(r, save({ ...r, committed: sha.slice(0, 12) }));
        }
        return json({ reviews: list });
      },
      POST: (req: any) => guard(async () => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.parent_id) return bad("a review runs from the session that owns the work, not from a child session");
        const b = await body(req);
        // A review of one agent's work: its worktree's branch, its findings sent back to that agent.
        const agent = b.agent_id ? agents.get(String(b.agent_id)) : undefined;
        if (b.agent_id && (!agent || agent.parent_id !== s.id)) return bad("the session has no such agent", 404);
        const of = agent ? store.session(agent.session_id) : s;
        if (!of) return bad("the agent's session is gone", 404);
        const scope: Scope = b.scope ?? (agent?.worktree ? "branch" : "uncommitted");
        if (!SCOPES.includes(scope)) return bad(`scope is ${SCOPES.join(", ")}`);
        const kind: ReviewKind = b.kind === "security" ? "security" : "code";
        const focus = typeof b.focus === "string" && b.focus.trim() ? b.focus.trim().slice(0, 2000) : undefined;
        const model = String(b.model || setting("model") || s.model);
        let info;
        try { ({ info } = await providers.resolve(model)); } catch (e) { return bad(`the reviewer cannot start: ${(e as Error).message}`, 409); }
        const d = await wts.changeDiff(of, scope, scope === "commit" ? b.commit : b.base);
        if (!d.files.length) return bad(scope === "uncommitted" ? "there is no uncommitted work to review" : "there is no change in that scope to review");
        // The same trees on the same reviewer were reviewed already: that result is
        // returned (another model is a second opinion and runs).
        const key = reviewKey({ from: d.from, to: d.to, kind, focus, model: info.id });
        const earlier = all(s.id).reverse().find((r) => r.diff_sha256 === key && (r.state === "done" || r.state === "running") && (r.agent_id ?? null) === (agent?.id ?? null));
        if (earlier) return json({ review: earlier, skipped: true, note: `${info.name ?? info.id} reviewed this exact change already` });
        // Half the reviewer's window for the diff (about four characters a token).
        const room = Math.max(20_000, info.context * 2);
        const cut = d.diff.length > room || d.truncated;
        const task = reviewTask({ kind, scope, target: d.target, focus, diff: d.diff.slice(0, room), cut, files: d.files });
        const child = store.createSession({ model, workspace: of.workspace, title: `${kind === "security" ? "Security review" : "Review"}: ${agent ? agent.title : s.title || "session"}`.slice(0, 80) });
        store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(s.id, child.id);
        // Read-only, and confined with no network where the sandbox can run.
        const sb = sandboxStatus().available;
        gate?.setPerm(child.id, { mode: "read-only", sandbox: sb ? "read-only" : "off", network: !sb });
        const r = save({
          id: Bun.randomUUIDv7(), session_id: s.id, child_id: child.id, kind, scope, target: d.target, focus, model: info.id,
          diff_sha256: key, files: d.files.length, state: "running", findings: [], created: Date.now(), cut, from: d.from, to: d.to,
          ...(agent ? { agent_id: agent.id, agent_title: agent.title, agent_branch: agent.branch ?? undefined } : {}),
        });
        agents.adopt(s.id, child.id, { title: child.title || "Review", type: "reviewer", model: info.id });
        bus.emit({ t: "session", session: store.session(child.id)! });
        try {
          engine.send(child.id, task, { meta: { kind: "review", review_id: r.id } });
        } catch (e) {
          errors.capture("server", e, { at: "review start", session: s.id });
          return json({ review: save({ ...r, state: "failed", error: (e as Error).message, ended: Date.now() }), skipped: false }, 201);
        }
        return json({ review: r, skipped: false }, 201);
      }),
    },
    "/api/sessions/:id/reviews/:rid": {
      // Stop a running review.
      DELETE: async (req: any) => {
        const r = get(req.params.rid);
        if (!r || r.session_id !== req.params.id) return bad("no such review", 404);
        if (r.state !== "running") return bad("the review is not running", 409);
        stopping.add(r.id);
        if (r.child_id && engine.isRunning(r.child_id)) await engine.interrupt(r.child_id, "review");
        stopping.delete(r.id);
        const now = get(r.id)!;
        return json({ review: now.state === "running" ? save({ ...now, state: "stopped", error: "Stopped by you", ended: Date.now() }) : now });
      },
    },
    "/api/sessions/:id/reviews/:rid/findings": {
      POST: async (req: any) => {
        const b = await body(req);
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const r = get(req.params.rid);
        if (!r || r.session_id !== s.id) return bad("no such review", 404);
        if (r.state !== "done") return bad("the review is not done", 409);
        if (!["fix", "dismiss", "reopen"].includes(b.action)) return bad("action is fix, dismiss or reopen");
        const ids: number[] | null = Array.isArray(b.ids) ? b.ids.map(Number) : null;
        const want = b.action === "reopen" ? (f: Review["findings"][0]) => f.state !== "open" : (f: Review["findings"][0]) => f.state === "open";
        const chosen = r.findings.filter((f) => (!ids || ids.includes(f.id)) && want(f));
        if (!chosen.length) return bad("no finding to act on", 409);
        // Findings on an agent's work go to that agent, which continues with its
        // context. When it is gone, nothing is sent unless the owner picks the
        // session instead (to: "session").
        const agent = b.action === "fix" && r.agent_id ? agents.get(r.agent_id) : undefined;
        if (b.action === "fix") {
          if (s.archived) return bad("the session is archived", 409);
          if (r.agent_id && !agent && b.to !== "session") return json({ error: `the agent that did this work (${r.agent_title ?? r.agent_id.slice(0, 8)}) is gone`, agent_gone: true }, 409);
        }
        const state = b.action === "fix" ? "fix_requested" : b.action === "dismiss" ? "dismissed" : "open";
        const sentTo = b.action === "fix" ? (agent ? agent.title : "the session") : undefined;
        const picked = new Set(chosen.map((f) => f.id));
        // Claimed before anything is sent (no await in between): a second
        // request for the same findings finds them taken and sends nothing.
        const next = save({ ...r, findings: r.findings.map((f) => (picked.has(f.id) ? { ...f, state, ...(sentTo ? { sent_to: sentTo } : {}) } : f)) });
        if (b.action === "fix") {
          try {
            if (agent) await agents.send(agent.id, fixPrompt(r, chosen));
            else {
              engine.send(s.id, fixPrompt(r, chosen), { mode: "queue", meta: { kind: "review_fix", review_id: r.id } });
              // Fix is the owner's own action: after a Stop it releases the held
              // queue, as a prompt they type does. A prompt queued on another
              // branch still waits for them to say where it goes.
              const first = engine.queued(s.id)[0];
              if (engine.isHeld(s.id) && !(first && engine.offBranch(first))) engine.resumeQueue(s.id);
            }
          } catch (e) {
            const back = get(r.id)!;
            save({ ...back, findings: back.findings.map((f) => (picked.has(f.id) ? chosen.find((c) => c.id === f.id)! : f)) });
            throw e;
          }
        }
        return json({ review: next });
      },
    },
  };
};
