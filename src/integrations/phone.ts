// Phone control: the Hermes Android app's Accessibility service, as a server
// Keel brings itself (server `phone`, no process of its own).
//
// The Hermes gateway's mobile platform owns the phone's connection: the paired
// app fetches its commands there, and only while the owner has armed control on
// the phone. The gateway serves the same commands to agents on its machine on an
// owner-only Unix socket (<HERMES_HOME>/mobile/phone.sock): one JSON line in
// ({"op":"status"} or {"op":"call","args":{...}} with the phone_use arguments),
// one JSON line out. Keel uses that socket, so there is one phone connection and
// the gateway's rules hold:
// - it acts only while the owner has armed control on the phone; nothing Keel
//   sends can arm it;
// - the owner's Stop on the phone ends a call in flight, and Keel never retries
//   around it;
// - a call Keel stops (its turn was stopped) hangs up, and the gateway drops it.
//
// The tool list ships with Keel (phone_tools.json), one tool per action, so the
// gate tells a screen read from an act by the tool's name: reads follow the read
// rules, every other tool goes to the gate like a write. Before the gate, every
// call asks the gateway afresh whether control is armed: a phone that is not
// armed gets the plain reason and no card.
import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { McpManager, McpState } from "../mcp/manager.ts";
import type { McpTool } from "../mcp/client.ts";
import { toOutput } from "../mcp/result.ts";
import type { ToolContext, ToolOutput } from "../tools/types.ts";
import shipped from "./phone_tools.json" with { type: "json" };

export const PHONE_SERVER = "phone";
const ARM_HOW = "Hermes app on the phone: Me > This phone > Control";
const PROBE_MS = 5000;

// Where the gateway serves phone control: KEEL_PHONE_SOCKET, else
// $HERMES_HOME/mobile/phone.sock, else ~/.hermes/mobile/phone.sock. The socket
// need not exist yet (the gateway may start later); the Hermes home must.
export function discoverPhone(home: string, env: (k: string) => string | undefined): { socket: string } | { error: string } {
  const set = (k: string) => env(k)?.trim() || undefined;
  const given = set("KEEL_PHONE_SOCKET");
  if (given) return { socket: given };
  // A daemon with a config folder of its own (a scratch or test daemon) never
  // reaches the owner's gateway by default: it looks beside that folder.
  const own = set("KEEL_CONFIG_DIR");
  if (!set("HERMES_HOME") && own) return { socket: join(own, "..", "phone/phone.sock") };
  const hermes = set("HERMES_HOME") ?? join(home, ".hermes");
  try {
    if (statSync(hermes).isDirectory()) return { socket: join(hermes, "mobile/phone.sock") };
  } catch {}
  return { error: `Hermes was not found (${hermes} does not exist): phone control needs the Hermes gateway with its mobile platform on this machine and the Hermes app paired on the phone; or set KEEL_PHONE_SOCKET to the gateway's phone.sock` };
}

export const notArmed = () =>
  `Phone control is not armed, so nothing was sent to the phone. Only the owner can arm it (${ARM_HOW}); Keel cannot. Tell the owner if the task needs the phone, and do not call phone tools again until they say control is on.`;
const stopped = (why: string) =>
  `The owner stopped phone control on the phone (${why}), so this call ended. Whether the action took effect is unknown. Do not retry it or call phone tools again until the owner arms control again (${ARM_HOW}).`;
const unreachable = (socket: string, why: string) =>
  `Phone control is not reachable, so nothing was sent to the phone: the Hermes gateway does not answer at ${socket} (${why}). It needs the Hermes gateway running with its mobile platform, in a version that serves phone.sock.`;
export const TURNED_OFF = "Phone control is turned off in Keel, so nothing was sent to the phone. Only the owner can turn it on (MCP servers > phone > turn on). Tell the owner if the task needs the phone.";

// The gateway's words for control ending under a call.
export const isStop = (e: string) => ["disarmed", "revoked", "re-armed", "control changed", "command cancelled"].some((w) => e.toLowerCase().includes(w));

export type PhoneStatus = { state: "unknown" | "armed" | "not_armed" | "unreachable"; why?: string };

// One request on the socket; rejects with why the gateway could not be reached.
export function exchange(socket: string, request: object, signal?: AbortSignal, limitMs?: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!existsSync(socket)) return reject(new Error("no socket there"));
    const c = createConnection({ path: socket });
    let buf = "";
    let done = false;
    const end = (f: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      c.destroy();
      f();
    };
    const onAbort = () => end(() => reject(Object.assign(new Error("the call was stopped"), { aborted: true })));
    const timer = limitMs ? setTimeout(() => end(() => reject(new Error(`no answer in ${Math.round(limitMs / 1000)} s`))), limitMs) : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    c.on("connect", () => c.write(JSON.stringify(request) + "\n"));
    c.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      end(() => {
        try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`the gateway's answer is not JSON: ${(e as Error).message}`)); }
      });
    });
    c.on("end", () => end(() => (buf.trim() ? resolve(JSON.parse(buf)) : reject(new Error("the gateway closed the connection without an answer")))));
    c.on("error", (e) => end(() => reject(e)));
  });
}

