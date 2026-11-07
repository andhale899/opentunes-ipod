import { Component, type ComponentChildren } from 'preact';

interface State {
  message: string | null;
}

/**
 * Catches a crash while drawing one of the panels, so it shows a message instead of taking the
 * page down. It matters most for the panels that change an iPod: if drawing the result of a
 * write failed silently, nobody would see whether the write worked.
 */
export class PanelBoundary extends Component<{ name: string; children: ComponentChildren }, State> {
  override state: State = { message: null };

  override componentDidCatch(error: unknown): void {
    this.setState({ message: error instanceof Error ? error.message : String(error) });
  }

  override render() {
    if (this.state.message === null) return this.props.children;
    return (
      <section class="card">
        <div class="result no" role="alert">
          <p>
            The "{this.props.name}" panel could not be drawn: {this.state.message}. What it was doing has still run. Reload the page before using it again, and tell me what this says.
          </p>
        </div>
      </section>
    );
  }
}
