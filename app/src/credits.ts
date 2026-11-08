/**
 * Reads the credits for the About page out of THIRD_PARTY.md and docs/ENGINE-BUILD.md themselves,
 * so a licence is shown exactly as those files state it and is never typed a second time.
 * Only the small part of Markdown those two files use is understood: ## headings, paragraphs and pipe tables.
 */

export interface CreditTable {
  headers: string[];
  rows: Record<string, string>[];
}

export type CreditBlock = { type: 'paragraph'; text: string } | { type: 'table'; table: CreditTable };

export interface CreditSection {
  heading: string;
  blocks: CreditBlock[];
}

/** Links and emphasis out, backticks out, so the text reads as plain words. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => plainText(cell));

const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function parseCredits(markdown: string): CreditSection[] {
  const sections: CreditSection[] = [];
  let current: CreditSection | null = null;
  const lines = markdown.split(/\r?\n/);
  const into = (block: CreditBlock): void => {
    if (!current) {
      current = { heading: '', blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (/^##\s+/.test(line)) {
      current = { heading: plainText(line.replace(/^##\s+/, '')), blocks: [] };
      sections.push(current);
    } else if (/^#\s+/.test(line) || line.trim() === '') {
      continue;
    } else if (line.trim().startsWith('|') && isSeparator(lines[i + 1] ?? '')) {
      const headers = cellsOf(line);
      const rows: Record<string, string>[] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).trim().startsWith('|')) {
        const cells = cellsOf(lines[i] as string);
        rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
        i += 1;
      }
      i -= 1;
      into({ type: 'table', table: { headers, rows } });
    } else {
      const paragraph: string[] = [line];
      while (i + 1 < lines.length && (lines[i + 1] as string).trim() !== '' && !/^(#|\|)/.test((lines[i + 1] as string).trim())) {
        i += 1;
        paragraph.push(lines[i] as string);
      }
      into({ type: 'paragraph', text: plainText(paragraph.join(' ')) });
    }
  }
  return sections.filter((section) => section.heading !== '' || section.blocks.length > 0);
}

/** Every row of every table in the sections, with the section it came from. */
export function creditRows(sections: CreditSection[]): { section: string; row: Record<string, string> }[] {
  return sections.flatMap((section) =>
    section.blocks.flatMap((block) => (block.type === 'table' ? block.table.rows.map((row) => ({ section: section.heading, row })) : [])),
  );
}
