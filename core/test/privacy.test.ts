// A FireWire ID or serial number identifies one iPod, and a FireWire ID is also what its
// database signature is bound to. The owner's must never reach the repo, whether through a
// doc, a test fixture or a pasted report.
//
// No test can know a particular ID without containing it, so this catches the shape instead:
// 16 hex digits starting with one of Apple's prefixes, 000A27 or 000A95. Made-up IDs in tests
// and docs should not start that way.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOOKS_REAL = /(?<![0-9a-f])000a(?:27|95)[0-9a-f]{10}(?![0-9a-f])/i;

function repoFiles(): { root: string; files: string[] } | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
    // Tracked files, plus new files not yet added, minus anything ignored.
    const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
    return { root, files: listing.split('\0').filter(Boolean) };
  } catch {
    return null; // not a git checkout, for example an exported archive
  }
}

const repo = repoFiles();

describe('device identifiers', () => {
  it.skipIf(repo === null)('do not appear in any file of the repo', () => {
    const { root, files } = repo as NonNullable<typeof repo>;
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        continue; // deleted but still listed, or unreadable
      }
      text.split('\n').forEach((line, index) => {
        if (LOOKS_REAL.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    // Only places are listed, never the matching text, so a failure does not repeat the ID.
    expect(offenders).toEqual([]);
  });

  it('the pattern recognises an Apple-prefixed ID and leaves other hex alone', () => {
    expect(LOOKS_REAL.test('id 000A27' + '1234567890' + ' end')).toBe(true);
    expect(LOOKS_REAL.test('0x000a95' + 'abcdef0123')).toBe(true);
    expect(LOOKS_REAL.test('0123456789ABCDEF')).toBe(false);
    expect(LOOKS_REAL.test('FEDCBA9876543210')).toBe(false);
    expect(LOOKS_REAL.test('f' + '000a27' + '1234567890')).toBe(false); // inside a longer hex run
    expect(LOOKS_REAL.test('000a27' + '1234567890' + 'f')).toBe(false);
  });
});
