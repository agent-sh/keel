// Goose: not written yet.
import type { SideStore } from "./more.ts";

export const gooseStore: SideStore = {
  harness: "goose",
  label: "Goose",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("goose: no reader yet"); },
};
