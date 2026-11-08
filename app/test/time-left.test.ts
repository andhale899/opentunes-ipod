import { describe, expect, it } from 'vitest';
import { timeLeftText } from '../src/timeLeft';

describe('time left', () => {
  it('says nothing until there is a speed, and nothing when nothing is left', () => {
    expect(timeLeftText(1000, 0)).toBeNull();
    expect(timeLeftText(0, 1000)).toBeNull();
    expect(timeLeftText(-5, 1000)).toBeNull();
    expect(timeLeftText(Number.NaN, 1000)).toBeNull();
    expect(timeLeftText(1000, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('is under a minute for a short wait', () => {
    expect(timeLeftText(10_000_000, 1_000_000)).toBe('less than a minute left');
    expect(timeLeftText(59_000_000, 1_000_000)).toBe('less than a minute left');
  });

  it('rounds to whole minutes, then to hours and minutes', () => {
    expect(timeLeftText(60_000_000, 1_000_000)).toBe('about 1 minute left');
    expect(timeLeftText(300_000_000, 1_000_000)).toBe('about 5 minutes left');
    expect(timeLeftText(3_600_000_000, 1_000_000)).toBe('about 1 h left');
    expect(timeLeftText(4_800_000_000, 1_000_000)).toBe('about 1 h 20 min left');
  });
});
