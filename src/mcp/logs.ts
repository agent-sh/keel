// A server's own log (2025-11-25 server/utilities/logging): Keel asks a server
// that declares logging for its lines at `info` and up (logging/setLevel), keeps
// the latest of them for its row in the MCP panel, and puts those at `error` and
// up in the Errors panel. The 2026-07-28 revision deprecates the feature (a
// server logs to stderr, or to OpenTelemetry), so a modern server is not asked;
// the lines it still sends are kept the same way.

import { conceal } from "../core/conceal.ts";
import { maskProxy } from "./env.ts";

// The syslog levels the spec takes, mildest first.
export const LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
export type Level = (typeof LEVELS)[number];
// What Keel asks for: the server's own account of what it does, without its debugging.
export const ASKED: Level = "info";

export type LogLine = { ts: number; level: Level; logger?: string; text: string };

// The latest lines a server's row shows; older ones go first.
export const LOG_KEPT = 200;
// The most of one line that is kept: its data can be any JSON, of any size.
export const LINE_MAX = 4000;

// A secret value the vault knows is shown as its placeholder (a server may log the token it was given).
export function logLine(params: { level?: unknown; logger?: unknown; data?: unknown }, ts = Date.now()): LogLine {
  const level = (LEVELS as readonly unknown[]).includes(params.level) ? (params.level as Level) : "info";
  const raw = conceal(maskProxy(typeof params.data === "string" ? params.data : JSON.stringify(params.data) ?? ""));
  const text = raw.length > LINE_MAX ? `${raw.slice(0, LINE_MAX)}... (${raw.length - LINE_MAX} more characters)` : raw;
  return { ts, level, ...(typeof params.logger === "string" && params.logger ? { logger: conceal(params.logger.slice(0, 200)) } : {}), text };
}

// Whether a line is a failure the Errors panel shows.
export const severe = (l: Level) => LEVELS.indexOf(l) >= LEVELS.indexOf("error");
