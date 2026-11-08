import { useState } from 'preact/hooks';
import engineBuild from '../../docs/ENGINE-BUILD.md?raw';
import thirdParty from '../../THIRD_PARTY.md?raw';
import { parseCredits, type CreditBlock, type CreditSection } from './credits';

const SEEN_KEY = 'opentunes.riskNoticeSeen';

/** The sections of THIRD_PARTY.md and the version table of ENGINE-BUILD.md, read once. */
export const THIRD_PARTY_SECTIONS: CreditSection[] = parseCredits(thirdParty).filter((section) => section.heading !== '');
export const ENGINE_PINS: CreditSection | undefined = parseCredits(engineBuild).find((section) => section.heading === 'What goes into it');

/**
 * A short notice shown the first time the app opens in this browser, and not again after that.
 * The flag is remembered in the browser only, and the notice still works if that is blocked.
 */
export function RiskNotice({ onRead }: { onRead: () => void }) {
  const [show, setShow] = useState(() => {
    try {
      const seen = window.localStorage.getItem(SEEN_KEY) === '1';
      window.localStorage.setItem(SEEN_KEY, '1');
      return !seen;
    } catch {
      return true;
    }
  });
  if (!show) return null;
  return (
    <div class="callout warn risk-notice" role="note">
      <p>
        <strong>Use at your own risk.</strong> OpenTunes writes to your iPod's database. It makes you back up first and checks every write, but it has been tried only on an iPod nano 7th generation, and there is no warranty. Nothing is uploaded, and nothing is downloaded from streaming services.
      </p>
      <div class="actions">
        <button type="button" class="secondary small" onClick={onRead}>
          Read the details
        </button>
        <button type="button" class="ghost small" onClick={() => setShow(false)}>
          Got it
        </button>
      </div>
    </div>
  );
}

function Block({ block }: { block: CreditBlock }) {
  if (block.type === 'paragraph') return <p class="muted">{block.text}</p>;
  const { headers, rows } = block.table;
  const name = headers[0] as string;
  const licence = headers.find((header) => /licen[cs]e/i.test(header));
  const rest = headers.filter((header) => header !== name && header !== licence);
  return (
    <ul class="credits">
      {rows.map((row) => (
        <li key={row[name]}>
          <strong>{row[name]}</strong>
          {licence ? <span class="licence">{/^unknown/i.test(row[licence] ?? '') ? `${row[licence]} (see THIRD_PARTY.md)` : row[licence] || 'see THIRD_PARTY.md'}</span> : null}
          {rest.some((header) => row[header]) ? (
            <details>
              <summary>{rest.join(', ')}</summary>
              {rest.map((header) => (row[header] ? <p key={header} class="muted">{rest.length > 1 ? `${header}: ` : ''}{row[header]}</p> : null))}
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Use at your own risk, what OpenTunes does and does not do, and what it is built from. */
export function About({ onClose }: { onClose: () => void }) {
  return (
    <section class="card about" id="about" aria-labelledby="about-title">
      <div class="about-head">
        <h3 id="about-title">About, credits and risk</h3>
        <button type="button" class="secondary small" onClick={onClose}>
          Close
        </button>
      </div>

      <h4>Use at your own risk</h4>
      <ul>
        <li>
          OpenTunes writes to your iPod's database. A bad write can leave an iPod that will not start its library. <strong>Back up first.</strong> The app will not write until it has made a backup and read every file back, and it puts everything back if a write fails. That lowers the risk. It does not remove it.
        </li>
        <li>It has been tried only on an iPod nano 7th generation. Every other model in the list comes from published specifications, and has not been tried.</li>
        <li>
          There is no warranty. The code is under the GNU General Public License, version 3 or later (the LICENSE file), which says it is provided "as is", without warranty of any kind.
        </li>
        <li>OpenTunes is not affiliated with, or endorsed by, Apple. iPod is a trademark of Apple Inc.</li>
        <li>
          Nothing is uploaded unless you turn on one of two optional steps. The AI assistant sends your library's titles, artists, albums and genres to the model service you choose. The album art lookup sends the artist and album name of each album you ask about to musicbrainz.org and coverartarchive.org (the pictures come from archive.org). Both are off until you tick their box, and neither sends audio, file names or paths. Your files and your iPod's contents otherwise stay in this browser tab and on your own disks.
        </li>
        <li>
          Cover pictures found online come from the Cover Art Archive, which says its images are freely accessible, to be used at your own risk, and to be used with respect for the rights of the artists and labels. You see each picture before it is used, and nothing is added until you approve it.
        </li>
        <li>Nothing is downloaded from streaming services: OpenTunes works only with files you already have.</li>
      </ul>

      <h4>Credits</h4>
      <p class="muted">
        OpenTunes is built on the work below. Each licence is shown as THIRD_PARTY.md in the repository states it, and that file also says what was and was not re-read from the sources. Where a licence is not stated there, this page says "see THIRD_PARTY.md" and does not guess.
      </p>
      {THIRD_PARTY_SECTIONS.map((section) => (
        <div key={section.heading}>
          <h5>{section.heading}</h5>
          {section.blocks.map((block, index) => (
            <Block key={index} block={block} />
          ))}
        </div>
      ))}

      {ENGINE_PINS ? (
        <details>
          <summary>Versions the engine is built from</summary>
          {ENGINE_PINS.blocks.map((block, index) =>
            block.type === 'table' ? (
              <ul class="credits" key={index}>
                {block.table.rows.map((row) => (
                  <li key={row.Piece}>
                    <strong>{row.Piece}</strong>
                    <span class="licence">{row.Version}</span>
                    {row.Notes ? <span class="muted"> {row.Notes}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p key={index} class="muted">
                {block.text}
              </p>
            ),
          )}
          <p class="muted">Taken from docs/ENGINE-BUILD.md. Licences are in the lists above, or see THIRD_PARTY.md.</p>
        </details>
      ) : null}
    </section>
  );
}
