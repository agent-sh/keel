// keel sessions | ls | show | logs | stop | send | approve | attach | open |
// resume | export | models: sessions from a terminal, as a client of the
// running daemon.
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { StoredEvent } from "../core/types.ts";
import { ago, ApiError, clean, Client, command, EXIT, line, openUrl, out, pipedStdin, printJson, promptFiles, usageError, authHeaders } from "./client.ts";
import { assistantText, Follower, streamLine, textLines } from "./events.ts";
import { exitOf, resultObject, RUN_OPTIONS, RUN_USAGE, runPrompt, watch, worktreeArg } from "./run.ts";

const home = homedir();
const tilde = (p: string) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);
const modelName = (id: string) => id.replace(/^[\w-]+:/, "").replace(/^(us|eu|apac|global)\./, "").replace(/^(anthropic|openai|google|meta|mistral)\./, "");

// ---- keel sessions / keel ls

const SESSIONS_USAGE = `keel sessions [QUERY] [options]      (also: keel ls)
  Lists sessions, newest first; with QUERY (or -q) searches titles, folders and what was said.

  -a, --all          archived sessions too
      --cwd DIR      only sessions of this directory
      --subagents    subagents' sessions too
  -n, --limit N      at most N (default 30)
  -q, --query TEXT   search instead of listing
      --ids          only the ids, one per line
      --json         the sessions as JSON`;

const sessions = command("sessions", SESSIONS_USAGE, {
  all: { type: "boolean", short: "a" }, cwd: { type: "string" }, subagents: { type: "boolean" },
  limit: { type: "string", short: "n" }, query: { type: "string", short: "q" }, ids: { type: "boolean" },
}, async (v, pos, c) => {
  const limit = v.limit ? Number(v.limit) : 30;
  if (!(limit > 0)) return usageError("sessions", "--limit is a number above 0", SESSIONS_USAGE);
  const q = (v.query ?? pos.join(" ")).trim();
  const cwd = v.cwd ? resolve(v.cwd) : undefined;
  if (q) {
    // The daemon applies the scope before it ranks and cuts, one hit per session per group.
    const scope = new URLSearchParams({ q, limit: String(Math.min(limit, 100)), sessions: "1" });
    if (!v.subagents) scope.set("roots", "1");
    if (!v.all) scope.set("archived", "0");
    if (cwd) scope.set("cwd", cwd);
    const { hits } = await c.get<{ hits: any[] }>(`/api/search?${scope}`);
    const seen = new Map<string, any>();
    for (const h of hits) {
      if (!seen.has(h.session_id)) seen.set(h.session_id, { id: h.session_id, title: h.session_title, workspace: h.cwd, archived: h.archived, matches: [] });
      seen.get(h.session_id).matches.push({ kind: h.kind, ts: h.ts, snippet: h.snippet.replace(/[\u0001\u0002]/g, "") });
    }
    const list = [...seen.values()].slice(0, limit);
    if (v.ids) return (list.forEach((s) => console.log(s.id)), EXIT.ok);
    if (v.json) return (printJson(list), EXIT.ok);
    if (!list.length) return (console.error(`no session matches ${JSON.stringify(q)}`), EXIT.ok);
    for (const s of list) {
      console.log(`${s.id}  ${line(s.title) || "(untitled)"}  ${tilde(s.workspace)}${s.archived ? "  [archived]" : ""}`);
      for (const m of s.matches.slice(0, 2)) if (m.kind !== "title") console.log(`    ${m.kind === "user" ? ">" : m.kind === "tool_use" || m.kind === "tool_result" ? "$" : " "} ${line(m.snippet)}`);
    }
    return EXIT.ok;
  }
  // --all: both partitions, merged before the sort and the cut.
  const { sessions: live } = await c.get<{ sessions: any[] }>("/api/sessions");
  const all = v.all ? live.concat((await c.get<{ sessions: any[] }>("/api/sessions?archived=1")).sessions) : live;
  const list = all.filter((s) => (v.subagents || !s.parent_id) && (!cwd || s.workspace === cwd)).sort((a, b) => b.updated - a.updated).slice(0, limit);
  if (v.ids) return (list.forEach((s) => console.log(s.id)), EXIT.ok);
  if (v.json) return (printJson(list), EXIT.ok);
  if (!list.length) return (console.error("no sessions"), EXIT.ok);
  for (const s of list) {
    const state = s.archived ? "archived" : s.phase === "idle" && s.settings.failed_ms ? "failed" : s.phase;
    console.log(`${s.id}  ${ago(s.updated).padStart(4)}  ${state.padEnd(8)}  ${modelName(s.model).slice(0, 28).padEnd(28)}  ${(line(s.title) || "(untitled)").slice(0, 60)}  ${tilde(s.workspace)}`);
  }
  return EXIT.ok;
});

