import { useMemo, useState } from 'preact/hooks';
import { detectCapabilities, devices, type EnvLike } from '@opentunes/core';
import { About, RiskNotice } from './About';
import { Environment } from './Environment';
import { IpodViewer } from './IpodViewer';

export function App() {
  const report = useMemo(() => detectCapabilities(window as unknown as EnvLike), []);
  const browser = report.browser;
  const [aboutOpen, setAboutOpen] = useState(false);
  const openAbout = () => {
    setAboutOpen(true);
    window.setTimeout(() => document.getElementById('about')?.scrollIntoView?.({ block: 'start' }), 0);
  };
  const browserLabel = [browser.name, browser.major ? String(browser.major) : null].filter(Boolean).join(' ');

  return (
    <>
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">
              ♪
            </span>
            OpenTunes
          </div>
          <div class="topbar-end">
            <span class={`pill ${report.syncReady ? 'ok' : 'no'}`} title={report.syncReady ? 'This browser can reach an iPod' : 'This browser is missing something an iPod needs'}>
              {report.syncReady ? `${browserLabel} is ready` : `${browserLabel} cannot sync yet`}
            </span>
          </div>
        </div>
      </header>

      <main class="page">
        <RiskNotice onRead={openAbout} />
        {aboutOpen ? <About onClose={() => setAboutOpen(false)} /> : null}
        <IpodViewer
          canPickFolder={report.capabilities.find((capability) => capability.id === 'folderPicker')?.ok ?? false}
          syncReady={report.syncReady}
          blockers={report.blockers.map((blocker) => `${blocker.label}: ${blocker.fix}`)}
          environment={<Environment report={report} />}
        />
      </main>

      <footer class="site-footer">
        OpenTunes runs entirely in this browser. Nothing is uploaded. {devices.length} iPod models are listed. Only the nano 7th generation has been tried on real hardware.{' '}
        <button type="button" class="ghost small footer-link" onClick={openAbout}>
          About, credits and risk
        </button>
      </footer>
    </>
  );
}
