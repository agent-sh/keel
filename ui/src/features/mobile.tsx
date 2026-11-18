// The mobile lane's place in the workbench: Settings > Phone and a command.
import { Smartphone } from "lucide-react";
import { lazy } from "react";
import { settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { navigate } from "../lib/ui.ts";

settingsSections.add({
  id: "phone",
  label: "Phone",
  words: "mobile pair qr device push notification hermes revoke",
  icon: <Smartphone className="size-4" />,
  order: 40,
  component: lazy(() => import("../components/PhonePanel.tsx").then((m) => ({ default: m.PhoneSettings }))),
});

registerCommand({ id: "phone", label: "Pair a phone", group: "General", words: "mobile qr push device", run: () => navigate({ name: "settings", section: "phone" }) });