// ---- keel show / keel logs

const SHOW_USAGE = `keel show ID [--tail N] [--thoughts] [--json]
  A session: what it is, then its transcript. ID is any unique prefix of the id.`;
const LOGS_USAGE = `keel logs ID [-f] [--tail N] [--thoughts] [--json]
  A session's events as text lines; with --json one stream-json line per event.
  -f, --follow    keep printing new events until interrupted`;

function printEvents(evs: StoredEvent[], v: any) {
  for (const e of evs) {
    if (v.json) console.log(JSON.stringify(streamLine(e)));
    else for (const l of textLines(e, { thoughts: v.thoughts })) console.log(l);
  }
}

const logsOf = (name: "show" | "logs", usage: string) =>
  command(name, usage, { follow: { type: "boolean", short: "f" }, tail: { type: "string", short: "n" }, thoughts: { type: "boolean" } }, async (v, pos, c) => {
    if (!pos[0]) return usageError(name, "name the session (keel sessions lists them)", usage);
    const s = await c.resolve(pos[0]);
    const { events } = await c.get<{ events: StoredEvent[] }>(`/api/sessions/${s.id}/events`);
    const tail = v.tail ? Number(v.tail) : undefined;
    if (tail !== undefined && !(tail >= 0)) return usageError(name, "--tail is a number", usage);
    // --tail 0 prints none of the history (with -f: only what comes next), like tail -n 0.
    const shown = tail === undefined ? events : tail === 0 ? [] : events.slice(-tail);
    if (name === "show") {
      if (v.json) {
        const st = await c.get<any>(`/api/cli/state/${s.id}`);
        printJson({ session: s, running: st.running, queue: st.queue, approvals: st.approvals, url: c.url(s.id), events: shown });
        return EXIT.ok;
      }
      const u = s.usage ?? {};
      console.log(`${line(s.title) || "(untitled)"}\n  id       ${s.id}\n  model    ${s.model}\n  folder   ${tilde(s.workspace)}\n  state    ${s.archived ? "archived" : s.phase}, updated ${ago(s.updated)} ago\n  tokens   ${(u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0)} in, ${u.output ?? 0} out${u.cost !== undefined ? `, $${u.cost.toFixed(4)}` : ""}\n  open     ${c.url(s.id)}\n`);
    }
    printEvents(shown, v);
    if (!v.follow) return EXIT.ok;
    const f = new Follower(c, s.id, events.at(-1)?.seq ?? 0, (e) => printEvents([e], v));
    await f.connect();
    process.on("SIGINT", () => (f.close(), process.exit(EXIT.sigint)));
    for (;;) {
      await f.read();
      await f.pause(2000);
    }
  });

// ---- keel stop

const STOP_USAGE = "keel stop ID [--json]\n  Interrupts the running turn of a session. The session stays; a new prompt continues it.";
const stop = command("stop", STOP_USAGE, {}, async (v, pos, c) => {
  if (!pos[0]) return usageError("stop", "name the session", STOP_USAGE);
  const s = await c.resolve(pos[0]);
  const st = await c.get<any>(`/api/cli/state/${s.id}`);
  await c.post(`/api/sessions/${s.id}/interrupt`);
  if (v.json) console.log(JSON.stringify({ ok: true, session_id: s.id, was_running: st.running }));
  else console.log(st.running ? `stopped ${s.id}` : `${s.id} was not running`);
  return EXIT.ok;
});

