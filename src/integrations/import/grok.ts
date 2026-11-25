// Grok: not written yet.
import type { SideStore } from "./more.ts";

export const grokStore: SideStore = {
  harness: "grok",
  label: "Grok",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("grok: no reader yet"); },
};
