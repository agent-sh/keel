// Whether an MCP server acts as the owner somewhere (it holds an account): its config sends a credential (an OAuth
// sign-in, a bearer token, an authorization header, a key or token in its environment or address). The owner's own
// answer (`class.account` in the server's config) wins over what the config shows. A write by such a server's tool is
// the owner's to allow in every mode (src/safety/accounts.ts).
import type { McpServerConfig } from "./config.ts";

const CREDENTIAL = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BEARER|AUTH|COOKIE|(^|_)PAT$/i;
const AUTH_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;

export function holdsAccount(c: McpServerConfig & { class?: { account?: boolean } }): boolean {
  if (typeof c.class?.account === "boolean") return c.class.account;
  if (c.oauth || c.bearer_env || c.headers_helper) return true;
  if ([...Object.keys(c.headers ?? {}), ...Object.keys(c.headers_env ?? {})].some((h) => AUTH_HEADER.test(h))) return true;
  if ([...Object.keys(c.env ?? {}), ...(c.env_vars ?? [])].some((k) => CREDENTIAL.test(k))) return true;
  if (c.url) {
    try {
      const u = new URL(c.url);
      if (u.username || u.password || [...u.searchParams.keys()].some((k) => CREDENTIAL.test(k))) return true;
    } catch { /* an address that does not parse carries nothing readable */ }
  }
  return false;
}