// ---- keel send

const SEND_USAGE = `keel send [ID] [TEXT] [options]
  Sends text or files to a session and returns at once (with --wait: prints the reply).
  The text is the argument, --text, or standard input. Without an id: the session the
  owner used in the last minute; a prompt with no such session needs an id or --new.
  Images go into the session's draft unless --send; a prompt carries what the draft holds.

      --text TEXT     the text, for a call that names no session
      --steer         join the running turn at its next model call
      --queue         run after the running turn
      --attach FILE   a file or image (repeatable)
      --send          send now, files included
      --new           always a new session (in --cwd, default here)
  -m, --model M, --provider P   for a session this command creates
      --wait          stay for the reply and print it as it arrives; exit by its outcome
      --timeout S     with --wait: seconds to stay
      --on-ask exit|deny|wait   with --wait: what an open card does (default exit)
      --json          { ok, session_id, url, queued?, draft? }`;

const looksLikeId = (s: string) => /^[0-9a-f]{8}[0-9a-f-]*$/i.test(s);

const send = command("send", SEND_USAGE, {
  text: { type: "string" }, steer: { type: "boolean" }, queue: { type: "boolean" }, attach: { type: "string", multiple: true },
  send: { type: "boolean" }, "no-send": { type: "boolean" }, new: { type: "boolean" }, model: { type: "string", short: "m" }, provider: { type: "string" },
  cwd: { type: "string", short: "C" }, wait: { type: "boolean" }, timeout: { type: "string" }, "on-ask": { type: "string" },
}, async (v, pos, c) => {
  if (v.steer && v.queue) return usageError("send", "--steer or --queue, not both", SEND_USAGE);
  if (v.send && v["no-send"]) return usageError("send", "--send or --no-send, not both", SEND_USAGE);
  let id: string | undefined;
  let text: string | undefined = v.text;
  const args = [...pos];
  if (args.length >= 2 || (args.length === 1 && v.text !== undefined)) id = args.shift();
  else if (args.length === 1 && looksLikeId(args[0]!)) {
    const hit = await c.resolve(args[0]!).catch(() => null);
    if (hit) { id = hit.id; args.shift(); }
  }
  if (text === undefined && args.length) text = args.join(" ");
  if (text === undefined) text = (await pipedStdin()) ?? undefined;
  text = text?.trim() || undefined;
  const paths: string[] = v.attach ?? [];
  if (!text && !paths.length) return usageError("send", "nothing to send: give text, standard input or --attach", SEND_USAGE);

  let s: any;
  if (id && v.new) return usageError("send", "an id or --new, not both", SEND_USAGE);
  if (id) s = await c.resolve(id);
  else if (!v.new) {
    const t = await c.get<{ session_id?: string }>("/api/draft/target");
    if (t.session_id) s = await c.resolve(t.session_id);
  }
  const sending = !!text || !!v.send;
  if (!s && sending && !v.new && text) {
    console.error("keel send: no session was used in the last minute: name one (keel sessions lists them) or pass --new");
    return EXIT.error;
  }
  if (!s) {
    const model = v.model ? (await c.get<{ model: string }>(`/api/cli/model?model=${encodeURIComponent(v.model)}${v.provider ? `&provider=${encodeURIComponent(v.provider)}` : ""}`)).model : undefined;
    s = (await c.post<{ session: any }>("/api/sessions", { workspace: resolve(v.cwd ?? process.cwd()), model })).session;
  }
  const files = await promptFiles(c, paths);
  const result: any = { ok: true, session_id: s.id, url: c.url(s.id) };

  if (!sending || v["no-send"]) {
    if (files.files.length) {
      console.error(`keel send: a draft holds images only; ${files.files.map((f: any) => f.name).join(", ")} ${files.files.length === 1 ? "goes" : "go"} with a prompt: add text or --send`);
      return EXIT.error;
    }
    const d = await c.post<any>(`/api/sessions/${s.id}/draft`, { images: files.draftImages, ...(text && v["no-send"] ? { text } : {}), origin: "cli" });
    result.draft = { text: d.text ?? "", attachments: d.attachments.length };
    if (v.json) console.log(JSON.stringify(result));
    else console.log(`put ${files.draftImages.length} image${files.draftImages.length === 1 ? "" : "s"} in the draft of ${s.id}`);
    return EXIT.ok;
  }

  // A prompt carries what the draft holds, then the draft is emptied.
  const draft = await c.get<any>(`/api/sessions/${s.id}/draft`).catch(() => ({ attachments: [] }));
  const held: any[] = [];
  for (const f of draft.attachments ?? []) {
    const r = await fetch(`${c.base}/api/sessions/${s.id}/draft/files/${f.id}`, { headers: authHeaders() });
    if (r.ok) held.push({ type: "image", media_type: f.mime, data: Buffer.from(await r.arrayBuffer()).toString("base64") });
  }
  const body = [draft.text, text].filter((t) => t?.trim()).join("\n\n") || "(see the attached files)";
  const before = await c.get<any>(`/api/cli/state/${s.id}`);
  const r = await c.post<any>(`/api/sessions/${s.id}/messages`, { text: body, mode: v.steer ? "steer" : v.queue ? "queue" : undefined, images: [...held, ...files.images, ...files.files] });
  if (held.length || draft.text) await c.del(`/api/sessions/${s.id}/draft`).catch(() => {});
  if (r.queued) result.queued = true;

  if (!v.wait) {
    if (v.json) console.log(JSON.stringify(result));
    else console.log(`${r.queued ? "queued in" : "sent to"} ${s.id}`);
    return EXIT.ok;
  }
  const onAsk = v["on-ask"] ?? "exit";
  if (!["exit", "deny", "wait"].includes(onAsk)) return usageError("send", "--on-ask is exit, deny or wait", SEND_USAGE);
  const t0 = Date.now();
  let live = "";
  const tty = !v.json;
  const w = await watch({
    c, sessionId: s.id, afterSeq: before.last_seq, eventId: r.event?.id ?? null, prompt: body, stay: "turn", onAsk, t0,
    timeoutS: v.timeout ? Number(v.timeout) : undefined,
    onDelta: tty ? (d) => { if (d.kind === "text") { live += d.text; out(clean(d.text)); } } : undefined,
    onEvent: tty ? (e) => {
      if (e.kind !== "assistant") return;
      const full = assistantText(e);
      if (full && full.startsWith(live)) out(clean(full.slice(live.length)));
      else if (full) out((live ? "\n" : "") + clean(full));
      if (full || live) out("\n");
      live = "";
    } : undefined,
  });
  if (v.json) console.log(JSON.stringify(resultObject(w, { sessionId: s.id, url: c.url(s.id), ms: Date.now() - t0, onAsk })));
  for (const e of w.errors) console.error(`keel send: ${clean(e)}`);
  if (w.pending) console.error(`keel send: the session waits for the owner; answer with keel approve ${s.id}`);
  return exitOf(w);
});

