import { afterAll, expect, test } from "bun:test";
import { bodyOf, IncidentBook } from "../automation/incident-book.ts";
import { forgetStatus, openIncident, readStatus, statusOf, statusPageOf } from "./status.ts";
import { patchSettings } from "../admin/settings.ts";

const hits: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    hits.push(new URL(req.url).pathname);
    if (new URL(req.url).pathname !== "/api/v2/incidents/unresolved.json") return new Response("no", { status: 404 });
    return Response.json({ incidents: [
      { name: "Minor delays", impact: "minor", shortlink: "https://stat.us/minor" },
      { name: "Elevated errors", impact: "critical", shortlink: "https://stat.us/crit" },
    ] });
  },
});
afterAll(() => { server.stop(true); patchSettings({ status_pages: null }); });
const page = `http://127.0.0.1:${server.port}`;

test("the open incident is the worst one the page's own JSON lists, and a page that does not answer says nothing", async () => {
  expect(await openIncident(page)).toEqual({ title: "Elevated errors", url: "https://stat.us/crit", impact: "critical" });
  expect(await openIncident(`${page}/missing`)).toBeUndefined();
  expect(await openIncident("http://127.0.0.1:9")).toBeUndefined();
});

test("a provider has a status page only where the owner named one, and a read is kept", async () => {
  forgetStatus();
  expect(statusPageOf("acme")).toBeUndefined();
  expect(statusOf("acme")).toBeUndefined();
  expect(patchSettings({ status_pages: { pages: { acme: "not a url" } } }).ok).toBe(false);
  expect(patchSettings({ status_pages: { pages: { acme: `${page}/` } } }).ok).toBe(true);
  expect(statusPageOf("acme")).toBe(page);
  expect(statusOf("acme")).toEqual({ page });
  hits.length = 0;
  await readStatus(page);
  await readStatus(page);
  expect(hits).toHaveLength(1);
  expect(statusOf("acme")).toEqual({ page, incident: { title: "Elevated errors", url: "https://stat.us/crit", impact: "critical" } });
});

test("an incident's alert body names the page and the open incident", () => {
  const book = new IncidentBook();
  const i = book.held({ key: "provider:acme", label: "Acme", since: 1, message: "dns", sessions: [{ id: "s1", title: "One" }], long: true }, 2);
  expect(bodyOf(i)).not.toContain("Status page");
  i.status = { page, incident: { title: "Elevated errors", url: "https://stat.us/crit" } };
  expect(bodyOf(i)).toContain(`Status page: ${page}. Open there: Elevated errors (https://stat.us/crit).`);
  i.status = { page };
  expect(bodyOf(i).endsWith(`Status page: ${page}.`)).toBe(true);
});
