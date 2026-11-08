/**
 * A plain estimate of how long a copy has left, from the bytes still to go and the speed so far.
 * Null until there is a speed to go on, or when nothing is left. The estimate is rough on purpose:
 * USB speed changes, and closing each file costs a fixed amount, so it says "about".
 */
export function timeLeftText(bytesLeft: number, bytesPerSecond: number): string | null {
  if (!(bytesLeft > 0) || !(bytesPerSecond > 0) || !Number.isFinite(bytesLeft) || !Number.isFinite(bytesPerSecond)) return null;
  const seconds = bytesLeft / bytesPerSecond;
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest ? ` ${rest} min` : ''} left`;
}
