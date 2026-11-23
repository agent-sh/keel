// Permission gate routes and its beforeTool hook. app.ts wraps every handler
// so a throw is captured as an error.
import { join } from "node:path";
import { deliver } from "../../automation/core.ts";
import { sandboxSaid } from "../../safety/refwatch.ts";
import { gitShut, linkedWorktree } from "../../safety/sandbox.ts";
import { hiddenSaid, hiddenSettings, ownerHome, sandboxBytes, sandboxScope, shownPaths, tendSandboxes, toolchainPaths, warmOverlays } from "../../safety/sandbox-view.ts";
import { proxiesClosed, refusedSince } from "../../safety/net-proxy.ts";
import { configRefused, refusedConfigs, refusedSentence } from "../../core/named-config.ts";
import { sandboxConfig, setSandboxConfig } from "../../safety/sandbox-config.ts";
import { escapeOf } from "../../safety/policy.ts";
import * as activity from "../../automation/activity.ts";
import { stopKind } from "../../core/stops.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { toolFacts, webUse } from "../../tools/registry.ts";
import { catalogReady } from "../../tools/catalog.ts";
import { RUN_CODE } from "../../tools/codemode.ts";
import { EVENTS_MAX } from "../../safety/marks.ts";
import { readsOf } from "../reads.ts";
import { Gate, type SandboxProfile } from "../../safety/gate.ts";
import { asksLess, isMode, MODE_GROUPS, MODES } from "../../safety/policy.ts";
import { makeJudge } from "../../safety/judge.ts";
import { forwardedPeer, isLocal, Presence } from "../../safety/presence.ts";
import { CLIENTS, type AnsweredBy } from "../../safety/card.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import type { Deps, RouteModule } from "../app.ts";
import { setGitReach } from "../../core/git.ts";
import { scopeDir } from "../../safety/sandbox-scope.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const PROFILES = ["off", "workspace-write", "read-only"];
// The longest list of cards one answer may name.
const MANY = 100;

export let gate: Gate | undefined;
export let presence: Presence | undefined;

// A mode that asks less than another (a remote device needs the owner's passkey to loosen one).
export { asksLess };

