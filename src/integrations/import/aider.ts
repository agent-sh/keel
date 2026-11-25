// Aider: not written yet.
import type { SideStore } from "./more.ts";

export const aiderStore: SideStore = {
  harness: "aider",
  label: "Aider",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("aider: no reader yet"); },
};
