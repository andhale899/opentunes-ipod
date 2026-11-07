import { render } from 'preact';
import { App } from './App';
import { PanelBoundary } from './PanelBoundary';
import './styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');

/** Draws a panel that always fails, for the smoke test. Opened with ?selftest=boundary, never linked. */
function Broken(): never {
  throw new Error('this panel was made to fail');
}

if (new URLSearchParams(window.location.search).get('selftest') === 'boundary') {
  render(
    <PanelBoundary name="Self test">
      <Broken />
    </PanelBoundary>,
    root,
  );
} else {
  render(<App />, root);
}
