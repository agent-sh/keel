// A provider's status page, and the incident open on it. The page is the owner's
// to name (Settings: `status_pages.pages`, a provider id to its status page URL):
// models.dev's provider entries carry no status page, and none is written into
// the code. For a page of Atlassian Statuspage's kind (the status page of most
// providers), its own JSON lists the unresolved incidents; for any other page the
// link is all there is. A read is bounded, cached for a few minutes, and a page
// that does not answer says nothing: the notice then names the page alone.
import { registerSettings, settings } from "../admin/settings.ts";

export type StatusIncident = { title: string; url: string; impact?: string };
export type Status = { page: string; incident?: StatusIncident };

const httpUrl = (v: unknown) => {
  try { const u = new URL(String(v)); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
};
registerSettings("status_pages", { pages: {} }, (v) => {
  const p = v.pages;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "pages maps a provider id to its status page URL";
  const bad = Object.entries(p).find(([, u]) => !httpUrl(u));
  return bad ? `the status page of ${bad[0]} is not an http(s) URL` : undefined;
});

// The status page the owner named for a provider.
export function statusPageOf(provider: string): string | undefined {
  const u = settings().status_pages?.pages?.[provider];
  return typeof u === "string" && httpUrl(u) ? u.replace(/\/+$/, "") : undefined;
}

const IMPACT = ["critical", "major", "minor", "maintenance", "none"];
const READ_MS = 5_000;
const KEEP_MS = 3 * 60_000;

// The page's unresolved incidents, the worst first (Statuspage: /api/v2/incidents/unresolved.json).
export async function openIncident(page: string, get: typeof fetch = fetch): Promise<StatusIncident | undefined> {
  try {
    const r = await get(`${page}/api/v2/incidents/unresolved.json`, { signal: AbortSignal.timeout(READ_MS), headers: { accept: "application/json" } });
    if (!r.ok) return undefined;
    const list = ((await r.json()) as { incidents?: any[] }).incidents;
    if (!Array.isArray(list)) return undefined;
    const worst = [...list].filter((i) => i && typeof i.name === "string").sort((a, b) => IMPACT.indexOf(a.impact) - IMPACT.indexOf(b.impact))[0];
    if (!worst) return undefined;
    return { title: worst.name.slice(0, 200), url: typeof worst.shortlink === "string" ? worst.shortlink : page, ...(typeof worst.impact === "string" ? { impact: worst.impact } : {}) };
  } catch { return undefined; }
}

type Kept = { at: number; incident?: StatusIncident };
const kept = new Map<string, Kept>();
const reading = new Map<string, Promise<Kept>>();

// The incident as last read (undefined: none, or not read yet).
export const incidentNow = (page: string): StatusIncident | undefined => kept.get(page)?.incident;

// Reads the page's incident unless a read of the last few minutes holds it.
export function readStatus(page: string, get: typeof fetch = fetch, now = Date.now()): Promise<Kept> {
  const k = kept.get(page);
  if (k && now - k.at < KEEP_MS) return Promise.resolve(k);
  let p = reading.get(page);
  if (!p) {
    p = openIncident(page, get).then((incident) => {
      const r = { at: Date.now(), incident };
      kept.set(page, r);
      return r;
    }).finally(() => reading.delete(page));
    reading.set(page, p);
  }
  return p;
}

// What a provider's notice names: its page, and the incident last read there.
export function statusOf(provider: string): Status | undefined {
  const page = statusPageOf(provider);
  return page ? { page, ...(incidentNow(page) ? { incident: incidentNow(page) } : {}) } : undefined;
}

// Whether a read of the page was made (its incident, if any, is as it was last read), and whether it is recent.
export const statusKnown = (page: string) => kept.has(page);
export const statusFresh = (page: string, now = Date.now()) => now - (kept.get(page)?.at ?? 0) < KEEP_MS;

export const forgetStatus = () => { kept.clear(); reading.clear(); };
