// The fleet's tools for every family: what machines the session can use, and
// one shell command on another machine without moving the session.
import { registerShared } from "../tools/registry.ts";
import { fail, ok, type Tool } from "../tools/types.ts";
import type { Fleet } from "./fleet.ts";
import { remoteRun } from "./remote.ts";

let fleet: Fleet | undefined;
export const bindFleetTools = (f: Fleet) => void (fleet = f);

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
  async run(input, ctx) {
    if (!fleet) return fail("The fleet is not running.");
    const m = fleet.byName(String(input.machine ?? ""));
    if (!m) return fail(`No machine named ${input.machine}. Known: ${fleet.rows().map((r) => r.name).join(", ") || "none"}.`);
    if (!m.workspace_root) return fail(`${m.name} has no granted directory: the owner sets one in Settings, Machines.`);
    const release = await fleet.acquire(m.id, ctx.signal).catch((e) => e as Error);
    if (release instanceof Error) return fail(release.message);
    try {
      const out = await remoteRun(fleet, m, ctx, { tool: "Bash", input: { command: String(input.command) }, cwd: input.cwd });
      const text = typeof out.content === "string" ? out.content : out.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
      return { content: `[ran on ${m.name}]\n${text}`, is_error: out.is_error };
    } finally {
      release();
    }
  },
};

registerShared(machinesList, runOn);