// ---- keel approve

const APPROVE_USAGE = `keel approve ID [options]
  Answers the oldest open approval card or question of a session (its subagents' included).

      --list              list the open cards and questions, answer none
      --approval AID      the card to answer (default: the oldest)
      --choice C          once, session, always or deny (default once)
      --deny              refuse (same as --choice deny)
      --answer TEXT       the answer to a question, or why a card is refused`;

const approve = command("approve", APPROVE_USAGE, {
  list: { type: "boolean" }, approval: { type: "string" }, choice: { type: "string" }, deny: { type: "boolean" }, answer: { type: "string" },
}, async (v, pos, c) => {
  if (!pos[0]) return usageError("approve", "name the session", APPROVE_USAGE);
  const s = await c.resolve(pos[0]);
  const st = await c.get<any>(`/api/cli/state/${s.id}`);
  const questions = [];
  for (const q of st.questions) {
    const { events } = await c.get<{ events: StoredEvent[] }>(`/api/sessions/${q.session_id}/events`);
    const use = events.flatMap((e) => (e.kind === "assistant" ? e.data.blocks : [])).find((b: any) => b.type === "tool_use" && b.id === q.call_id);
    questions.push({ ...q, questions: (use?.input?.questions ?? []).map((x: any, i: number) => ({ id: x.id ?? String(i), question: x.question, options: (x.options ?? []).map((o: any) => o.label) })) });
  }
  if (v.list) {
    if (v.json) return (printJson({ approvals: st.approvals, questions }), EXIT.ok);
    if (!st.approvals.length && !questions.length) return (console.log("nothing is open"), EXIT.ok);
    for (const a of st.approvals) console.log(`${a.id}  ${a.risk === "high" ? "high risk  " : ""}${clean(a.tool)}: ${line(a.summary)}${a.session_id !== s.id ? `  (subagent ${a.session_id})` : ""}`);
    for (const q of questions) for (const x of q.questions) console.log(`question ${q.call_id}: ${line(x.question)}${x.options.length ? `  [${x.options.map(line).join(" | ")}]` : ""}`);
    return EXIT.ok;
  }
  const choice = v.deny ? "deny" : v.choice ?? "once";
  if (!["once", "session", "always", "deny"].includes(choice)) return usageError("approve", "--choice is once, session, always or deny", APPROVE_USAGE);
  const card = v.approval ? st.approvals.find((a: any) => a.id === v.approval || a.id.startsWith(v.approval)) : st.approvals[0];
  if (card) {
    const r = await c.post<any>(`/api/sessions/${card.session_id}/approvals/${card.id}`, { choice, reason: v.answer });
    if (v.json) console.log(JSON.stringify({ ok: true, approval: r.approval ?? card.id, choice }));
    else console.log(`${choice === "deny" ? "refused" : `allowed (${choice})`}: ${clean(card.tool)} ${line(card.summary)}`);
    return EXIT.ok;
  }
  if (v.approval) throw new ApiError(`no open card ${v.approval}`, 404);
  const q = questions[0];
  if (!q) return (console.error(`keel approve: nothing is open in ${s.id}`), EXIT.error);
  if (v.answer === undefined && !v.deny) return usageError("approve", `a question is open: ${q.questions.map((x: any) => line(x.question)).join(" / ")}; pass --answer TEXT (or --deny)`, APPROVE_USAGE);
  // Free text answers every question of the call; a text that is one of the
  // options is picked as that option.
  const answers = Object.fromEntries(q.questions.map((x: any) => {
    const pick = x.options.find((o: string) => o.toLowerCase() === String(v.answer ?? "").toLowerCase());
    return [x.id, v.deny ? { picked: [] } : pick ? { picked: [pick] } : { picked: [], other: v.answer }];
  }));
  await c.post(`/api/sessions/${q.session_id}/questions/${q.call_id}`, { answers });
  if (v.json) console.log(JSON.stringify({ ok: true, question: q.call_id }));
  else console.log(v.deny ? "the question was left without an answer" : "answered");
  return EXIT.ok;
});

