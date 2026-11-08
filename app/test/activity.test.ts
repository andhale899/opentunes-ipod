import { beforeEach, describe, expect, it } from 'vitest';
import { currentActivity, resetActivity, startActivity } from '../src/activity';
import { track } from '../src/tracked';

beforeEach(() => resetActivity());

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
