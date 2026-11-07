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

const selftest = new URLSearchParams(window.location.search).get('selftest');

if (selftest === 'boundary') {
  render(
    <PanelBoundary name="Self test">
      <Broken />
    </PanelBoundary>,
    root,
  );
} else if (selftest === 'convert') {
  // Runs the real converter on generated files. Opened with ?selftest=convert, never linked.
  void import('./convert/selftest').then((module) => module.renderConvertSelfTest(root));
} else {
  render(<App />, root);
}
