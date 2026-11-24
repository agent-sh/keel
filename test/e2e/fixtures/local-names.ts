// A preload for a daemon a spec starts (BUN_OPTIONS=--preload): the web tools refuse a local address, so a spec
// names its local server (WEB_STANDIN) as a public-looking host, and what the daemon fetches from that host is
// fetched from the server.
const real = globalThis.fetch;
const host = process.env.WEB_STANDIN_HOST;
if (host && process.env.WEB_STANDIN) {
  globalThis.fetch = ((input: any, init?: any) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    return real(typeof u === "string" && u.startsWith(`https://${host}/`) ? process.env.WEB_STANDIN + u.slice(`https://${host}`.length) : input, init);
  }) as typeof fetch;
}
