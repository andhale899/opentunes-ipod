/**
 * What the Backup panel offers to copy besides the library, and what a choice comes to. Pure
 * functions: the panel draws what these return, and the same matching the engine uses
 * (`includeMatcher`) decides which tracks a choice takes, so the numbers shown are the files copied.
 *
 * The library is always saved. On top of that: nothing (the quick backup), or the music and videos
 * by kind, and/or only the tracks selected in the Library tab.
 */
import { includeMatcher, mediaPathOf, trackKey, type OffloadInclude, type TrackInfo } from '@opentunes/engine';

export type MediaGroup = 'music' | 'podcasts' | 'audiobooks' | 'video';

/** The four kinds a person ticks, and the engine kinds each one means. Video podcasts count as video, as in the Library tab. */
export const MEDIA_GROUPS: { id: MediaGroup; label: string; kinds: string[] }[] = [
  { id: 'music', label: 'Music', kinds: ['music'] },
  { id: 'podcasts', label: 'Podcasts', kinds: ['podcast'] },
  { id: 'audiobooks', label: 'Audiobooks', kinds: ['audiobook'] },
  { id: 'video', label: 'Video', kinds: ['movie', 'music-video', 'tv-show', 'video-podcast'] },
];

/** The parts of a track this reads. A real TrackInfo has all of them. */
export type ChoiceTrack = Pick<TrackInfo, 'kind' | 'ipod_path' | 'title' | 'artist' | 'album' | 'tracklen' | 'size'>;

export interface GroupTotals {
  id: MediaGroup;
  label: string;
  /** Tracks with a file on the iPod, counted once per file. */
  files: number;
  /** Their size as the library lists it. */
  bytes: number;
}

/** Files and bytes by kind, from the library the page already holds. Tracks with no file are not counted. */
export function groupTotals(tracks: ChoiceTrack[]): GroupTotals[] {
  const totals = MEDIA_GROUPS.map((group) => ({ id: group.id, label: group.label, files: 0, bytes: 0 }));
  const seen = new Set<string>();
  for (const track of tracks) {
    const path = mediaPathOf(track.ipod_path);
    if (!path || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    const index = MEDIA_GROUPS.findIndex((group) => group.kinds.includes(track.kind));
    const total = index >= 0 ? totals[index] : undefined;
    if (total) {
      total.files += 1;
      total.bytes += track.size;
    }
  }
  return totals;
}

export interface BackupChoice {
  groups: ReadonlySet<MediaGroup>;
  /** "Only the tracks I selected in the Library tab". Counts only while something is selected. */
  selectedOnly: boolean;
}

export const NO_CHOICE: BackupChoice = { groups: new Set(), selectedOnly: false };

export type BackupPlan =
  /** Only the library: `backupIpod`, the quick backup. */
  | { mode: 'library' }
  /** The library and media: `offloadIpod`, with `include` limiting the media (absent: all of it). */
  | { mode: 'media'; include: OffloadInclude | undefined; full: boolean; files: number; bytes: number; tracks: number };

/**
 * What a choice means. Nothing ticked is the quick backup. Kinds and a selection together are
 * both limits (a track must be of a ticked kind and selected). A selection alone takes every kind.
 * All four kinds with no selection is the full copy, which also takes files no track lists.
 */
export function planFor(choice: BackupChoice, tracks: ChoiceTrack[], selection: ReadonlySet<string>): BackupPlan {
  const selectedOnly = choice.selectedOnly && selection.size > 0;
  if (choice.groups.size === 0 && !selectedOnly) return { mode: 'library' };

  const kinds = MEDIA_GROUPS.filter((group) => choice.groups.has(group.id)).flatMap((group) => group.kinds);
  const everyKind = choice.groups.size === MEDIA_GROUPS.length;
  const include: OffloadInclude = {};
  if (choice.groups.size > 0 && !everyKind) include.kinds = kinds;
  if (selectedOnly) include.trackKeys = [...selection];
  const full = include.kinds === undefined && include.trackKeys === undefined;

  const takes = includeMatcher(full ? undefined : include);
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  let count = 0;
  for (const track of tracks) {
    const path = mediaPathOf(track.ipod_path);
    if (!path || !takes(track)) continue;
    count += 1;
    if (seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    files += 1;
    bytes += track.size;
  }
  return { mode: 'media', include: full ? undefined : include, full, files, bytes, tracks: count };
}

/** How many of the selected keys name a track that has a file. */
export function selectedWithFiles(tracks: ChoiceTrack[], selection: ReadonlySet<string>): number {
  return tracks.filter((track) => selection.has(trackKey(track)) && mediaPathOf(track.ipod_path)).length;
}
