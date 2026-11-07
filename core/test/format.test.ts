import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, isValidFireWireId, kindLabel } from '../src/format';

describe('formatBytes', () => {
  it('scales by 1000 and trims needless digits', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.54 KB');
    expect(formatBytes(8_400_000)).toBe('8.4 MB');
    expect(formatBytes(31_000_000)).toBe('31 MB');
    expect(formatBytes(410_000_000)).toBe('410 MB');
    expect(formatBytes(16_000_000_000)).toBe('16 GB');
  });

  it('shows a dash for values that make no sense', () => {
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('shows minutes and seconds, and hours when there are any', () => {
    expect(formatDuration(214000)).toBe('3:34');
    expect(formatDuration(59_000)).toBe('0:59');
    expect(formatDuration(1_980_000)).toBe('33:00');
    expect(formatDuration(5_400_000)).toBe('1:30:00');
  });

  it('shows a dash for zero or unknown lengths', () => {
    expect(formatDuration(0)).toBe('-');
    expect(formatDuration(-5)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
  });
});

describe('kindLabel', () => {
  it('names each kind and passes unknown ones through', () => {
    expect(kindLabel('music-video')).toBe('Music video');
    expect(kindLabel('video-podcast')).toBe('Video podcast');
    expect(kindLabel('something-new')).toBe('something-new');
  });
});

describe('isValidFireWireId', () => {
  it('accepts 16 hex digits and nothing else', () => {
    expect(isValidFireWireId('000A27001234ABCD')).toBe(true);
    expect(isValidFireWireId('000a27001234abcd')).toBe(true);
    expect(isValidFireWireId('REPLACE_ME_WITH_FIREWIRE_GUID')).toBe(false);
    expect(isValidFireWireId('0xDEADBEEF')).toBe(false);
    expect(isValidFireWireId('')).toBe(false);
    expect(isValidFireWireId(null)).toBe(false);
    expect(isValidFireWireId(undefined)).toBe(false);
  });
});
