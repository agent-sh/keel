// How this process runs the daemon. `client` is a daemon a command (`keel run`
// with no daemon answering) started inside its own process: it runs only the
// sessions the command works on. It claims no Loop, recovers no other
// session's turn, wait or agent, connects no fleet machine or MCP server
// ahead of use, applies no archive rule and fetches no model listing at start.
const g = globalThis as { __keelRunMode?: { client: boolean } };
export const runMode: { client: boolean } = (g.__keelRunMode ??= { client: false });
