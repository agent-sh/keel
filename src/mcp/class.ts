// What kind of server a server is, for the guards that weigh where content
// comes from and where it goes: whether it returns outside content (pages,
// mail, issues, anything a stranger can write), whether it can send outward
// (a call's arguments may leave the machine), and whether it holds an account
// (it acts as the owner somewhere). Each answer is the owner's when the owner
// gave one (the config's `class`), else read from the config, else assumed.
//
// A server's own word lowers nothing: its tools' openWorldHint is a hint the
// server sets, and the MCP spec's default for it is true. So a local command
// is assumed to reach the network and to return outside content until the
// owner says it does not; a remote server does both by what it is.
import type { McpServerConfig } from "./config.ts";

export type ClassKey = "outside" | "sends" | "account";
export const CLASS_KEYS: ClassKey[] = ["outside", "sends", "account"];
// Where an answer came from.
export type ClassBy = "owner" | "config" | "assumed";
export type ServerClass = Record<ClassKey, { yes: boolean; by: ClassBy; why: string }>;

// Variable names that hold a credential.
const CREDENTIAL = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BEARER|AUTH|COOKIE|(^|_)PAT$/i;
const AUTH_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;

// What in the config says the server acts as someone, or nothing.
export function credentialOf(c: McpServerConfig, signedIn = false): string | undefined {
  if (signedIn) return "the owner signed in to it";
  if (c.oauth) return "its config has an OAuth sign-in";
  if (c.bearer_env) return `its config sends a bearer token from ${c.bearer_env}`;
  if (c.headers_helper) return "its config runs a headers helper";
  const header = [...Object.keys(c.headers ?? {}), ...Object.keys(c.headers_env ?? {})].find((h) => AUTH_HEADER.test(h));
  if (header) return `its config sends the ${header} header`;
  const named = [...Object.keys(c.env ?? {}), ...(c.env_vars ?? [])].find((k) => CREDENTIAL.test(k));
  if (named) return `its config gives it ${named}`;
  if (c.url) {
    try {
      const u = new URL(c.url);
      if (u.username || u.password) return "its address carries a user";
      if ([...u.searchParams.keys()].some((k) => CREDENTIAL.test(k))) return "its address carries a key";
    } catch {} // an address that does not parse carries nothing readable
  }
  return undefined;
}

export function classify(c: McpServerConfig, signedIn = false): ServerClass {
  const said = c.class ?? {};
  const owner = (k: ClassKey) => ({ yes: said[k]!, by: "owner" as const, why: said[k] ? "the owner said so" : "the owner said it does not" });
  const remote = !!c.url;
  const cred = credentialOf(c, signedIn);
  return {
    outside: said.outside !== undefined ? owner("outside")
      : remote ? { yes: true, by: "config", why: "a remote server answers with what it holds" }
      : { yes: true, by: "assumed", why: "a local command may fetch anything" },
    sends: said.sends !== undefined ? owner("sends")
      : remote ? { yes: true, by: "config", why: "every call's arguments go to its address" }
      : { yes: true, by: "assumed", why: "a local command may reach the network" },
    account: said.account !== undefined ? owner("account")
      : cred ? { yes: true, by: "config", why: cred }
      : { yes: false, by: "config", why: "its config names no credential" },
  };
}
