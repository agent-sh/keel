// GitHub Copilot CLI: not written yet.
import type { SideStore } from "./more.ts";

export const copilotStore: SideStore = {
  harness: "copilot",
  label: "GitHub Copilot CLI",
  store: () => "",
  list: () => [],
  read: async () => { throw new Error("copilot: no reader yet"); },
};
