// Cursor Agent: not written yet.
import type { SideStore } from "./more.ts";

export const cursorStore: SideStore = {
  harness: "cursor",
  label: "Cursor Agent",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("cursor: no reader yet"); },
};
