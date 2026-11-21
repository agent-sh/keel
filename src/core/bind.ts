// The HOST:PORT a daemon listens on (--bind). The port is a whole number from
// 0 (any free port) to 65535; anything else is said before a daemon starts.
export function parseBind(bind: string): { hostname: string; port: number } | { error: string } {
  const m = /^(.*):(\d+)$/.exec(bind);
  const port = m ? Number(m[2]) : NaN;
  if (!m || port > 65535) return { error: `--bind is HOST:PORT with a port from 0 to 65535, not ${JSON.stringify(bind)}` };
  return { hostname: m[1]!, port };
}