// ---- keel attach

const ATTACH_USAGE = `keel attach ID [--thoughts]
  Follows a session in this terminal. A typed line is a prompt; commands:
  /steer TEXT, /queue TEXT, /approve [once|session|always], /deny [REASON], /stop, /detach.
  Leaving (/detach, Ctrl-D or Ctrl-C) does not stop the session.`;

export async function attachTo(c: Client, sessionId: string, v: { thoughts?: boolean }): Promise<number> {
  const { events } = await c.get<{ events: StoredEvent[] }>(`/api/sessions/${sessionId}/events`);
  for (const e of events.slice(-20)) for (const l of textLines(e, v)) console.log(l);
  const s = await c.resolve(sessionId);
  console.error(`-- attached to ${sessionId} (${line(s.title) || "untitled"}); /detach leaves`);
  let seenCards = new Set<string>();
  const f = new Follower(c, sessionId, events.at(-1)?.seq ?? 0, (e) => { for (const l of textLines(e, v)) console.log(l); });
  await f.connect();
  process.on("SIGINT", () => (f.close(), process.exit(EXIT.ok)));
  const loop = (async () => {
    while (!f.closed) {
      await f.read().catch((e) => console.error(`keel attach: ${e.message}`));
      const st = await c.get<any>(`/api/cli/state/${sessionId}`).catch(() => null);
      for (const a of st?.approvals ?? []) {
        if (seenCards.has(a.id)) continue;
        seenCards.add(a.id);
        console.log(`?? approval: ${clean(a.tool)}: ${line(a.summary)}   (/approve or /deny)`);
      }
      seenCards = new Set([...seenCards].filter((id) => (st?.approvals ?? []).some((a: any) => a.id === id)));
      await f.pause(1500);
    }
  })();
  const card = async () => (await c.get<any>(`/api/cli/state/${sessionId}`)).approvals[0];
  for await (const raw of console) {
    const text = String(raw).trim();
    if (!text) continue;
    try {
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "/detach") break;
      else if (cmd === "/stop") await c.post(`/api/sessions/${sessionId}/interrupt`);
      else if (cmd === "/steer" || cmd === "/queue") await c.post(`/api/sessions/${sessionId}/messages`, { text: arg, mode: cmd.slice(1) });
      else if (cmd === "/approve" || cmd === "/deny") {
        const a = await card();
        if (!a) console.error("nothing is open");
        else await c.post(`/api/sessions/${a.session_id}/approvals/${a.id}`, cmd === "/deny" ? { choice: "deny", reason: arg || undefined } : { choice: ["session", "always"].includes(arg) ? arg : "once" });
      } else if (cmd!.startsWith("/") && !cmd!.startsWith("//")) console.error(`unknown command ${cmd}; /steer, /queue, /approve, /deny, /stop, /detach`);
      else await c.post(`/api/sessions/${sessionId}/messages`, { text: text.replace(/^\/\//, "/") });
    } catch (e) {
      console.error(`keel attach: ${(e as Error).message}`);
    }
  }
  f.close();
  await loop.catch(() => {});
  console.error(`-- detached; the session goes on (keel attach ${sessionId})`);
  return EXIT.ok;
}

const attach = command("attach", ATTACH_USAGE, { thoughts: { type: "boolean" } }, async (v, pos, c) => {
  if (!pos[0]) return usageError("attach", "name the session", ATTACH_USAGE);
  return attachTo(c, (await c.resolve(pos[0])).id, v);
});

// ---- keel open

const OPEN_USAGE = `keel open [DIR] [--resume ID] [--print-url] [-m MODEL]
  Opens the workbench on the directory's newest session (making one when it has none),
  or on the session named. The browser is KEEL_BROWSER, else the desktop's opener.`;

const open = command("open", OPEN_USAGE, { resume: { type: "string" }, "print-url": { type: "boolean" }, model: { type: "string", short: "m" }, provider: { type: "string" } }, async (v, pos, c) => {
  let s: any;
  if (v.resume) s = await c.resolve(v.resume);
  else {
    const dir = resolve(pos[0] ?? process.cwd());
    const { sessions: all } = await c.get<{ sessions: any[] }>("/api/sessions");
    s = all.filter((x) => !x.parent_id && x.workspace === dir).sort((a, b) => b.updated - a.updated)[0];
    if (!s) {
      const model = v.model ? (await c.get<{ model: string }>(`/api/cli/model?model=${encodeURIComponent(v.model)}${v.provider ? `&provider=${encodeURIComponent(v.provider)}` : ""}`)).model : undefined;
      s = (await c.post<{ session: any }>("/api/sessions", { workspace: dir, model })).session;
    }
  }
  const url = c.url(s.id);
  if (v.json) console.log(JSON.stringify({ session_id: s.id, url }));
  else console.log(url);
  if (!v["print-url"] && !openUrl(url)) console.error("keel open: no browser could be started; open the address above");
  return EXIT.ok;
});

// ---- keel resume

const RESUME_USAGE = `keel resume ID [PROMPT] [run options]
keel resume --last [PROMPT] [run options]
  Continues a session: with a prompt (or piped input) it runs like \`keel run --session ID\`
  (so -p, --output-format and --wait work); with neither, on a terminal, it attaches.
      --last    the newest session of this directory (or --cwd)

${RUN_USAGE.split("\n").slice(4).join("\n")}`;

const resumeCmd = command("resume", RESUME_USAGE, { ...RUN_OPTIONS, last: { type: "boolean" }, thoughts: { type: "boolean" } }, async (v, pos, c, found) => {
  const args = [...pos];
  if (!v.last && !args.length) return usageError("resume", "name the session, or pass --last", RESUME_USAGE);
  const target = v.last ? undefined : args.shift();
  const hasInput = args.length > 0 || !process.stdin.isTTY;
  if (!hasInput) {
    if (!(await c.alive())) throw new ApiError(`no daemon answers at ${c.base}: attaching needs one (keel serve); with a prompt the run starts its own`, 0);
    let id = target;
    if (!id) {
      const dir = resolve(v.cwd ?? process.cwd());
      const { sessions: all } = await c.get<{ sessions: any[] }>("/api/sessions");
      id = all.filter((x) => !x.parent_id && x.workspace === dir).sort((a, b) => b.updated - a.updated)[0]?.id;
      if (!id) throw new ApiError(`no session in ${dir}`, 404);
    }
    return attachTo(c, (await c.resolve(id)).id, v);
  }
  return runPrompt({ ...v, session: target, continue: v.last && !target ? true : undefined }, args, c, found, "resume");
});
const resume = (argv: string[]) => resumeCmd(worktreeArg(argv));

// ---- keel export

const EXPORT_USAGE = `keel export ID --format claude_code|codex [--json]
  Writes the session as a transcript Claude Code or Codex resumes, and prints the file,
  its directory and the resume command on lines of their own.`;
const exportCmd = command("export", EXPORT_USAGE, { format: { type: "string" } }, async (v, pos, c) => {
  if (!pos[0]) return usageError("export", "name the session", EXPORT_USAGE);
  if (v.format !== "claude_code" && v.format !== "codex") return usageError("export", "--format is claude_code or codex", EXPORT_USAGE);
  const s = await c.resolve(pos[0]);
  const r = await c.post<any>(`/api/sessions/${s.id}/export-to`, { format: v.format });
  if (v.json) return (console.log(JSON.stringify(r)), EXIT.ok);
  console.log(`wrote ${JSON.stringify(r.path)}\ndirectory ${JSON.stringify(r.cwd)}\nresume ${JSON.stringify(r.resume_command)}`);
  return EXIT.ok;
});

// ---- keel models

const MODELS_USAGE = `keel models [QUERY] [--provider P] [--refresh] [--json]
  The models the providers list now (the ids --model takes), the default marked with *.`;
const models = command("models", MODELS_USAGE, { provider: { type: "string" }, refresh: { type: "boolean" } }, async (v, pos, c) => {
  const r = await c.get<any>(`/api/models${v.refresh ? "?refresh=1" : ""}`);
  const q = pos.join(" ").toLowerCase();
  const list = r.models.filter((m: any) => (!v.provider || m.provider === v.provider) && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q)));
  if (v.json) return (printJson({ default: r.default, models: list }), EXIT.ok);
  for (const m of list) console.log(`${m.id === r.default ? "*" : " "} ${m.id.padEnd(52)} ${clean(m.name).padEnd(28)} ${Math.round(m.context / 1000)}k${m.efforts?.length ? `  effort ${m.efforts.join("/")}` : ""}`);
  if (!list.length) console.error("no model matches");
  return EXIT.ok;
});

export const sessionCommands = {
  sessions,
  ls: sessions,
  show: logsOf("show", SHOW_USAGE),
  logs: logsOf("logs", LOGS_USAGE),
  stop,
  send,
  approve,
  attach,
  open,
  resume,
  export: exportCmd,
  models,
};
