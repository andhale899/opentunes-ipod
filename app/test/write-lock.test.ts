import { beforeEach, describe, expect, it } from 'vitest';
import { WriteBusyError, TAB_LOCK_NAME, beginRead, beginWrite, lockState, resetLock, tabLockHeld, takeTabLock, type LocksLike } from '../src/writeLock';

beforeEach(() => resetLock());

describe('the in-page write lock', () => {
  it('refuses a second write with a plain message that names the first', () => {
    const release = beginWrite('Saving changes to the iPod');
    expect(() => beginWrite('Copying to the iPod')).toThrow(WriteBusyError);
    expect(() => beginWrite('Copying to the iPod')).toThrow(/already running \(saving changes to the iPod\)/);
    release();
    expect(() => beginWrite('Copying to the iPod')).not.toThrow();
  });

  it('is taken at once, so two calls in the same tick cannot both get in', () => {
    const results = [() => beginWrite('one'), () => beginWrite('two')].map((take) => {
      try {
        take();
        return 'got it';
      } catch {
        return 'refused';
      }
    });
    expect(results).toEqual(['got it', 'refused']);
  });

  it('refuses a read while a write runs, and a write while a read is under way', () => {
    const release = beginWrite('Removing from the iPod');
    expect(() => beginRead('Checking the iPod')).toThrow(/being changed right now/);
    release();
    const endRead = beginRead('Checking the iPod');
    expect(() => beginWrite('Copying to the iPod')).toThrow(/still being read/);
    endRead();
    expect(() => beginWrite('Copying to the iPod')).not.toThrow();
  });

  it('lets reads run side by side', () => {
    beginRead('a');
    expect(() => beginRead('b')).not.toThrow();
    expect(lockState().reading).toEqual(['a', 'b']);
  });

  it('gives the lock back once, and a second release does not free a later holder', () => {
    const first = beginWrite('one');
    first();
    const second = beginWrite('two');
    first();
    expect(lockState().writing).toBe('two');
    second();
    expect(lockState().writing).toBeNull();
  });
});

describe('the lock across browser tabs', () => {
  const fakeLocks = (held: { value: boolean }): LocksLike => ({
    request: async (_name, _options, callback) => {
      if (held.value) return callback(null);
      held.value = true;
      try {
        return await callback({ name: TAB_LOCK_NAME });
      } finally {
        held.value = false;
      }
    },
    query: async () => ({ held: held.value ? [{ name: TAB_LOCK_NAME }] : [] }),
  });

  it('is held until released, and another tab is refused meanwhile', async () => {
    const held = { value: false };
    const locks = fakeLocks(held);
    const release = await takeTabLock(locks);
    expect(held.value).toBe(true);
    expect(await tabLockHeld(locks)).toBe(true);
    await expect(takeTabLock(locks)).rejects.toThrow(/another OpenTunes tab/i);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.value).toBe(false);
    expect(await tabLockHeld(locks)).toBe(false);
  });

  it('does nothing where the browser has no locks', async () => {
    expect(await takeTabLock(undefined)).toBeNull();
    expect(await tabLockHeld(undefined)).toBe(false);
  });

  it('does not stop a change when the browser refuses the call', async () => {
    const release = await takeTabLock({
      request: async () => {
        throw new Error('no');
      },
    });
    expect(typeof release).toBe('function');
  });
});
