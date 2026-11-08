import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { creditRows, parseCredits, plainText } from '../src/credits';

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('reading the credits out of the repository files', () => {
  it('strips links, code marks and bold, and squeezes spaces', () => {
    expect(plainText('See [the file](a/b.md) for `code` and **bold**   text')).toBe('See the file for code and bold text');
  });

  it('parses tables with their headers, paragraphs and headings', () => {
    const sections = parseCredits('# Title\n\nIntro.\n\n## Things\n\n| Name | Licence |\n| --- | --- |\n| `A` | MIT |\n| B | GPL 2 |\n\nAfter the table.\n');
    expect(sections.map((section) => section.heading)).toEqual(['', 'Things']);
    expect(sections[0]?.blocks).toEqual([{ type: 'paragraph', text: 'Intro.' }]);
    expect(creditRows(sections)).toEqual([
      { section: 'Things', row: { Name: 'A', Licence: 'MIT' } },
      { section: 'Things', row: { Name: 'B', Licence: 'GPL 2' } },
    ]);
    expect(sections[1]?.blocks.at(-1)).toEqual({ type: 'paragraph', text: 'After the table.' });
  });

  it('gives every component in THIRD_PARTY.md the licence the file states, word for word', () => {
    const rows = creditRows(parseCredits(read('THIRD_PARTY.md')));
    const licenceOf = (start: string) => rows.find(({ row }) => row.Component?.startsWith(start))?.row.Licence;
    expect(licenceOf('libgpod')).toBe('LGPL, version 2 or later (source file headers)');
    expect(licenceOf('libplist')).toBe('LGPL 2.1 (COPYING.LESSER)');
    expect(licenceOf('SQLite')).toBe('Public domain');
    expect(licenceOf('hashab')).toBe('The Unlicense (public domain)');
    expect(licenceOf('@ffmpeg/core')).toBe('GPL 2 or later (package.json)');
    expect(licenceOf('@ffmpeg/ffmpeg')).toBe('MIT (package.json)');
    expect(licenceOf('Preact')).toBe('MIT (package.json)');
    expect(licenceOf('Vite')).toBe('MIT (package.json)');
    expect(licenceOf('SysInfoExtended')).toBe('Unknown');
    // Every row of every table has a licence cell that is not empty.
    for (const { row } of rows) expect(row.Licence, row.Component).toBeTruthy();
  });

  it('finds the version table of the engine build', () => {
    const sections = parseCredits(read('docs/ENGINE-BUILD.md'));
    const pins = creditRows(sections.filter((section) => section.heading === 'What goes into it'));
    const libgpod = pins.find(({ row }) => row.Piece === 'libgpod');
    expect(libgpod?.row.Version).toContain('7982c55');
    expect(pins.some(({ row }) => row.Piece === 'emscripten')).toBe(true);
  });

  it('keeps the GPL warning about the ffmpeg core, so the About page can show it', () => {
    const sections = parseCredits(read('THIRD_PARTY.md'));
    const converter = sections.filter((section) => section.heading === 'Loaded by the converter');
    const note = creditRows(converter).find(({ row }) => row.Component?.startsWith('@ffmpeg/core'))?.row.Notes ?? '';
    expect(note).toContain('whole core is GPL');
  });
});
