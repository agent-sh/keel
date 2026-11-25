// The harnesses whose stores list themselves (few sessions, read whole), one file each: a store
// says where it lives, lists its sessions as `Found` rows and reads one into keel-bun events.
// A store reads only (nothing is written beside its files) and never imports service.ts.
// Its folder is `KEEL_IMPORT_<NAME>_DIR` when set (a test's scratch store), else the harness's own.
import type { Found, Harness, Read } from "./types.ts";
import { grokStore } from "./grok.ts";
import { kimiStore } from "./kimi.ts";
import { piStore } from "./pi.ts";
import { cursorStore } from "./cursor.ts";
import { copilotStore } from "./copilot.ts";
import { aiderStore } from "./aider.ts";
import { qwenStore } from "./qwen.ts";
import { gooseStore } from "./goose.ts";
import { crushStore } from "./crush.ts";

export type SideStore = {
  harness: Harness;
  label: string;
  // The folder or database file the store lives in (what the sheet shows).
  store: () => string;
  // Every session, newest first. Cheap on a repeat: a file is read again only when its size or time changed.
  list: () => Found[];
  // One session read whole.
  read: (f: Found) => Promise<Read>;
  // How many files the last `list` left unread for its time budget (the walk calls again until none).
  pending?: () => number;
};

export const MORE: SideStore[] = [grokStore, kimiStore, piStore, cursorStore, copilotStore, aiderStore, qwenStore, gooseStore, crushStore];
export const moreOf = (h: string) => MORE.find((m) => m.harness === h);
