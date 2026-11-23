// Extension points of the workbench. A feature lane registers here from its
// own module (imported once from main.tsx) instead of editing the shell.
import type { ComponentType, ReactNode } from "react";
import type { Session, StoredEvent } from "../../../src/core/types.ts";

function registry<T extends { id: string }>() {
  const items = new Map<string, T>();
  const subs = new Set<() => void>();
  let v = 0;
  return {
    // Module load order decides who adds first, so a listed-only entry (a
    // slash command named before its lane builds it, no `run`) never replaces
    // a working one, whichever order they arrive in.
    add(...list: T[]) {
      for (const i of list) {
        const prev = items.get(i.id) as { run?: unknown } | undefined;
        if (prev?.run && !(i as { run?: unknown }).run) continue;
        items.set(i.id, i);
      }
      v++;
      subs.forEach((f) => f());
    },
    all: () => [...items.values()],
    version: () => v,
    subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  };
}

// Slash commands of the message box. `run` gets the text after the command;
// an item without `run` is listed as not available yet.
// `run` may throw an Error with `usage: true` for a mistyped argument: the box
// shows it and it is not recorded in Errors.
export type SlashItem = {
  id: string; // the word after the slash
  label: string;
  hint?: string; // argument shape, e.g. "<name>"
  run?: (arg: string, ctx: SlashCtx) => void | Promise<void>;
  when?: (ctx: SlashCtx) => boolean;
  // It starts a turn in the session (a prompt for the model): held while
  // another branch is previewed, like a typed message.
  sends?: true;
};
// `start`: in the start box, where no session exists yet, it starts one (in the folder, model
// and machine picked there) and opens it; a command that can run in a new session calls it.
// Absent where a session is open, and where the box cannot start one here.
export type SlashCtx = { session?: Session; setText: (t: string) => void; start?: () => Promise<Session> };
export const slash = registry<SlashItem>();

// Sections of the settings page. `words` are what the settings search matches.
// `find`: names of rows a section draws at run time (an MCP server, a hook), read when Find a setting is typed in.
export type SettingsSection = { id: string; label: string; words?: string; icon?: ReactNode; order?: number; component: ComponentType; find?: () => string[] | Promise<string[]> };
export const settingsSections = registry<SettingsSection>();

// Buttons under a prompt or a reply (copy, retry and edit are built in).
export type RowAction = {
  id: string;
  label: string;
  // A function draws the icon per row (a rating shows whether it is on).
  icon: ReactNode | ((e: StoredEvent, s: Session) => ReactNode);
  on: "user" | "assistant";
  when?: (e: StoredEvent, s: Session) => boolean;
  // Offered only while no turn runs. The transcript hides it with one write
  // of its own state; a `when` on the session's phase would render every row
  // again at each turn's start and end.
  idle?: boolean;
  run: (e: StoredEvent, s: Session) => void;
};
export const rowActions = registry<RowAction>();

// Buttons in the session header, left of the menu.
export type HeaderAction = { id: string; label: string; icon: ReactNode; when?: (s: Session) => boolean; run: (s: Session) => void };
export const headerActions = registry<HeaderAction>();

// Tabs of the side panel next to the conversation. The header shows a toggle
// for each; `component` gets the open session.
// `group` and `hint` place and describe it in the Panels picker (SidePanel.tsx
// knows the built-in ones by id).
export type Panel = { id: string; label: string; icon: ReactNode; keys?: string; order?: number; group?: string; hint?: string; when?: (s: Session) => boolean; component: ComponentType<{ session: Session }> };
export const panels = registry<Panel>();
