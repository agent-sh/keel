// The toolkit pages of Settings: what the daemon loads, each from its files.
// (Agents and Hooks register from their own lanes' modules, on these pages.)
import { BookOpenText, Puzzle, ScrollText, Server, SquareSlash } from "lucide-react";
import { createElement, lazy } from "react";
import { settingsSections } from "./extend.ts";

const icon = (c: typeof Server) => createElement(c, { className: "size-4" });
settingsSections.add(
  { id: "mcp", label: "MCP servers", words: "mcp servers tools connect oauth sign in reads import", icon: icon(Server), order: 10, component: lazy(() => import("../components/surfaces/Mcp.tsx")) },
  { id: "skills", label: "Skills", words: "skills skill.md agent skills tokens", icon: icon(BookOpenText), order: 11, component: lazy(() => import("../components/surfaces/Skills.tsx")) },
  { id: "commands", label: "Commands", words: "slash commands command files prompts", icon: icon(SquareSlash), order: 12, component: lazy(() => import("../components/surfaces/Commands.tsx")) },
  { id: "plugins", label: "Plugins", words: "plugins provider plugins plugins.toml protocol check bundled", icon: icon(Puzzle), order: 14, component: lazy(() => import("../components/surfaces/Plugins.tsx")) },
  { id: "instructions", label: "Instructions", words: "agents.md claude.md instructions memory files imports prompt", icon: icon(ScrollText), order: 16, component: lazy(() => import("../components/surfaces/Instructions.tsx")) },
);
