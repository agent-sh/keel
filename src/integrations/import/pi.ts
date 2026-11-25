// Pi: not written yet.
import type { SideStore } from "./more.ts";

export const piStore: SideStore = {
  harness: "pi",
  label: "Pi",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("pi: no reader yet"); },
};
