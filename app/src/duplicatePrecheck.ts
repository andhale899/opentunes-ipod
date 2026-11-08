/**
 * The duplicate check for the Add music list, run before anything is converted.
 *
 * It asks the engine's own judge (`checkDuplicates` in engine/js/sync.ts, the code `planSync` uses)
 * about each file, from what the probe already read. Nothing here decides what a duplicate is: this
 * file only turns the answers into the words and counts the page shows, and compares them with the
 * plan afterwards.
 */
import { checkDuplicates, type DuplicateCheck, type DuplicateInput, type DuplicateFound, type TrackInfo } from '@opentunes/engine';
import type { Candidate } from './addFiles';

/** What the list says about one file's duplicates. */
export type RowState =
  /** Nothing on the iPod or above in the list matches. No note is shown. */
  | 'new'
  /** Already on the iPod. */
  | 'on-ipod'
  /** The same as a file above it in the list. */
  | 'in-list'
  /** It has no usable title, so it cannot be compared. It is let through. */
  | 'cannot-tell'
  /** The iPod cannot take the file at all. The row says that elsewhere. */
  | 'not-added';

export interface RowDuplicate {
  state: RowState;
  /** True when it is left out: not converted and not copied. */
  skipped: boolean;
  /** True when it is a duplicate that will be added anyway, because of the box or the row's own button. */
  addedAnyway: boolean;
  /** Plain words for the note under the file's name. Empty when there is nothing to say. */
  text: string;
  /** Short label for the badge. Empty when there is none. */
  label: string;
  /** The id of the file above it in the list that it repeats, for `in-list`. */
  otherId?: string;
}

export interface PrecheckOptions {
  /** The box "Add files even if the same song, episode or title is already on the iPod". */
  allowAll: boolean;
  /** Rows the person chose to add anyway. */
  allowIds: ReadonlySet<string>;
}

/** The file as the engine's judge needs it: what the probe read and what the file would be on the iPod. */
export function duplicateInputOf(candidate: Candidate): DuplicateInput {
  const { decision, file, info } = candidate;
  return {
    id: candidate.id,
    kind: decision.kind,
    // An unsupported file has no output extension; the engine then reports that it cannot be added.
    extension: decision.outputExtension,
    info,
    name: file.name,
    data: { size: candidate.estimatedBytes ?? file.size },
  };
}

const quoted = (text: string): string => `"${text}"`;

/** "Title" by Artist, or just "Title". */
function describeTrack(track: Pick<TrackInfo, 'title' | 'artist'>): string {
  const title = track.title?.trim() || 'Untitled';
  const artist = track.artist?.trim();
  return artist ? `${quoted(title)} by ${artist}` : quoted(title);
}

/**
 * Judges every file in the list against the iPod's tracks and the files above it, with the engine's
 * own rules. The map has one entry per candidate.
 */
export function precheck(candidates: Candidate[], library: TrackInfo[], options: PrecheckOptions): Map<string, RowDuplicate> {
  const results = checkDuplicates(candidates.map(duplicateInputOf), library, { allow: options.allowAll, allowIds: options.allowIds });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const rows = new Map<string, RowDuplicate>();
  results.forEach((result, index) => {
    rows.set(result.itemId, rowFor(result, candidates[index] as Candidate, byId, options));
  });
  return rows;
}