const mimeOf = (b64: string) => (b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("R0lG") ? "image/gif" : b64.startsWith("UklG") ? "image/webp" : "image/jpeg");

export class Phone {
  status: PhoneStatus = { state: "unknown" };
  readonly actions = new Map<string, string>((shipped.tools as any[]).map((t) => [t.name, t.action]));
  readonly reads = new Set<string>(shipped.reads);

  constructor(readonly socket: string, private off: () => boolean) {}

  async refresh(): Promise<PhoneStatus> {
    try {
      const v = await exchange(this.socket, { op: "status" }, undefined, PROBE_MS);
      this.status = v?.ok === true ? { state: v.armed === true ? "armed" : "not_armed" } : { state: "unreachable", why: String(v?.error ?? "refused") };
    } catch (e) {
      this.status = { state: "unreachable", why: (e as Error).message };
    }
    return this.status;
  }

  // Why a call must not reach the gate at all; asked afresh for every call, so
  // a phone armed a moment ago is used at once.
  async refusal(): Promise<string | null> {
    if (this.off()) return TURNED_OFF;
    const s = await this.refresh();
    if (s.state === "not_armed") return notArmed();
    if (s.state === "unreachable") return unreachable(this.socket, s.why ?? "no answer");
    return null;
  }

  async call(tool: string, input: any, ctx: ToolContext): Promise<ToolOutput> {
    const action = this.actions.get(tool);
    if (!action) return { content: `Error: unknown phone tool ${tool}`, is_error: true };
    if (this.off()) return { content: TURNED_OFF, is_error: true };
    let answer: any;
    try {
      answer = await exchange(this.socket, { op: "call", args: { ...(input ?? {}), action } }, ctx.signal);
    } catch (e) {
      if ((e as any).aborted) return { content: "The call was stopped before the phone answered; the gateway drops it. Whether it took effect is unknown: read phone_state before acting again.", is_error: true };
      this.status = { state: "unreachable", why: (e as Error).message };
      return { content: unreachable(this.socket, (e as Error).message), is_error: true };
    }
    if (answer?.ok !== true) {
      const why = String(answer?.error ?? "the phone refused the command");
      if (why.includes("not armed")) {
        this.status = { state: "not_armed" };
        return { content: notArmed(), is_error: true };
      }
      if (isStop(why)) {
        this.status = { state: "not_armed" };
        return { content: stopped(why), is_error: true };
      }
      return { content: `Error [PHONE]: ${why}`, is_error: true };
    }
    const r = answer.result;
    const text = typeof r === "string" ? r : r === null || r === undefined ? "done" : JSON.stringify(r);
    const content: any[] = [{ type: "text", text }];
    if (typeof answer.image === "string" && answer.image) content.push({ type: "image", data: answer.image, mimeType: mimeOf(answer.image) });
    return toOutput({ content } as any, ctx, `${PHONE_SERVER}__${tool}`);
  }
}

// The McpManager state of phone control, from what the gateway last said.
const STATE: Record<PhoneStatus["state"], McpState> = { unknown: "idle", armed: "armed", not_armed: "not_armed", unreachable: "unreachable" };

export function installPhone(m: McpManager, home = process.env.HOME ?? "", env: (k: string) => string | undefined = (k) => process.env[k]) {
  const found = discoverPhone(home, env);
  const tools = (shipped.tools as any[]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) as McpTool[];
  const phone = "socket" in found ? new Phone(found.socket, () => m.isOff(PHONE_SERVER)) : null;
  m.addBundled(PHONE_SERVER, {
    label: "Phone control",
    config: null,
    missing: "error" in found ? found.error : undefined,
    tools,
    instructions: shipped.instructions,
    reads: (tool) => !!phone?.reads.has(tool),
    live: phone
      ? {
          state: () => ({ state: STATE[phone.status.state], error: phone.status.state === "unreachable" ? `The Hermes gateway does not answer at ${phone.socket} (${phone.status.why ?? "no answer"}).` : phone.status.state === "not_armed" ? `Not armed: only the owner arms it (${ARM_HOW}).` : undefined }),
          check: async () => void (await phone.refresh()),
          target: phone.socket,
        }
      : undefined,
    async judge(tool) {
      if (!phone) return { kind: "refused", why: "error" in found ? found.error : "phone control is not set up" };
      const why = await phone.refusal();
      if (why) return { kind: "refused", why };
      return phone.reads.has(tool) ? { kind: "read" } : { kind: "other" };
    },
    call: (tool, input, ctx) => (phone ? phone.call(tool, input, ctx) : Promise.resolve({ content: "error" in found ? found.error : "phone control is not set up", is_error: true })),
  });
  if (phone && !m.isOff(PHONE_SERVER)) void phone.refresh();
  return phone;
}
