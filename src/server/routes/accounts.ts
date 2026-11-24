// The owner's namespaces (src/safety/accounts.ts): what his config suggests he owns, read once when he asks. The list
// itself is the `accounts` section of the settings (PATCH /api/settings).
import type { RouteModule } from "../app.ts";
import { learnNamespaces } from "../../safety/account-learn.ts";
import { say } from "../../safety/accounts.ts";
import { accountNames, addNamespace } from "../../safety/account-settings.ts";
import { readsOf } from "../reads.ts";

export const accountRoutes: RouteModule = ({ store }) => ({
  "/api/accounts/candidates": {
    GET: async () => {
      // (Off the loop: the sessions table can be long.)
      const rows = await readsOf(store).sql<{ workspace: string }>("SELECT workspace FROM sessions ORDER BY updated DESC LIMIT 300");
      const folders = [...new Set(rows.map((r) => r.workspace))].slice(0, 120);
      const have = new Set(accountNames().map(say));
      const candidates = (await learnNamespaces(folders)).filter((c) => !have.has(c.namespace));
      return Response.json({ candidates });
    },
  },
  // One namespace more: what "Mine" on a card adds.
  "/api/accounts/namespaces": {
    POST: async (req: Request) => {
      const b = (await req.json().catch(() => ({}))) as { namespace?: unknown };
      if (typeof b.namespace !== "string") return Response.json({ error: "namespace is a string" }, { status: 400 });
      const r = addNamespace(b.namespace);
      return r.ok ? Response.json(r) : Response.json({ error: r.error }, { status: 400 });
    },
  },
});
