import { Component, type ReactNode } from "react";
import { reportError } from "../lib/store.ts";

// A view that throws shows what failed and records it in Errors.
export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { kind: "react", componentStack: info.componentStack });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    // A part of the page that did not load (the network dropped, or Keel was
    // updated and the old file is gone): React keeps a failed lazy load, so
    // rendering again cannot fetch it; a reload can, and drafts are kept.
    const chunk = /dynamically imported module|importing a module script failed|error loading dynamically|loading chunk/i.test(this.state.error.message);
    return (
      <div className="m-auto max-w-md p-8 text-center" role="alert">
        <p className="font-semibold">{chunk ? "Part of Keel did not load." : "This view failed to render."}</p>
        <p className="mt-1 text-ui text-muted">{chunk ? "The connection dropped or Keel was updated. Reloading fetches it again; your drafts stay." : this.state.error.message}</p>
        <p className="mt-1 text-caption text-faint">It is recorded in Errors.</p>
        <button
          autoFocus
          className="mt-4 h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover"
          onClick={() => (chunk ? location.reload() : this.setState({ error: null }))}
        >
          {chunk ? "Reload Keel" : "Render again"}
        </button>
      </div>
    );
  }
}
