// The most an agent definition file may hold: a larger one is not read (src/automation/agents.ts),
// and the health check says so (src/admin/health-file-rules.ts).
export const AGENT_FILE_MAX = 32 * 1024;
