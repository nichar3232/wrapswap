import { Component, type ReactNode } from "react";

/** Contains a failed lazy chunk or a render error to its own panel, so the rest of the app keeps working. */
export class Boundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.warn(`[${this.props.label}]`, e);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card" role="status">
        <p>{this.props.label} couldn't load. Reload the page to retry.</p>
      </section>
    );
  }
}
