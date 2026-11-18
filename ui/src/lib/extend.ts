// Extension points of the workbench. A feature lane registers here from its
// own module (imported once from main.tsx) instead of editing the shell.
import type { ComponentType, ReactNode } from "react";
import type { Session, StoredEvent } from "../../../src/core/types.ts";

function registry<T extends { id: string }>() {
  const items = new Map<string, T>();
  const subs = new Set<() => void>();
  let v = 0;
  return {
    add(...list: T[]) {
      for (const i of list) items.set(i.id, i);
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
export type SlashItem = {
  id: string; // the word after the slash
  label: string;
  hint?: string; // argument shape, e.g. "<name>"
  run?: (arg: string, ctx: SlashCtx) => void | Promise<void>;
  when?: (ctx: SlashCtx) => boolean;
};
export type SlashCtx = { session?: Session; setText: (t: string) => void };
export const slash = registry<SlashItem>();

// Sections of the settings page. `words` are what the settings search matches.
export type SettingsSection = { id: string; label: string; words?: string; icon?: ReactNode; order?: number; component: ComponentType };
export const settingsSections = registry<SettingsSection>();

// Buttons under a prompt or a reply (copy, retry and edit are built in).
export type RowAction = {
  id: string;
  label: string;
  icon: ReactNode;
  on: "user" | "assistant";
  when?: (e: StoredEvent, s: Session) => boolean;
  run: (e: StoredEvent, s: Session) => void;
};
export const rowActions = registry<RowAction>();

// Buttons in the session header, left of the menu.
export type HeaderAction = { id: string; label: string; icon: ReactNode; when?: (s: Session) => boolean; run: (s: Session) => void };
export const headerActions = registry<HeaderAction>();
