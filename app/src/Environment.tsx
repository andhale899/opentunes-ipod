import { useState } from 'preact/hooks';
import type { Capability, CapabilityReport } from '@opentunes/core';
import { probeFolder, probeUsb, probeWriteSpeed, type ProbeResult } from './probes';

type ProbeKey = 'usb' | 'folderRead' | 'folderWrite' | 'speed';

interface ProbeCardProps {
  title: string;
  help: string;
  button: string;
  busy: boolean;
  result: ProbeResult | undefined;
  onRun: () => void;
}

function CapabilityItem({ capability }: { capability: Capability }) {
  const status = capability.ok ? 'Yes' : capability.required ? 'No' : 'Missing';
  const tone = capability.ok ? 'ok' : capability.required ? 'no' : 'optional';
  return (
    <li class="capability">
      <div class="capability-head">
        <span class="capability-name">{capability.label}</span>
        <span class={`pill ${tone}`}>{status}</span>
        <span class="needed">{capability.required ? 'Required' : 'Optional'}</span>
      </div>
      <p class="muted">{capability.meaning}</p>
      {!capability.ok && capability.fix ? <p class="fix">{capability.fix}</p> : null}
    </li>
  );
}

function ProbeCard({ title, help, button, busy, result, onRun }: ProbeCardProps) {
  return (
    <section class="card">
      <h3>{title}</h3>
      <p class="muted">{help}</p>
      <button type="button" onClick={onRun} disabled={busy}>
        {busy ? 'Waiting for you...' : button}
      </button>
      {result ? (
        <div class={`result ${result.ok ? 'ok' : 'no'}`} role="status">
          <p>{result.summary}</p>
          {result.data ? (
            <details>
              <summary>Details</summary>
              <pre>{JSON.stringify(result.data, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Browser features, USB and folder checks, and a copyable report. Lives under Diagnostics. */
export function Environment({ report }: { report: CapabilityReport }) {
  const [probes, setProbes] = useState<Partial<Record<ProbeKey, ProbeResult>>>({});
  const [busy, setBusy] = useState<ProbeKey | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function run(key: ProbeKey, action: () => Promise<ProbeResult>) {
    setBusy(key);
    const result = await action();
    setProbes((previous) => ({ ...previous, [key]: result }));
    setBusy(null);
  }

  const reportText = JSON.stringify(
    {
      app: 'opentunes',
      phase: 'environment-check',
      generatedAt: new Date().toISOString(),
      browser: report.browser,
      capabilities: report.capabilities.map(({ id, ok }) => ({ id, ok })),
      probes,
    },
    null,
    2,
  );

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(reportText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  const browser = report.browser;
  const browserLabel = [browser.name, browser.major ? String(browser.major) : null, browser.platform ? `on ${browser.platform}` : null].filter(Boolean).join(' ');

  return (
    <>
      <section class={`callout ${report.syncReady ? 'ok' : 'no'}`} aria-live="polite">
        <p>
          <strong>{report.syncReady ? 'This browser can talk to an iPod.' : 'This browser cannot sync yet.'}</strong> {browserLabel}
        </p>
        {report.syncReady ? null : (
          <ul>
            {report.blockers.map((blocker) => (
              <li key={blocker.id}>
                <strong>{blocker.label}:</strong> {blocker.fix}
              </li>
            ))}
          </ul>
        )}
      </section>

      <h3 class="section-title">Browser features</h3>
      <ul class="capabilities">
        {report.capabilities.map((capability) => (
          <CapabilityItem key={capability.id} capability={capability} />
        ))}
      </ul>

      <h3 class="section-title">Try it with your iPod</h3>
      <p class="muted">Connect the iPod first so it shows up as a drive. These checks read only, apart from the write test and the speed test, which create temporary files in the iPod's root folder and delete them again.</p>
      <ProbeCard
        title="1. USB"
        help="Chrome asks you to pick the iPod. This shows whether it can read the iPod's name and serial number, which newer models need."
        button="Check USB device"
        busy={busy === 'usb'}
        result={probes.usb}
        onRun={() => void run('usb', probeUsb)}
      />
      <ProbeCard
        title="2. Folder access, read only"
        help="Pick the iPod's drive. This shows whether Chrome can open it, and lists what is in iPod_Control, with file sizes. Nothing is read from the files."
        button="Check iPod folder"
        busy={busy === 'folderRead'}
        result={probes.folderRead}
        onRun={() => void run('folderRead', () => probeFolder({ writeTest: false }))}
      />
      <ProbeCard
        title="3. Folder access, write test"
        help="Same as 2, then writes and removes a two-byte file named .opentunes-write-test to prove Chrome can write to the iPod, and times each step."
        button="Run write test"
        busy={busy === 'folderWrite'}
        result={probes.folderWrite}
        onRun={() => void run('folderWrite', () => probeFolder({ writeTest: true }))}
      />
      <ProbeCard
        title="4. Write speed"
        help="Writes about 20 MB of temporary files to the iPod's top folder and deletes them, to measure how fast Chrome can write to this iPod."
        button="Run speed test"
        busy={busy === 'speed'}
        result={probes.speed}
        onRun={() => void run('speed', probeWriteSpeed)}
      />

      <h3 class="section-title">Report</h3>
      <p class="muted">Copy this to share the results. It includes your iPod's serial number if you ran the USB check. Nothing is sent anywhere.</p>
      <button type="button" class="secondary" onClick={() => void copyReport()}>
        Copy report
      </button>
      {copyState === 'copied' ? <span class="note"> Copied.</span> : null}
      {copyState === 'failed' ? <span class="note"> Copy failed, select the text below instead.</span> : null}
      <pre class="report">{reportText}</pre>
    </>
  );
}
