// Remote access: a browser on another device (through a tunnel or proxy the
// owner set up, its host in KEEL_ALLOWED_HOSTS) opens the link shown at the
// desk once; the token in it becomes an HttpOnly, SameSite=Strict cookie and
// every later request carries it. The desk alone sees the link.
import { accessToken, hasToken } from "../admission.ts";
import { isLocal } from "../../safety/presence.ts";
import type { RouteModule } from "../app.ts";

const COOKIE_S = 400 * 24 * 3600; // the longest a browser keeps a cookie

export const remoteRoutes: RouteModule = () => ({
  "/api/remote-access": {
    GET: (req: Request) =>
      isLocal(req)
        ? Response.json({ path: `/api/remote/enter?token=${encodeURIComponent(accessToken())}`, hosts: (process.env.KEEL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean) })
        : Response.json({ error: "the remote access link is shown at the desk only" }, { status: 403 }),
  },
  "/api/remote/enter": {
    GET: (req: Request) => {
      if (!hasToken(req, true)) return Response.json({ error: "that link is not this daemon's" }, { status: 403 });
      const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `keel_token=${encodeURIComponent(accessToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_S}${secure ? "; Secure" : ""}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    },
  },
});
