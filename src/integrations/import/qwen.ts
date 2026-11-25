// Qwen Code: not written yet.
import type { SideStore } from "./more.ts";

export const qwenStore: SideStore = {
  harness: "qwen",
  label: "Qwen Code",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("qwen: no reader yet"); },
};
