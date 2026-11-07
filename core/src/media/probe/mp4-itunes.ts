import type { ContentKind, MediaTags } from '../types';
import { beInt, u16be } from './bytes';
import { genreByIndex } from './genres';
import { fillTag, parseYear } from './state';
import { cleanText, utf16, utf8 } from './text';
import { memBoxes } from './mp4-codecs';

/** The iTunes metadata atoms in moov/udta/meta/ilst, and the older QuickTime text atoms in udta. */

export interface IlstEntry {
  /** The data type indicator: 1 is UTF-8 text, 2 UTF-16, 21 a big-endian integer, 13 JPEG, 14 PNG. */
  flags: number;
  data: Uint8Array;
}

function entryText(entry: IlstEntry): string {
  return cleanText(entry.flags === 2 ? utf16(entry.data, true) : utf8(entry.data));
}

function entryInt(entry: IlstEntry): number | undefined {
  if (entry.data.length === 0 || entry.data.length > 8) return undefined;
  return beInt(entry.data);
}

/** The media kinds the stik atom names. Other values are left alone. */
export function kindFromStik(value: number): ContentKind | undefined {
  switch (value) {
    case 1:
      return 'music';
    case 2:
      return 'audiobook';
    case 6:
      return 'music-video';
    case 9:
      return 'movie';
    case 10:
      return 'tv-show';
    case 21:
      return 'podcast';
    default:
      return undefined;
  }
}

/** The `data` boxes inside one ilst item, from the item's own bytes (its header included). */
export function itemEntries(item: Uint8Array): IlstEntry[] {
  const out: IlstEntry[] = [];
  for (const box of memBoxes(item, 8, item.length)) {
    if (box.type !== 'data' || box.end - box.bodyStart < 8) continue;
    const flags = ((item[box.bodyStart + 1] ?? 0) << 16) | ((item[box.bodyStart + 2] ?? 0) << 8) | (item[box.bodyStart + 3] ?? 0);
    out.push({ flags, data: item.subarray(box.bodyStart + 8, box.end) });
  }
  return out;
}

/** Puts one ilst item into the tags. `covr` is handled by the caller because pictures are read lazily. */
export function applyIlstItem(tags: MediaTags, name: string, entries: IlstEntry[]): void {
  const first = entries[0];
  if (!first) return;
  const text = () => entryText(first);
  switch (name) {
    case '©nam':
      fillTag(tags, 'title', text());
      break;
    case '©ART':
      fillTag(tags, 'artist', text());
      break;
    case 'aART':
      fillTag(tags, 'albumArtist', text());
      break;
    case '©alb':
      fillTag(tags, 'album', text());
      break;
    case '©gen':
      fillTag(tags, 'genre', text());
      break;
    case 'gnre': {
      // A number that is one more than the ID3v1 genre index.
      const index = entryInt(first);
      if (index !== undefined && index > 0) fillTag(tags, 'genre', genreByIndex(index - 1));
      break;
    }
    case '©day':
      fillTag(tags, 'year', parseYear(text()));
      break;
    case '©wrt':
      fillTag(tags, 'composer', text());
      break;
    case '©cmt':
      fillTag(tags, 'comment', text());
      break;
    case '©grp':
      fillTag(tags, 'grouping', text());
      break;
    case 'desc':
      fillTag(tags, 'description', text());
      break;
    case 'ldes':
      // The long description is used only when there is no short one. See the order in the caller.
      fillTag(tags, 'description', text());
      break;
    case '©lyr':
      fillTag(tags, 'lyrics', text());
      break;
    case 'trkn': {
      // Two reserved bytes, the number, the total, two more reserved bytes.
      if (first.data.length >= 6) {
        const n = u16be(first.data, 2);
        const total = u16be(first.data, 4);
        fillTag(tags, 'trackNumber', n > 0 ? n : undefined);
        fillTag(tags, 'trackTotal', total > 0 ? total : undefined);
      }
      break;
    }
    case 'disk': {
      if (first.data.length >= 6) {
        const n = u16be(first.data, 2);
        const total = u16be(first.data, 4);
        fillTag(tags, 'discNumber', n > 0 ? n : undefined);
        fillTag(tags, 'discTotal', total > 0 ? total : undefined);
      }
      break;
    }
    case 'tmpo': {
      const bpm = entryInt(first);
      if (bpm !== undefined && bpm > 0 && bpm < 1000) fillTag(tags, 'bpm', bpm);
      break;
    }
    case 'cpil': {
      const flag = entryInt(first);
      if (flag !== undefined) fillTag(tags, 'compilation', flag !== 0);
      break;
    }
    case 'stik': {
      const kind = kindFromStik(entryInt(first) ?? -1);
      if (kind) tags.declaredKind = kind;
      break;
    }
    case 'pcst': {
      // The podcast flag. It matters only when stik did not already say what the file is.
      if ((entryInt(first) ?? 0) !== 0 && tags.declaredKind === undefined) tags.declaredKind = 'podcast';
      break;
    }
    case 'catg':
      fillTag(tags, 'podcastCategory', text());
      break;
    case 'purl':
      fillTag(tags, 'podcastFeedUrl', text());
      break;
    case 'egid':
      fillTag(tags, 'podcastEpisodeUrl', text());
      break;
    case 'tvsh':
      fillTag(tags, 'show', text());
      break;
    case 'tvsn': {
      const season = entryInt(first);
      if (season !== undefined && season > 0) fillTag(tags, 'season', season);
      break;
    }
    case 'tves': {
      const episode = entryInt(first);
      if (episode !== undefined && episode > 0) fillTag(tags, 'episode', episode);
      break;
    }
    case 'tven':
      fillTag(tags, 'episodeId', text());
      break;
    case 'tvnn':
      fillTag(tags, 'network', text());
      break;
    default:
      break;
  }
}

/** QuickTime text atoms that sit straight in udta: a 2 byte length, a 2 byte language, then the text. */
export function applyQuickTimeTextAtom(tags: MediaTags, name: string, body: Uint8Array): void {
  if (body.length < 4) return;
  const length = Math.min(u16be(body, 0), body.length - 4);
  const value = cleanText(utf8(body.subarray(4, 4 + length)));
  switch (name) {
    case '©nam':
      fillTag(tags, 'title', value);
      break;
    case '©ART':
      fillTag(tags, 'artist', value);
      break;
    case '©alb':
      fillTag(tags, 'album', value);
      break;
    case '©cmt':
      fillTag(tags, 'comment', value);
      break;
    case '©day':
      fillTag(tags, 'year', parseYear(value));
      break;
    case '©gen':
      fillTag(tags, 'genre', value);
      break;
    case '©wrt':
      fillTag(tags, 'composer', value);
      break;
    default:
      break;
  }
}
