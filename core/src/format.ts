/** Plain-language formatting for sizes and lengths shown to a person. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 1536 becomes "1.5 KB". Uses 1000, the way storage on an iPod is sold and reported. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  let text = value.toFixed(digits);
  if (text.includes('.')) {
    text = text.replace(/\.?0+$/, ''); // only ever trim zeros after the decimal point
  }
  return `${text} ${UNITS[unit]}`;
}

/** 214000 milliseconds becomes "3:34", and a long one "1:30:00". */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '-';
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

const KIND_LABELS: Record<string, string> = {
  music: 'Music',
  movie: 'Movie',
  'music-video': 'Music video',
  'tv-show': 'TV show',
  podcast: 'Podcast',
  'video-podcast': 'Video podcast',
  audiobook: 'Audiobook',
  unspecified: 'Unspecified',
  other: 'Other',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** A FireWire ID is 16 hex digits. The nano 6G and 7G cannot be written without a real one. */
export function isValidFireWireId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^[0-9a-f]{16}$/i.test(id);
}
