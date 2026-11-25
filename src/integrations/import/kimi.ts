// Kimi Code: not written yet.
import type { SideStore } from "./more.ts";

export const kimiStore: SideStore = {
  harness: "kimi",
  label: "Kimi Code",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("kimi: no reader yet"); },
};
