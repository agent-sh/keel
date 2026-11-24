// Names for a local server. The web tools refuse a local address and a name that resolves to one, so a spec (or a
// unit test) names its server as a host that resolves to a public address, and what the tools send to that address
// for that name (found by the Host header, as the tools connect) is sent to the server instead.
// As a preload for a daemon a spec starts (BUN_OPTIONS=--preload), the host is WEB_STANDIN_HOST and the server
// WEB_STANDIN.
import dns from "node:dns/promises";

export const PUBLIC = "93.184.216.34";

// `server`: where it goes (its origin), else the server on the port of the address asked for. `answers`: what the
// name resolves to, asked each time (a test may change it between asks). The server is told the address the tools
// connected to in `x-pinned-to`.
export function nameLocal(host: string, server?: string, answers: () => string[] = () => [PUBLIC]): () => void {
  const lookup = dns.lookup, real = globalThis.fetch;
  (dns as any).lookup = async (name: string, ...rest: any[]) =>
    name === host ? answers().map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) : (lookup as any)(name, ...rest);
  globalThis.fetch = ((input: any, init?: any) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const headers = new Headers(init?.headers);
    if (typeof u === "string" && headers.get("host")?.replace(/:\d+$/, "") === host) {
      const at = new URL(u);
      headers.set("x-pinned-to", at.hostname.replace(/^\[|\]$/g, ""));
      return real((server ?? `http://127.0.0.1:${at.port}`) + at.pathname + at.search, { ...init, headers, tls: undefined });
    }
    return real(input, init);
  }) as typeof fetch;
  return () => { (dns as any).lookup = lookup; globalThis.fetch = real; };
}

if (process.env.WEB_STANDIN_HOST && process.env.WEB_STANDIN) nameLocal(process.env.WEB_STANDIN_HOST, process.env.WEB_STANDIN);
