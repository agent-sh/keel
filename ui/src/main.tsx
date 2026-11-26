import "./lib/first-visit.ts";
import "./lib/fonts.ts";
import "./lib/shell.ts";
import "./lib/frames.ts";
import "./lib/tips.ts";
import { createRoot } from "react-dom/client";
import { App, firstView } from "./App.tsx";
import { firstDraw } from "./lib/preload.ts";
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
import "./features/timeline.tsx";
import "./features/projects.tsx";
import "./features/artifacts.tsx";
import "./features/helper.tsx";
import "./features/experiments.tsx";
import "./features/pr-reviews.tsx";
import "./features/board.tsx";
import "./features/asks.tsx";
import "./features/lane-plan.tsx";
import "./features/shell.ts";
import "./features/presses.tsx";
import "./features/speech.tsx";

// The first draw waits this long at most for the code the first view needs; past it the page draws what it has.
const FIRST_DRAW_MS = 600;

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

void firstDraw(firstView, FIRST_DRAW_MS).then(() => createRoot(document.getElementById("root")!).render(<App />));
