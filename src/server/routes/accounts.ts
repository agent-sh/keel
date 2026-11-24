// The owner's namespaces (src/safety/accounts.ts): what his config suggests he owns, read once when he asks. The list
// itself is the `accounts` section of the settings (PATCH /api/settings).
import type { RouteModule } from "../app.ts";
import { learnNamespaces } from "../../safety/account-learn.ts";
import { say } from "../../safety/accounts.ts";
import { accountNames } from "../../safety/account-settings.ts";

export const accountRoutes: RouteModule = ({ store }) => ({
  "/api/accounts/candidates": {
    GET: async () => {
      const rows = store.db.query<{ workspace: string }, []>("SELECT workspace FROM sessions ORDER BY updated DESC LIMIT 300").all();
      const folders = [...new Set(rows.map((r) => r.workspace))].slice(0, 120);
      const have = new Set(accountNames().map(say));
      const candidates = (await learnNamespaces(folders)).filter((c) => !have.has(c.namespace));
      return Response.json({ candidates });
    },
  },
});
