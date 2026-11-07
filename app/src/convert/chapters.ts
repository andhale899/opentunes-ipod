/**
 * Chapter marks for audiobooks and long videos, written as an ffmpeg metadata file
 * (ffmetadata). Pure, no worker and no wasm.
 *
 * ffmpeg's iPod muxer turns these into both the `chpl` atom and a chapter text track.
 * `chpl` stores each title with a one byte length, so a title is cut to 255 bytes of UTF-8.
 */

import type { Chapter } from '@opentunes/core';

export interface NormalizedChapter {
  startMs: number;
  endMs: number;
  title: string;
}

const MAX_TITLE_BYTES = 255;

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

/** In an ffmetadata file `=`, `;`, `#`, `\` and a new line must have a backslash in front. */
export function escapeMetadataValue(value: string): string {
  return value.replace(/[\\=;#\n]/g, (character) => (character === '\n' ? '\\\n' : `\\${character}`));
}

/**
 * Sorts the chapters, drops any with a bad or repeated start (or a start after the end of the
 * file), gives untitled ones a name, and works out where each one ends.
 * `totalMs` is the length of the file when known.
 */
export function normalizeChapters(chapters: readonly Chapter[], totalMs: number | null = null): NormalizedChapter[] {
  const seen = new Set<number>();
  const kept = chapters
    .filter((chapter) => Number.isFinite(chapter.startMs) && chapter.startMs >= 0)
    .map((chapter) => ({ startMs: Math.round(chapter.startMs), title: chapter.title }))
    .sort((a, b) => a.startMs - b.startMs)
    .filter((chapter) => {
      if (seen.has(chapter.startMs)) return false;
      seen.add(chapter.startMs);
      return totalMs === null || chapter.startMs < totalMs;
    });

  return kept.map((chapter, index) => {
    const next = kept[index + 1];
    const fallbackEnd = totalMs !== null && totalMs > chapter.startMs ? Math.round(totalMs) : chapter.startMs + 1;
    const title = truncateUtf8(chapter.title.trim() || `Chapter ${index + 1}`, MAX_TITLE_BYTES);
    return { startMs: chapter.startMs, endMs: next ? next.startMs : fallbackEnd, title };
  });
}

/** The ffmetadata file text for these chapters. Empty chapters give an empty string. */
export function buildChapterMetadata(chapters: readonly Chapter[], totalMs: number | null = null): string {
  const list = normalizeChapters(chapters, totalMs);
  if (list.length === 0) return '';
  const lines = [';FFMETADATA1'];
  for (const chapter of list) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${chapter.startMs}`, `END=${chapter.endMs}`, `title=${escapeMetadataValue(chapter.title)}`);
  }
  return `${lines.join('\n')}\n`;
}
