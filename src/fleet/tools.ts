// The fleet's tools for every family: what machines the session can use, and
// one shell command on another machine without moving the session.
import { boundOverview, DEFAULT_SINCE, MAX, overview, overviewText, tooFarBack } from "../admin/overview.ts";
import { parseSince } from "../admin/timeline.ts";
import { agentCounts, sessionState } from "../automation/state.ts";
import { watchOf, watchWord } from "../core/watch.ts";
import { registerShared } from "../tools/registry.ts";
import { fail, ok, type Tool } from "../tools/types.ts";
import type { Fleet } from "./fleet.ts";
import { HttpError, type Messages } from "./messages.ts";
import { remoteExec } from "./remote.ts";
import { messageLine, sayAt } from "../admin/daemon-log.ts";

let fleet: Fleet | undefined;
let messages: Messages | undefined;
let sessionOf: ((id: string) => import("../core/types.ts").Session | undefined) | undefined;
let notices: ReturnType<typeof import("./notice.ts").bindNotices> | undefined;
export const bindFleetTools = (f: Fleet, m: Messages, s: typeof sessionOf, n: typeof notices) => { fleet = f; messages = m; sessionOf = s; notices = n; };

const gb = (mb?: number) => (mb === undefined ? "?" : `${(mb / 1024).toFixed(1)} GB`);

const machinesList: Tool = {
  name: "keel__machines_list",
  description: "List the machines this session can use: state, cores, load, free memory, GPU, tools found, the granted directory and the job queue. Connects to nothing.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  readOnly: true,
  async run() {
    if (!fleet) return fail("The fleet is not running.");
    const lines: string[] = [];
    const me = await fleet.localView();
    const f = me.facts;
    lines.push(`${me.name} (this machine): ready; ${f.cpus} cores, load ${f.load1}, ${gb(f.mem_available_mb)} free of ${gb(f.mem_total_mb)}${f.gpu ? `, GPU ${f.gpu}` : ""}; tools ${f.tools.join(" ")}`);
    for (const m of fleet.rows()) {
      const v = fleet.view(m);
      const ff = v.facts;
      const state = v.checked_ms ? `${v.state}${v.reason ? ` (${v.reason})` : ""}` : "not checked";
      const what = ff ? `; ${ff.os} ${ff.arch}, ${ff.cpus} cores, load ${ff.load1}, ${gb(ff.mem_available_mb)} free${ff.gpu ? `, GPU ${ff.gpu}` : ""}; tools ${ff.tools.join(" ")}` : "";
      const root = v.workspace_root ? `; granted ${v.workspace_root}` : "; no directory granted (no commands run there)";
      lines.push(`${m.name}: ${state}${what}${root}; jobs ${v.queue.running} running, ${v.queue.waiting} waiting${v.queue.limit ? ` of ${v.queue.limit}` : ""}`);
    }
    const off = fleet.offered();
    if (off.length) lines.push(`Not enabled (ssh hosts): ${off.join(", ")}`);
    return ok(lines.join("\n"));
  },
};

const runOn: Tool = {
  name: "keel__run_on",
  description: "Run one shell command on another machine of the fleet (by name), in its granted directory or a cwd inside it. The session stays where it is. Waits for a slot in that machine's job queue.",
  input_schema: {
    type: "object",
    properties: {
      machine: { type: "string", description: "Machine name or id, from keel__machines_list" },
      command: { type: "string", description: "The shell command" },
      cwd: { type: "string", description: "Directory on that machine, inside its granted directory" },
    },
    required: ["machine", "command"],
    additionalProperties: false,
  },
  readOnly: false,
  kind: "shell",
  peer: true,
  async run(input, ctx) {
    if (!fleet) return fail("The fleet is not running.");
    if (typeof input.command !== "string") return fail("command must be one string.");
    const m = fleet.byName(String(input.machine ?? ""));
    if (!m) return fail(`No machine named ${input.machine}. Known: ${fleet.rows().map((r) => r.name).join(", ") || "none"}.`);
    if (!m.workspace_root) return fail(`${m.name} has no granted directory: the owner sets one in Settings, Machines.`);
    const release = await fleet.acquire(m.id, ctx.signal).catch((e) => e as Error);
    if (release instanceof Error) return fail(release.message);
    try {
      const out = await remoteExec(fleet, m, ctx, String(input.command), input.cwd);
      const text = typeof out.content === "string" ? out.content : out.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
      return { content: `[ran on ${m.name}]\n${text}`, is_error: out.is_error };
    } finally {
      release();
    }
  },
};

