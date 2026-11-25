// Crush: not written yet.
import type { SideStore } from "./more.ts";

export const crushStore: SideStore = {
  harness: "crush",
  label: "Crush",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("crush: no reader yet"); },
};
