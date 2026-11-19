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
    return (
      <div className="m-auto max-w-md p-8 text-center">
        <p className="font-semibold">This view failed to render.</p>
        <p className="mt-1 text-ui text-muted">{this.state.error.message}</p>
        <p className="mt-1 text-caption text-faint">It is recorded in Errors.</p>
        <button className="mt-4 h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover" onClick={() => this.setState({ error: null })}>Render again</button>
      </div>
    );
  }
}
