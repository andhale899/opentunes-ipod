/**
 * Song identity for duplicate detection.
 *
 * Two files are "the same song" when their normalised artist and title match.
 * Ported from the v1 server, with three fixes:
 * - v1 used `\w`, which only matches ASCII, so titles in Japanese, Cyrillic or
 *   with accents lost letters or became empty and were skipped. This version
 *   uses Unicode letter and number classes.
 * - v1 stripped "(Live ...)" tags, so a live recording counted as a duplicate of
 *   the studio track. Live, remix, acoustic, demo and instrumental versions are
 *   different recordings and stay distinct here.
 * - v1 split on every " - " and kept only the first two parts, dropping the
 *   rest of a title like "Song - Part 2". This version splits on the first one.
 */

/** Bracketed tags that do not change which recording a file is. */
const NOISE_TAGS: readonly RegExp[] = [
  /remaster/i,
  /^(feat|ft|featuring)\b/i,
  /official\s+(music\s+)?(video|audio|lyric\s+video)/i,
  /^lyrics?(\s+video)?$/i,
  /^visuali[sz]er$/i,
  /bonus\s+track/i,
  /deluxe/i,
  /^(audio|hd|hq|4k)$/i,
];

export interface SongIdentity {
  /** Comparison key. Equal keys mean the same song. */
  key: string;
  artist: string;
  title: string;
  /** Original text, trimmed, for showing to a person. */
  displayArtist: string;
  displayTitle: string;
}

function stripNoiseTags(text: string): string {
  return text.replace(/[(\[]([^)\]]*)[)\]]/g, (whole, inner: string) =>
    NOISE_TAGS.some((pattern) => pattern.test(inner.trim())) ? ' ' : whole,
  );
}

/** Lowercases, removes accents and punctuation, and collapses spaces. Keeps letters and digits in any script. */
export function normalizeText(text: string): string {
  return stripNoiseTags(text)
    .replace(/_/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Builds an identity from a filename such as "Artist - Title (Remastered 2011).m4a". */
export function songIdentity(filename: string): SongIdentity {
  const base = filename.replace(/\.[^./\\]+$/, '');
  const split = base.indexOf(' - ');
  const rawArtist = split === -1 ? '' : base.slice(0, split);
  const rawTitle = split === -1 ? base : base.slice(split + 3);

  const artist = normalizeText(rawArtist);
  const title = normalizeText(rawTitle);

  return {
    key: artist ? `${artist}___${title}` : title,
    artist,
    title,
    displayArtist: rawArtist.trim(),
    displayTitle: rawTitle.trim(),
  };
}
