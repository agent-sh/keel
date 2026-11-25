// The installable app: manifest, icons and a service worker that keeps the
// page shell for when the daemon is unreachable. The files are imported so
// they are embedded in the compiled binary.
import apple from "../../../ui/public/apple-touch-180.png" with { type: "file" };
import icon192 from "../../../ui/public/icon-192.png" with { type: "file" };
import icon512 from "../../../ui/public/icon-512.png" with { type: "file" };
import iconSvg from "../../../ui/public/icon.svg" with { type: "file" };
import maskable from "../../../ui/public/maskable-512.png" with { type: "file" };
import type { RouteModule } from "../app.ts";

const manifest = {
  name: "Keel",
  short_name: "Keel",
  description: "A coding agent workbench",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f7faf9",
  theme_color: "#f7faf9",
  // (The page's own icon, /icons/icon.svg, is the bare mark for a tab: an installed page gets the ones with a ground.)
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

// Hashed assets are served from the cache first; the page itself goes to the
// network first and falls back to the last copy, so a phone opens the shell
// while the daemon is out of reach and reconnects on its own.
const SW = `const C = "keel-shell-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  const u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname === "/ws" || u.pathname === "/sw.js") return;
  if (r.mode === "navigate") {
    e.respondWith(fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(C).then((x) => x.put("/", c)); } return res; }).catch(() => caches.match("/")));
    return;
  }
  e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(C).then((x) => x.put(r, c)); } return res; })));
});
`;

const file = (path: string, type: string) => () =>
  new Response(Bun.file(path), { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });

export const pwaRoutes: RouteModule = () => ({
  "/manifest.webmanifest": { GET: () => Response.json(manifest, { headers: { "content-type": "application/manifest+json" } }) },
  "/sw.js": { GET: () => new Response(SW, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } }) },
  "/icons/icon.svg": { GET: file(iconSvg, "image/svg+xml") },
  "/icons/icon-192.png": { GET: file(icon192, "image/png") },
  "/icons/icon-512.png": { GET: file(icon512, "image/png") },
  "/icons/maskable-512.png": { GET: file(maskable, "image/png") },
  "/icons/apple-touch-180.png": { GET: file(apple, "image/png") },
});
