// The porting lane's place in the workbench: Customize > Bring your setup, a
// palette command and /port.
import { ArrowDownToLine } from "lucide-react";
import { createElement, lazy } from "react";
import { settingsSections, slash } from "./extend.ts";
import { navigate } from "./ui.ts";

settingsSections.add({
  id: "port",
  label: "Bring your setup",
  words: "port import migrate claude code codex hermes rust keel skills plugins memory hooks mcp instructions sessions",
  icon: createElement(ArrowDownToLine, { className: "size-4" }),
  order: 45,
  component: lazy(() => import("../components/PortPanel.tsx").then((m) => ({ default: m.PortSettings }))),
});

const open = () => navigate({ name: "customize", section: "port" });
slash.add({ id: "port", label: "Bring your setup from Claude Code, Codex, Hermes or the Rust Keel", run: () => void open() });
