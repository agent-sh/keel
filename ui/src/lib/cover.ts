// A view that lies under another (a pane's own session under a look, a look
// under the start page) is not drawn again while it is covered: nobody sees
// it, and a session that streams there cost the page a render, a style pass
// and new rows at every frame. Under a `Covered` that is on, every reader of the
// page's store reads the store as it was when the view was covered, and is
// told of nothing. When the view shows again its readers are told once, in
// the same frame as the cover leaves, so it is drawn as it is now before the
// owner sees it: no flash of what it was.
//
// Only what the view draws is held. The page still hears the covered
// session (lib/scope.ts) and its store goes on: nothing is caught up by a
// request when the view shows again. What the view kept of its session's
// history (a reader far above the end keeps it whole) it keeps under the
// cover too: the place it was left at is in it.
import { createContext, createElement, useLayoutEffect, useMemo, type ReactNode } from "react";

export type Gate<S = unknown> = {
  // The store as it was when the view was covered; null while the view shows.
  held: S | null;
  // A store reader under the gate: told of the store's changes while the view shows, and once when it shows again.
  subscribe: (f: () => void) => () => void;
  set: (on: boolean) => void;
};

export function makeGate<S>(subscribe: (f: () => void) => () => void, read: () => S): Gate<S> {
  const readers = new Set<() => void>();
  const gate: Gate<S> = {
    held: null,
    subscribe: (f) => {
      readers.add(f);
      const off = subscribe(() => { if (gate.held === null) f(); });
      return () => { readers.delete(f); off(); };
    },
    set: (on) => {
      if (on === (gate.held !== null)) return;
      gate.held = on ? read() : null;
      if (!on) for (const f of [...readers]) f();
    },
  };
  return gate;
}

export const CoverCtx = createContext<Gate | null>(null);

// `make`: a gate over the store the views under it read (the page's: `storeGate`).
export function Covered({ on, make, children }: { on: boolean; make: () => Gate; children?: ReactNode }) {
  const gate = useMemo(make, []);
  // With the frame that covers or uncovers the view, before it is painted.
  useLayoutEffect(() => gate.set(on), [on]);
  return createElement(CoverCtx.Provider, { value: gate }, children);
}
