import { beforeEach, describe, expect, it } from 'vitest';
import { currentActivity, resetActivity, startActivity } from '../src/activity';
import { memoryKv, useKv } from '../src/kv';
import { resetLock } from '../src/writeLock';
import { track } from '../src/tracked';

beforeEach(() => {
  useKv(memoryKv());
  resetLock();
  resetActivity();
});

describe('the activity store', () => {
  it('shows an activity while it runs and leaves a banner for a finished write', () => {
    const handle = startActivity('Copying to the iPod', { writes: true });
    expect(currentActivity().active.map((item) => item.label)).toEqual(['Copying to the iPod']);
    handle.update('Copying song.mp3');
    expect(currentActivity().active[0]?.message).toBe('Copying song.mp3');
    handle.end(true);
    expect(currentActivity().active).toEqual([]);
    expect(currentActivity().finished).toMatchObject({ label: 'Copying to the iPod', ok: true, writes: true });
  });

  it('leaves no banner for a read that worked, and one for a read that failed', () => {
    startActivity('Reading the iPod').end(true);
    expect(currentActivity().finished).toBeNull();
    startActivity('Reading the iPod').end(false, 'it broke');
    expect(currentActivity().finished).toMatchObject({ ok: false, detail: 'it broke' });
  });

  it('ignores empty steps and a second end', () => {
    const handle = startActivity('x');
    handle.update('');
    expect(currentActivity().active[0]?.message).toBe('');
    handle.end();
    handle.end(false);
    expect(currentActivity().finished).toBeNull();
  });
});

describe('tracking an engine function', () => {
  it('forwards progress to the bar, still calls the original, and ends when it returns', async () => {
    const seen: string[] = [];
    const wrapped = track('Writing', true, async (_root: string, options: { onProgress: (progress: unknown) => void }) => {
      options.onProgress('step one');
      options.onProgress({ message: 'step two', bytesDone: 1 });
      expect(currentActivity().active[0]?.message).toBe('step two');
      expect(currentActivity().active[0]?.writes).toBe(true);
      return 'done';
    });
    const result = await wrapped('root', { onProgress: (progress) => seen.push(typeof progress === 'string' ? progress : (progress as { message: string }).message) });
    expect(result).toBe('done');
    expect(seen).toEqual(['step one', 'step two']);
    expect(currentActivity().active).toEqual([]);
    expect(currentActivity().finished).toMatchObject({ ok: true, writes: true });
  });

  it('ends as failed and rethrows when the function throws', async () => {
    const wrapped = track('Writing', true, async () => {
      throw new Error('disk full');
    });
    await expect(wrapped()).rejects.toThrow('disk full');
    expect(currentActivity().active).toEqual([]);
    expect(currentActivity().finished).toMatchObject({ ok: false, detail: 'disk full' });
  });

  it('works for a function that was given no options', async () => {
    const wrapped = track('Looking', false, async (value: number) => value + 1);
    expect(await wrapped(1)).toBe(2);
  });
});

import { estimateRemaining, formatRemaining, type Activity } from '../src/activity';
import { progressOf } from '../src/tracked';

const base: Activity = { id: 1, label: 'x', message: '', writes: false, startedAt: 0, fraction: null, etaSeconds: null, progressSince: null, progressFrom: 0 };

describe('time left', () => {
  it('says nothing until it has a few seconds of real progress to go on', () => {
    expect(estimateRemaining(base, 60_000)).toBeNull();
    expect(estimateRemaining({ ...base, fraction: 0.01, progressSince: 0, progressFrom: 0 }, 60_000)).toBeNull();
    expect(estimateRemaining({ ...base, fraction: 0.5, progressSince: 0, progressFrom: 0 }, 2_000)).toBeNull();
  });

  it('works the pace out from when progress began, not from when the step started', () => {
    // Started at 0, progress began at 40 s at 0.1, now 80 s at 0.5: 0.4 in 40 s, 0.5 left is 50 s.
    const activity: Activity = { ...base, startedAt: 0, fraction: 0.5, progressSince: 40_000, progressFrom: 0.1 };
    expect(estimateRemaining(activity, 80_000)).toBeCloseTo(50, 5);
  });

  it('prefers an estimate the step worked out itself', () => {
    expect(estimateRemaining({ ...base, etaSeconds: 90, fraction: 0.5, progressSince: 0 }, 60_000)).toBe(90);
  });

  it('says it the way a person would', () => {
    expect(formatRemaining(3)).toBe('a few seconds left');
    expect(formatRemaining(23)).toBe('about 25 seconds left');
    expect(formatRemaining(95)).toBe('about 2 min left');
    expect(formatRemaining(14 * 60)).toBe('about 15 min left');
    expect(formatRemaining(3600 + 25 * 60)).toBe('about 1 h 25 min left');
    expect(formatRemaining(3599 + 30 * 60)).toBe('about 1 h 30 min left');
  });
});

describe('reading how far along the engine says it is', () => {
  it('maps a sync so the bar moves the whole way and gives a time left while copying', () => {
    const copying = progressOf({ phase: 'copying', message: 'x', bytesDone: 500, bytesTotal: 1000, bytesPerSecond: 10, currentFile: null });
    expect(copying?.fraction).toBeCloseTo(0.04 + 0.43, 5);
    expect(copying?.etaSeconds).toBeCloseTo(50 + 15, 5);
    expect(progressOf({ phase: 'database', bytesDone: 1000, bytesTotal: 1000, bytesPerSecond: 10 })?.fraction).toBe(0.9);
    expect(progressOf({ phase: 'verifying', bytesDone: 1000, bytesTotal: 1000, bytesPerSecond: 10 })?.fraction).toBe(0.95);
    expect(progressOf({ phase: 'rolling-back', bytesDone: 5, bytesTotal: 10, bytesPerSecond: 1 })).toBeUndefined();
  });

  it('maps an offload by bytes, and by files when there are no bytes', () => {
    expect(progressOf({ phase: 'copying', filesDone: 1, filesTotal: 4, bytesDone: 250, bytesTotal: 1000, bytesPerSecond: 50 })).toEqual({ fraction: 0.25, etaSeconds: 15 });
    expect(progressOf({ phase: 'copying', filesDone: 1, filesTotal: 4, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0 })?.fraction).toBe(0.25);
  });

  it('knows nothing from a plain message or a report with no counts', () => {
    expect(progressOf('Reading...')).toBeUndefined();
    expect(progressOf({ message: 'x' })).toBeUndefined();
  });
});