function rowFor(result: DuplicateCheck, candidate: Candidate, byId: Map<string, Candidate>, options: PrecheckOptions): RowDuplicate {
  if (result.problem || candidate.decision.action === 'unsupported') return { state: 'not-added', skipped: false, addedAnyway: false, text: '', label: '' };
  const { verdict } = result;
  const addedAnyway = !result.skipped;
  const noTitleTag = !candidate.info.tags.title?.trim();
  // The engine falls back to the file name for a file with no title tag, as planSync does. Say so.
  const byName = noTitleTag ? ' The file has no title tag, so its file name was used.' : '';
  const reason = options.allowAll ? 'because the box below is ticked' : 'because you chose to';
  if (verdict.status === 'on-ipod') {
    const match = `It matches ${describeTrack(verdict.track)}.${byName}`;
    return result.skipped
      ? { state: 'on-ipod', skipped: true, addedAnyway: false, label: 'Skipped: already on the iPod', text: `${match} It will not be converted or copied.` }
      : { state: 'on-ipod', skipped: false, addedAnyway, label: 'Already on the iPod, added anyway', text: `${match} It will be added again ${reason}.` };
  }
  if (verdict.status === 'in-batch') {
    const other = byId.get(verdict.otherItemId);
    const name = other ? quoted(other.file.name) : 'a file';
    const match = `It is the same song, episode or title as ${name} above in this list.${byName}`;
    return result.skipped
      ? { state: 'in-list', skipped: true, addedAnyway: false, otherId: verdict.otherItemId, label: `Skipped: same as ${other?.file.name ?? 'a file'} above`, text: `${match} It will not be converted or copied.` }
      : { state: 'in-list', skipped: false, addedAnyway, otherId: verdict.otherItemId, label: 'Same as a file above, added anyway', text: `${match} It will be added too ${reason}.` };
  }
  if (verdict.status === 'cannot-tell') {
    return { state: 'cannot-tell', skipped: false, addedAnyway: false, label: 'Could not tell if this is already on the iPod (no title)', text: 'The file has no title tag and its file name has no letters or digits to go by, so it is let through.' };
  }
  return { state: 'new', skipped: false, addedAnyway: false, text: '', label: '' };
}

/** What 'Check and prepare' is about to do. */
export interface PrepareCounts {
  /** Files that need the converter. */
  convert: number;
  /** Files the iPod plays as they are. */
  copy: number;
  /** Files left out as duplicates. */
  skipped: number;
  /** Files that will be added although they are duplicates. */
  addedAnyway: number;
}

/** The counts for the summary line, from the same verdicts the rows show. Unsupported files are in none of them. */
export function countsOf(candidates: Candidate[], rows: Map<string, RowDuplicate>): PrepareCounts {
  const counts: PrepareCounts = { convert: 0, copy: 0, skipped: 0, addedAnyway: 0 };
  for (const candidate of candidates) {
    if (candidate.decision.action === 'unsupported') continue;
    const row = rows.get(candidate.id);
    if (row?.skipped) {
      counts.skipped += 1;
      continue;
    }
    if (row?.addedAnyway) counts.addedAnyway += 1;
    if (candidate.decision.action === 'convert') counts.convert += 1;
    else counts.copy += 1;
  }
  return counts;
}

const files = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;

/** "12 files will be converted, 4 copied as they are, 3 skipped as duplicates". */
export function summaryOf(counts: PrepareCounts): string {
  const parts: string[] = [];
  parts.push(`${files(counts.convert)} will be converted`);
  if (counts.copy) parts.push(`${counts.copy} copied as ${counts.copy === 1 ? 'it is' : 'they are'}`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped as ${counts.skipped === 1 ? 'a duplicate' : 'duplicates'}`);
  return parts.join(', ');
}

/** A duplicate the plan found that the check before converting did not flag. */
export interface MissedDuplicate {
  itemId: string;
  /** The key of the track on the iPod it matches, or null when it repeats another file in the list. */
  trackKey: string | null;
  /** True when the plan left it out. */
  skipped: boolean;
}

/**
 * The files `planSync` called duplicates that the check before converting let through. There should
 * be none, because both use one judge. One can still appear when converting changed what a file is
 * (its length) or when the iPod changed between the two. A duplicate that was added anyway on
 * purpose is not a miss.
 */
export function missedDuplicates(rows: Map<string, RowDuplicate>, found: DuplicateFound[]): MissedDuplicate[] {
  return found
    .filter((entry) => {
      const row = rows.get(entry.itemId);
      return !row || (row.state !== 'on-ipod' && row.state !== 'in-list');
    })
    .map(({ itemId, trackKey, skipped }) => ({ itemId, trackKey, skipped }));
}