const sessionsList: Tool = {
  name: "keel__sessions_list",
  description: "List the owner's other sessions, on this daemon and on linked machines: the address to send to, title, machine, directory and state (needs you, working, failed, stopped, done, not started; a session whose agents still work is working, with how many). Leaves out this session and archived ones. report: true gives one short report instead: the agents you started, then this daemon's other sessions by what needs the owner, what failed and why, and what runs and for how long, with the turns and spend since a time.",
  input_schema: {
    type: "object",
    properties: {
      machine: { type: "string", description: "Only this machine's sessions" },
      report: { type: "boolean", description: "The short report instead of the list." },
      since: { type: "string", description: "With report, what was done and spent since: a span back from now (90s, 30m, 1h, 2d) or an ISO time. A day by default, at most 7 days." },
      max: { type: "integer", description: `With report, the other sessions listed, the ones that need the owner first (default ${MAX}).` },
    },
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    if (input.report === true) {
      const from = boundOverview();
      if (!from) return fail("NOT_AVAILABLE: the report is not running on this daemon.");
      if (input.max !== undefined && !(Number.isInteger(input.max) && input.max >= 1)) return fail(`max is a whole number of sessions from 1 up (${MAX} by default)`);
      try {
        const since = input.since ? parseSince(String(input.since)) : Date.now() - DEFAULT_SINCE;
        const far = tooFarBack(since);
        if (far) return fail(far);
        return ok(overviewText(overview(from, { since, of: ctx.sessionId, max: input.max })));
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    if (!messages) return fail("The fleet is not running.");
    const want = typeof input.machine === "string" ? input.machine.toLowerCase() : "";
    const rows = messages.addressable().filter((a) => a.session.id !== ctx.sessionId && !a.session.parent_id && (!want || a.machine.toLowerCase() === want || a.machine_id === want));
    if (!rows.length) return ok("No other sessions.");
    // A linked daemon's row says what that daemon last showed of it.
    const counts = agentCounts();
    const state = (a: (typeof rows)[number]) => (a.local ? sessionState(a.session, { counts }).word : watchWord(watchOf(a.session, undefined)));
    return ok(rows.slice(0, 100).map((a) => `${a.to}\t${a.session.title || "(untitled)"}\t${a.machine}\t${a.session.workspace}\t${state(a)}`).join("\n"));
  },
};

const sessionSend: Tool = {
  name: "keel__session_send",
  description: "Send a message to another of the owner's sessions (an address from keel__sessions_list, a session id, or a part of its title naming one session). It reaches that session as another session's text, not the owner's. An idle session takes it as its next turn now; a working one after its current turn. notify_when_idle: one notice comes back here when that session has handled the message and is idle (or, with no text, when it is next idle); nothing to poll.",
  input_schema: {
    type: "object",
    properties: { to: { type: "string" }, text: { type: "string" }, notify_when_idle: { type: "boolean" } },
    required: ["to"],
    additionalProperties: false,
  },
  readOnly: false,
  async run(input, ctx) {
    if (!messages || !sessionOf) return fail("The fleet is not running.");
    const to = String(input.to ?? input.session ?? input.id ?? "").trim();
    const text = String(input.text ?? input.message ?? "");
    const notify = input.notify_when_idle === true;
    const missing = [!to && "to", !text.trim() && !notify && "text"].filter(Boolean);
    if (missing.length) return fail(`Missing: ${missing.join(", ")}.`);
    const me = sessionOf(ctx.sessionId);
    if (!me) return fail("This session is gone.");
    try {
      if (!text.trim()) {
        const t = messages.resolve(me, to);
        if (t.session.id === me.id) return fail("A session cannot wait for itself.");
        return ok(notices!.watch(me.id, { machine: t.machine, machine_name: t.machine_name, session: t.session.id, title: t.session.title }));
      }
      const r = await messages.sendTo(me, to, text, true);
      if (!notify) return ok(r.text);
      if (!r.message_id || !r.machine || !r.session) return ok(`${r.text} No notice: that daemon has no link from here to ask it.`);
      const name = r.machine === "local" ? "" : fleet?.row(r.machine)?.name ?? r.machine;
      const title = r.machine === "local" ? sessionOf(r.session)?.title : fleet?.remoteSessions(r.machine).sessions.find((x) => x.id === r.session)?.title;
      return ok(`${r.text} ${notices!.watch(me.id, { machine: r.machine, machine_name: name, session: r.session, title }, r.message_id)}`);
    } catch (e) {
      if (e instanceof HttpError) {
        // A send that was refused is a message that went nowhere: the log says so, with why.
        sayAt({ session: me.id }, messageLine({ id: "", from: me.title, to: to.length > 40 ? `${to.slice(0, 39)}…` : to, state: "refused", why: e.message, sent: true }), "warn");
        return fail(e.message);
      }
      if (e instanceof Error && /active waits/.test(e.message)) return fail(e.message);
      throw e;
    }
  },
};

registerShared(machinesList, runOn, sessionsList, sessionSend);
