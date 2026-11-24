// A request the built-in fetch makes to a name it has vetted. The name is
// resolved once, every address it gives must be on the public internet (a
// public name can point inside, and a name can answer differently the second
// time), and the request goes to an address that was vetted, with the name
// kept for the Host header and the certificate. The ledger gets one row for
// the request, under the name asked for.
import dns from "node:dns/promises";
import { addressBytes, internalAddress } from "../core/hosts.ts";
import { noteOutward, outward } from "../safety/egress.ts";
import { requestBytes } from "../safety/egress-count.ts";

export type Reached = { res: Response } | { refused: string };

// The addresses a name has, IPv4 first (the one connected to is the first).
async function addressesOf(host: string): Promise<string[]> {
  if (addressBytes(host)) return [host.replace(/^\[|\]$/g, "")];
  const all = await dns.lookup(host, { all: true, verbatim: true });
  return all.sort((a, b) => a.family - b.family).map((a) => a.address);
}

// One request to `address` for the URL's name: the URL is made with the
// address, the Host header and the TLS server name are the name's.
export function pinnedFetch(u: URL, address: string, init: RequestInit, tls?: { ca?: string }): Promise<Response> {
  const to = new URL(u.href);
  to.hostname = address.includes(":") ? `[${address}]` : address;
  const headers = new Headers(init.headers);
  headers.set("host", u.host);
  return fetch(to.href, { ...init, headers, ...(u.protocol === "https:" ? { tls: { serverName: u.hostname, ...tls } } : {}) } as RequestInit);
}

export async function vettedFetch(u: URL, init: RequestInit, via = "web fetch"): Promise<Reached> {
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const row = (o: Omit<Parameters<typeof noteOutward>[0], "host">) => noteOutward({ via, host: u.hostname, port, ...o });
  let addresses: string[];
  try { addresses = await addressesOf(u.hostname); } catch (e) {
    row({ bytes: 0, outcome: "failed", why: `the name did not resolve: ${(e as Error).message}` });
    throw new Error(`${u.hostname} did not resolve: ${(e as Error).message}`);
  }
  if (!addresses.length) {
    row({ bytes: 0, outcome: "failed", why: "the name has no address" });
    throw new Error(`${u.hostname} has no address`);
  }
  const inside = addresses.find(internalAddress);
  if (inside) {
    row({ bytes: 0, outcome: "refused", why: "a name that resolves to a local or private address" });
    return { refused: `${u.hostname} resolves to a local or private address (${inside}); reach local servers with curl in the shell.` };
  }
  const bytes = requestBytes({ method: init.method, url: u.href, headers: init.headers, body: init.body });
  let last: unknown;
  for (const address of addresses) {
    try {
      // (This function records the request: the daemon's own count of fetches would name the address.)
      const res = await outward({ counted: true }, () => pinnedFetch(u, address, init));
      row({ bytes, outcome: "sent", status: res.status });
      return { res };
    } catch (e) {
      last = e;
      if (init.signal?.aborted) break;
    }
  }
  row({ bytes, outcome: "failed", why: String((last as Error)?.message ?? last) });
  throw last;
}