export const permissionRoutes: RouteModule = (deps: Deps) => {
  const { store } = deps;
  const g = (gate = new Gate(store, deps.bus, (_s, p) => p.sandbox !== "off" && sandboxStatus().available));
  const pk = (presence = new Presence(store));
  // 428 tells the page which action to get a passkey assertion for, then retry once.
  const needs = (req: Request, action: string) => (pk.allows(req, action) ? null : json({ error: "this needs your passkey from a remote device", presence: { action } }, 428));
  g.judge = makeJudge(store, deps.providers, () => g.setting("reviewer_model"), () => g.setting("reviewer_policy"));
  g.webUse = webUse;
  const sb = sandboxStatus();
  // (Whether the package caches can be layered here is asked now, off the loop: src/safety/sandbox-view.ts.)
  if (sb.available) void warmOverlays(sb.bwrap);
  if (!sb.available && g.defaultSandbox() !== "off") deps.errors.capture("server", new Error(`sandbox unavailable: ${sb.reason}`), { at: "startup" });
  // What the daemon's own git may fetch for a session's worktree: as far as that session reaches.
  setGitReach((id) => g.gitReach(id));
  registerHooks({
    beforeTool: (s, call) => g.beforeTool(s, call),
    // What a confined command in a linked worktree changed outside its own
    // branch is said in its result and in the session's activity. What a
    // confined command ran into (the read-only top, the read-only config,
    // the network that is off) is said in its result, with the way this
    // tool asks to leave the sandbox.
    afterTool: async (s, call, result) => {
      const watched = await g.refsChanged(s.id, call.id);
      const confined = call.tool.kind === "shell" ? call.ctx.confined : undefined;
      if (!watched && !confined) return;
      const said = typeof result.content === "string" ? result.content : result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const shut = confined ? sandboxSaid(said, { linked: !s.machine && !!linkedWorktree(s.workspace), network: !!confined.network, escape: escapeOf(call.tool), ...(s.machine ? {} : { shut: () => gitShut(s.workspace), refused: () => refusedSince(scopeDir(sandboxScope(s.workspace)), confined.since ?? Date.now()), closed: proxiesClosed }) }) : [];
      // What the sandbox's view of the machine hid from it (src/safety/sandbox-view.ts).
      if (confined && !s.machine) {
        const opts = g.readOpts(s, confined.sandbox === "read-only" ? "read-only" : "workspace-write");
        shut.push(...hiddenSaid(said, { workspace: s.workspace, shown: () => shownPaths(s.workspace, opts), escape: escapeOf(call.tool), sshAgent: opts.sshAgent, cwd: call.ctx.cwd }));
      }
      if (watched?.note) activity.record("approval", "sandbox", s.id, watched.note, { call_id: call.id });
      const text = [watched?.note && `[sandbox] ${watched.note} If this command did that and it was not asked for, put it back and say so.`, ...shut.map((line) => `[sandbox] ${line}`)].filter(Boolean).join("\n\n");
      if (!text) return;
      // (A result that says the turn was stopped under the call is read by its exact words.)
      if (typeof result.content !== "string") result.content = [...result.content, { type: "text", text }];
      else if (!stopKind(result.content)) result.content = result.content ? `${result.content}\n\n${text}` : text;
    },
    callOutcome: (sid, callId) => g.callOutcome(sid, callId),
    awaitsOwner: (sid, callId) => g.awaitsOwner(sid, callId),
    turnParking: (sid) => g.park(sid),
    // A call that was dispatched, or whose result is stored, has no use for a card a restart left parked for it.
    toolRan: (s, call) => g.settled(s.id, call.id),
    resultStored: (s, results) => { for (const r of results) g.settled(s.id, r.tool_use_id); },
    turnStart: (s) => g.turnStarted(s.id),
  });

  const presenceCall = async (f: () => Promise<Response>) => {
    try { return await f(); } catch (e) {
      const st = (e as any).status;
      if (st) return bad((e as Error).message, st);
      return bad(`the passkey could not be verified: ${(e as Error).message}`, 400);
    }
  };
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  // How an answer was given, as its client says: `seen` is its word that it
  // showed the whole text, `via` its kind (the phone's kinds are the phone
  // API's to give). A daemon that forwards the answer passes both through as
  // they came; the machine it came through is added here, from the link.
  const given = (req: Request, b: any): { seen?: "whole"; by: Omit<AnsweredBy, "seen"> } => {
    const peer = forwardedPeer(req);
    const client = (CLIENTS as readonly string[]).includes(b.via) && b.via !== "phone" && b.via !== "notification" ? (b.via as AnsweredBy["client"]) : "api";
    return { ...(b.seen === "whole" ? { seen: "whole" as const } : {}), by: { client, ...(peer ? { peer } : {}) } };
  };
  const settings = () => ({ default_mode: g.defaultMode(), default_sandbox: g.defaultSandbox(), reviewer_model: g.setting("reviewer_model") ?? null, reviewer_policy: g.setting("reviewer_policy") ?? "", modes: MODES, mode_groups: MODE_GROUPS, sandbox: sandboxStatus() });

  const sandboxSettings = () => {
    const home = ownerHome();
    const short = (p: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
    const scopes = [...new Set([...Object.keys(sandboxConfig().workspaces), ...store.sessions().filter((s) => !s.machine && !s.archived).map((s) => sandboxScope(s.workspace))])].sort();
    // (Each of the owner's configuration files a variable names is looked at now: one inside a session's folder is not loaded.)
    for (const [name, path] of [["KEEL_HOOKS", process.env.KEEL_HOOKS], ["KEEL_MCP_CONFIG", process.env.KEEL_MCP_CONFIG], ["KEEL_ACP_AGENTS", process.env.KEEL_ACP_AGENTS], ["KEEL_ACP_FOLDERS", process.env.KEEL_ACP_FOLDERS]] as const) if (path) configRefused(name, path);
    return { ...sandboxConfig(), scopes, shown: toolchainPaths().map(short), hidden_settings: hiddenSettings(), config_refused: refusedConfigs().map(refusedSentence), bytes: sandboxSize.bytes, available: sandboxStatus().available };
  };
  // What the sandboxes hold on disk (their cache layers and temp files): measured off the loop, at most once a minute.
  const sandboxSize = { bytes: 0, at: 0, busy: false };
  const measure = () => {
    if (sandboxSize.busy || Date.now() - sandboxSize.at < 60_000) return;
    sandboxSize.busy = true;
    void sandboxBytes().then((n) => { sandboxSize.bytes = n; sandboxSize.at = Date.now(); }).finally(() => { sandboxSize.busy = false; });
  };

  return {
    "/api/permissions/settings": {
      GET: () => json(settings()),
      PUT: async (req: any) => {
        const guard = needs(req, "settings");
        if (guard) return guard;
        const b = await body(req);
        if (b.default_mode !== undefined) {
          if (!isMode(b.default_mode)) return bad(`unknown mode: ${b.default_mode}`);
          g.setDefaultMode(b.default_mode);
        }
        if (typeof b.reviewer_policy === "string") g.setSetting("reviewer_policy", b.reviewer_policy.trim().slice(0, 8000) || null);
        if (b.reviewer_model !== undefined) {
          if (b.reviewer_model) await deps.providers.resolve(String(b.reviewer_model));
          g.setSetting("reviewer_model", b.reviewer_model ? String(b.reviewer_model) : null);
        }
        if (b.default_sandbox !== undefined) {
          if (!PROFILES.includes(b.default_sandbox)) return bad(`unknown sandbox profile: ${b.default_sandbox}`);
          g.setDefaultSandbox(b.default_sandbox as SandboxProfile);
        }
        return json(settings());
      },
    },
    // What a sandboxed command may read beyond the system and the owner's
    // toolchains: the owner's lists, for every workspace and per workspace,
    // and whether a workspace's commands may use the SSH agent. `shown`: what
    // of the home every sandbox shows, so the owner sees it. `scopes`: the
    // repositories and folders the sessions work in.
    "/api/permissions/sandbox": {
      GET: () => { measure(); return json(sandboxSettings()); },
      PUT: async (req: any) => {
        // (Every change here lets commands read more: it is the owner's.)
        const guard = needs(req, "settings");
        if (guard) return guard;
        const b = await body(req);
        const no = setSandboxConfig({ read: b.read, env: b.env, workspace: b.workspace });
        if (no) return bad(no);
        return json(sandboxSettings());
      },
    },
    // The sandboxes' own cache layers and temp files, removed now (what a running command holds stays).
    "/api/permissions/sandbox/clear": {
      POST: async () => {
        await tendSandboxes(true);
        sandboxSize.bytes = await sandboxBytes();
        sandboxSize.at = Date.now();
        return json(sandboxSettings());
      },
    },
    "/api/sessions/:id/permissions": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        // `rev`: the bus frame this read reflects, so a page orders it against perm frames.
        return s ? json({ perm: g.perm(s.id), scope: g.scopeOf(s.workspace), rev: deps.bus.rev() }) : bad("no such session", 404);
      },
      PUT: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        if (b.mode !== undefined && !isMode(b.mode)) return bad(`unknown mode: ${b.mode}`);
        if (b.sandbox !== undefined && !PROFILES.includes(b.sandbox)) return bad(`unknown sandbox profile: ${b.sandbox}`);
        if (b.sandbox && b.sandbox !== "off" && !sandboxStatus().available) return bad(`the sandbox is unavailable: ${sandboxStatus().reason}`, 409);
        const cur = g.perm(s.id);
        const looser = (b.mode !== undefined && asksLess(b.mode, cur.mode)) || (b.sandbox === "off" && cur.sandbox !== "off") || (b.network === true && !cur.network);
        const guard = looser ? needs(req, `perm:${s.id}`) : null;
        if (guard) return guard;
        const patch: any = {};
        if (b.mode !== undefined) patch.mode = b.mode;
        if (b.sandbox !== undefined) patch.sandbox = b.sandbox;
        if (b.network !== undefined) patch.network = !!b.network;
        const perm = g.setPerm(s.id, patch);
        return json({ perm, rev: deps.bus.rev() });
      },
    },
    // What the transcript marks on the calls of these events (src/safety/marks.ts): asked for the events a
    // page holds. The loop gathers the session's facts; the events are read and judged on the read thread.
    "/api/sessions/:id/call-marks": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as { events?: unknown };
        const ids = Array.isArray(b.events) ? [...new Set(b.events.filter((x): x is string => typeof x === "string" && x.length <= 64))] : [];
        if (ids.length > EVENTS_MAX) return bad(`at most ${EVENTS_MAX} events a request`);
        if (!ids.length) return json({ marks: {} });
        // The session's MCP tools as they are known now, without waiting on a connection.
        const mcp = await Promise.race([catalogReady(undefined, s.id), new Promise<[]>((r) => setTimeout(() => r([]), 50))]).catch(() => []);
        const marks = await readsOf(store).run("calls.marks", {
          session: s.id, events: ids, ...g.markFacts(s), tools: toolFacts(), runCode: RUN_CODE, mcpCall: "mcp_call",
          mcp: mcp.map((t) => ({ qualified: t.qualified, name: t.name, readOnly: !!t.readOnly })),
          jobs: join(store.stateDir, "spill", s.id, "jobs"),
        });
        return json({ marks });
      },
    },
    // What the judge refused without the owner (reviewer mode, full auto), newest first; the owner can let one retry through.
    "/api/sessions/:id/blocked": {
      GET: (req: any) => (store.session(req.params.id) ? json({ blocked: g.blocked(req.params.id), reviewer_model: g.setting("reviewer_model") ?? null }) : bad("no such session", 404)),
    },
    "/api/sessions/:id/blocked/:bid": {
      POST: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const guard = needs(req, `retry:${req.params.bid}`);
        if (guard) return guard;
        const b = g.allowRetry(s.id, req.params.bid);
        if (!b) return bad("no such refused call", 404);
        const text = `[harness] The owner let one retry of a refused call go through: ${b.tool} ${b.summary.slice(0, 300)}. The owner wants it run: run it again now, exactly as before; this one time it is not refused.`;
        deliver(s.id, text, { kind: "harness", origin: "harness" });
        return json({ ok: true, blocked: b });
      },
    },
    "/api/approvals": {
      GET: () => json({ approvals: g.approvals({ pending: true }) }),
    },
    "/api/sessions/:id/approvals": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const all = new URL(req.url).searchParams.has("all");
        return json({ approvals: g.approvals({ session: s.id, pending: !all }) });
      },
      // Several cards allowed once with one answer. The gate refuses the whole
      // list when it names a card that is answered alone (high risk, or shown
      // only in part): all of these are low risk and allowed once, which needs
      // no passkey from a remote device, as one such card does not.
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        if (b.choice !== "once") return bad("several requests are answered together only with choice once");
        if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x: unknown) => typeof x === "string")) return bad("ids is a list of approval ids");
        // More than a page can show to be read at once is not a list the owner answered.
        if (b.ids.length > MANY) return bad(`at most ${MANY} requests are answered together`);
        const r = g.resolveMany(s.id, b.ids, (e, id) => deps.errors.capture("server", e, { at: "approvals answered together", approval: id }), given(req, b));
        return "error" in r ? json({ error: r.error, alone: r.alone }, r.status) : json(r);
      },
    },
    "/api/sessions/:id/approvals/:aid": {
      // One card as every client is given it: the whole text to judge, whether
      // it is cut, the marks in it, its risk, where it runs, why it is asked,
      // and why an allow needs the text shown first (`card.hold`).
      GET: (req: any) => {
        const a = g.approval(req.params.aid);
        return a && a.session_id === req.params.id ? json({ approval: a, card: g.form(a) }) : bad("no such approval", 404);
      },
      POST: async (req: any) => {
        const b = await body(req);
        if (!["once", "session", "always", "deny"].includes(b.choice)) return bad("choice is once, session, always or deny");
        // A high-risk card, or a standing answer, from a remote device: the owner's passkey.
        const card = g.approval(req.params.aid);
        if (card && b.choice !== "deny" && (card.risk === "high" || b.choice !== "once")) {
          const guard = needs(req, `approval:${card.id}`);
          if (guard) return guard;
        }
        const rules = Array.isArray(b.rules) ? b.rules.filter((r: any) => ["shell", "edit", "tool"].includes(r?.kind) && typeof r.pattern === "string") : undefined;
        const r = g.resolve(req.params.aid, req.params.id, { choice: b.choice, reason: typeof b.reason === "string" ? b.reason : undefined, rules, ...given(req, b) });
        // (`hold`: the card is still open; the client is to show the whole text and answer again with `seen`.)
        return "error" in r ? json({ error: r.error, approval: r.approval, ...(r.hold ? { hold: r.hold } : {}) }, r.status) : json(r);
      },
    },
    "/api/permissions/grants": {
      GET: () => json({ grants: g.rules() }),
      POST: async (req: any) => {
        const guard = needs(req, "grant");
        if (guard) return guard;
        const b = await body(req);
        const s = store.session(b.session_id);
        if (!s) return bad("a grant names a session (its workspace is the scope)", 404);
        if (!["shell", "edit", "tool"].includes(b.kind) || typeof b.pattern !== "string" || !b.pattern.trim()) return bad("kind is shell, edit or tool, with a pattern");
        return json({ grant: g.addRule(s, b.kind, b.pattern, b.lifetime === "session" ? "session" : "always") }, 201);
      },
    },
    // Passkeys: enrolled at the desk, or on a device with a code shown at the desk.
    "/api/owner-presence": {
      GET: (req: any) => {
        const o = req.headers.get("origin");
        let rp: string | null = null;
        try { rp = o ? new URL(o).hostname : null; } catch {}
        return json({ local: isLocal(req), enrolled: pk.enrolled(), rp_id: rp, passkeys: pk.list() });
      },
    },
    "/api/owner-presence/code": {
      POST: (req: any) => (isLocal(req) ? json(pk.code()) : bad("the enrollment code is shown at the desk only", 403)),
    },
    "/api/owner-presence/register/start": {
      POST: async (req: any) => presenceCall(async () => json(await pk.registerStart(req, (await body(req)).code))),
    },
    "/api/owner-presence/register/finish": {
      POST: async (req: any) => presenceCall(async () => {
        const b = await body(req);
        return json({ ok: true, ...(await pk.registerFinish(req, String(b.ceremony ?? ""), b.credential, b.label)) });
      }),
    },
    "/api/owner-presence/authenticate/start": {
      POST: async (req: any) => presenceCall(async () => {
        const b = await body(req);
        if (typeof b.action !== "string" || !b.action) return bad("name the action to sign");
        return json(await pk.authStart(req, b.action));
      }),
    },
    "/api/owner-presence/authenticate/finish": {
      POST: async (req: any) => presenceCall(async () => {
        const b = await body(req);
        return json(await pk.authFinish(req, String(b.ceremony ?? ""), b.credential));
      }),
    },
    "/api/owner-presence/:pid": {
      DELETE: (req: any) => {
        const guard = needs(req, `passkey-remove:${req.params.pid}`);
        if (guard) return guard;
        return pk.remove(req.params.pid) ? json({ ok: true }) : bad("no such passkey", 404);
      },
    },
    "/api/permissions/grants/:gid/restore": {
      POST: (req: any) => {
        const guard = needs(req, "grant");
        if (guard) return guard;
        const r = g.restore(req.params.gid);
        return r ? json({ grant: r }) : bad("no revoke of that grant to undo in this daemon", 400);
      },
    },
    "/api/permissions/grants/:gid": {
      DELETE: (req: any) => (g.revoke(req.params.gid) ? json({ ok: true }) : bad("no such grant", 404)),
    },
  };
};
