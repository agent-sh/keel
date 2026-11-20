import "./lib/fonts.ts";
import "./lib/shell.ts";
import "./lib/tips.ts";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./features/safety.tsx";
import "./features/drive.tsx";
import "./features/voice.tsx";
import "./lib/turns.ts";
import "./lib/side.ts";
import "./lib/tree.ts";
import "./components/automation/register.tsx";
import "./features/fleet.tsx";
import "./features/mobile.tsx";
import "./lib/tokens-ui.ts";
import "./features/profile.tsx";
import "./features/sessops.tsx";
import "./features/terminal.tsx";
import "./features/observe.tsx";
import "./features/projects.tsx";
import "./features/artifacts.tsx";
import "./features/helper.tsx";
import "./features/experiments.tsx";

// Install metadata. Added here, not in index.html, because the bundler tries
// to resolve every link in the page as a file to bundle.
for (const [rel, href, extra] of [
  ["manifest", "/manifest.webmanifest", {}],
  ["icon", "/icons/icon.svg", { type: "image/svg+xml" }],
  ["apple-touch-icon", "/icons/apple-touch-180.png", {}],
] as const) {
  const l = Object.assign(document.createElement("link"), { rel, href, ...extra });
  document.head.append(l);
}
if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(<App />);
