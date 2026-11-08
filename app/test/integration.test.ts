// Where the controls work (Stop, Pause) meets the robustness work (write note, write lock): one
// reading of a finished job feeds both the bar and the note, and the bar shows stopped, paused and
// rolled back. Also the leave-the-page warning for held work.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PauseGate } from '@opentunes/engine';
import { currentActivity, holdWork, isHoldingWork, requestStop, resetActivity, startActivity, togglePause } from '../src/activity';
import { journalState, resetJournal, setJournalContext } from '../src/journal';
import { memoryKv, useKv } from '../src/kv';
import { createLogStore, useLogStore } from '../src/log';
import { judgeWrite, restoreOffloadStop, track } from '../src/tracked';
import { lockState, resetLock } from '../src/writeLock';

const store = memoryKv();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = { ipod: 'MY IPOD', backup: 'opentunes-backup-2026-11-07-1200', practice: false };

beforeEach(() => {
  useKv(store);
  void store.delete('write-journal');
  useLogStore(createLogStore());
  resetJournal();
  resetLock();
  resetActivity();
  setJournalContext(context);
});

describe('one reading of a finished job', () => {
  it('reads a rolled-back write as not done, and keeps the verdict the note needs', () => {
    expect(judgeWrite({ verified: false, rolledBack: true, failures: ['x did not match'] })).toMatchObject({ ok: false, stopped: false, outcome: 'undone', detail: 'x did not match' });
    expect(judgeWrite({ verified: false, rolledBack: true, rollbackFailures: ['y was not put back'] })).toMatchObject({ ok: false, outcome: 'problem' });
  });

  it('reads a clean stop as stopped, not as a failure, and an unclean one as a problem', () => {
    expect(judgeWrite({ verified: false, aborted: true, rolledBack: true, failures: ['stopped'], rollbackFailures: [] })).toMatchObject({ ok: true, stopped: true, outcome: 'undone' });
    // A stop after the library was written leaves a consistent iPod, so the note is cleared.
    expect(judgeWrite({ verified: true, aborted: true, rolledBack: false, failures: ['stopped'] })).toMatchObject({ ok: true, stopped: true, outcome: 'clean' });
    expect(judgeWrite({ verified: false, aborted: true, rolledBack: true, rollbackFailures: ['z'] })).toMatchObject({ ok: false, stopped: false, outcome: 'problem' });
    expect(judgeWrite({ verified: false, aborted: true, restoreNeeded: true, rolledBack: true })).toMatchObject({ ok: false, outcome: 'problem' });
  });

  it('reads a backup that was stopped or is incomplete', () => {
    expect(judgeWrite({ complete: false, stopped: true, failures: ['The backup was stopped'] })).toMatchObject({ ok: true, stopped: true });
    expect(judgeWrite({ complete: false, failures: ['a file could not be read'] })).toMatchObject({ ok: false, detail: 'a file could not be read' });
    expect(judgeWrite({ complete: true, stopped: false, failures: [] })).toMatchObject({ ok: true, stopped: false });
    // A backup report counts its verified files as a number, which must not read as "not verified".
    expect(judgeWrite({ folder: 'b', files: 5, bytes: 9, verified: 5, failures: [], left: [], complete: true, stopped: false })).toMatchObject({ ok: true, stopped: false });
    expect(judgeWrite({ folder: 'b', files: 5, bytes: 9, verified: 4, failures: ['x'], left: [], complete: false, stopped: false })).toMatchObject({ ok: false, detail: 'x' });
  });

  it('reads the report of putting an offload copy back', () => {
    const base = { files: {}, bytes: {}, failures: [] as unknown[], summary: 'It did not finish.', elapsedMs: 1, bytesPerSecond: 0 };
    expect(judgeWrite({ ...base, stopped: true, complete: false, database: null })).toMatchObject({ ok: true, stopped: true, outcome: 'clean' });
    expect(judgeWrite({ ...base, stopped: false, complete: true, database: { verified: true, failures: [] } })).toMatchObject({ ok: true });
    // Files that did not copy back leave the library alone: not a problem for the note, but not done.
    expect(judgeWrite({ ...base, stopped: false, complete: false, failures: [{ path: 'F00/A.mp3', reason: 'x' }], database: null })).toMatchObject({ ok: false, outcome: 'clean', detail: 'It did not finish.' });
    // A library that was put back but does not read back needs a look.
    expect(judgeWrite({ ...base, stopped: false, complete: false, database: { verified: false, restored: 3, bytes: 1, failures: ['iTunesCDB did not match'], signatures: [] } })).toMatchObject({ ok: false, outcome: 'problem', detail: 'iTunesCDB did not match' });
  });
});

describe('the bar and the interrupted-write note agree', () => {
  it('shows a rolled-back write as did not finish and clears the note, because the iPod is as it was', async () => {
    await track('Copying to the iPod', true, async () => ({ verified: false, rolledBack: true, rollbackFailures: [], failures: ['The iPod could not be read back.'] }))();
    expect(currentActivity().finished).toMatchObject({ ok: false, stopped: false, writes: true });
    expect(await store.get('write-journal')).toBeUndefined();
  });

  it('shows a stopped write as stopped, and clears the note', async () => {
    const wrapped = track(
      'Copying to the iPod',
      true,
      async (_plan: object, options: { signal?: AbortSignal }) => {
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()));
        return { verified: false, aborted: true, rolledBack: true, rollbackFailures: [], failures: ['stopped'] };
      },
      { stop: { label: 'Stop', at: 1 } },
    );
    const run = wrapped({}, {});
    await tick();
    expect(await store.get('write-journal')).toMatchObject({ status: 'running' });
    expect(requestStop(currentActivity().active[0]?.id ?? -1)).toBe(true);
    await run;
    expect(currentActivity().finished).toMatchObject({ ok: true, stopped: true, writes: true });
    expect(await store.get('write-journal')).toBeUndefined();
    expect(lockState().writing).toBeNull();
  });

  it('shows a stop thrown before anything was written as stopped, and clears the note', async () => {
    const wrapped = track(
      'Putting everything back on the iPod',
      true,
      async (_options: object) => {
        throw new DOMException('Stopped', 'AbortError');
      },
      { stop: { label: 'Stop', at: 0 } },
    );
    await expect(wrapped({})).rejects.toThrow();
    expect(currentActivity().finished).toMatchObject({ ok: true, stopped: true });
    expect(await store.get('write-journal')).toBeUndefined();
    expect(lockState().writing).toBeNull();
  });

  it('keeps the note, and says it did not finish, when files could not be put back', async () => {
    await track('Copying to the iPod', true, async () => ({ verified: false, rolledBack: true, rollbackFailures: ['a was not put back'], failures: ['b'] }))();
    expect(currentActivity().finished).toMatchObject({ ok: false });
    expect(await store.get('write-journal')).toMatchObject({ status: 'failed' });
    expect(journalState().entry).not.toBeNull();
  });

  it('shows pausing and paused while a write job waits between files, and the lock stays held', async () => {
    let seen: string[] = [];
    let go: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (go = resolve));
    const wrapped = track(
      'Copying to the iPod',
      true,
      async (_plan: object, options: { pause?: PauseGate; signal?: AbortSignal }) => {
        const gate = options.pause as PauseGate;
        gate.join();
        try {
          // One file of work, then the next checkpoint.
          await started;
          await gate.checkpoint(options.signal);
        } finally {
          gate.leave();
        }
        return { verified: true, rolledBack: false, failures: [] };
      },
      { pause: true },
    );
    const run = wrapped({}, {});
    await tick();
    const id = currentActivity().active[0]?.id ?? -1;
    expect(currentActivity().active[0]?.pause).toBe('running');
    togglePause(id);
    expect(currentActivity().active[0]?.pause).toBe('pausing');
    go();
    await tick();
    seen = [String(currentActivity().active[0]?.pause)];
    expect(seen).toEqual(['paused']);
    expect(lockState().writing).toBe('Copying to the iPod');
    togglePause(id);
    await run;
    expect(currentActivity().finished).toMatchObject({ ok: true, writes: true });
    expect(lockState().writing).toBeNull();
  });
});

describe('putting an offload copy back', () => {
  it('lets Stop through while files are copied and refuses it once the library files are being put back', () => {
    const blocked = restoreOffloadStop.blocked as (progress: unknown) => string | null;
    expect(blocked({ phase: 'checking' })).toBeNull();
    expect(blocked({ phase: 'copying' })).toBeNull();
    expect(blocked({ phase: 'restoring' })).toMatch(/cannot be stopped safely/);
    // The options object is the third argument.
    expect(restoreOffloadStop.at).toBe(2);
  });
});

describe('work held in the page that a reload would lose', () => {
  const added: string[] = [];
  const removed: string[] = [];
  const realWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    added.length = 0;
    removed.length = 0;
    (globalThis as { window?: unknown }).window = {
      addEventListener: (name: string) => added.push(name),
      removeEventListener: (name: string) => removed.push(name),
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = realWindow;
  });

  it('asks before leaving while converted files are held, and stops asking once they are released', () => {
    expect(isHoldingWork()).toBe(false);
    const release = holdWork();
    expect(isHoldingWork()).toBe(true);
    expect(added).toContain('beforeunload');
    release();
    release();
    expect(isHoldingWork()).toBe(false);
    expect(removed.at(-1)).toBe('beforeunload');
  });

  it('keeps asking while either a job or held work remains', () => {
    const release = holdWork();
    const job = startActivity('Converting');
    release();
    expect(isHoldingWork()).toBe(false);
    expect(removed.length).toBe(0);
    job.end();
    expect(removed.at(-1)).toBe('beforeunload');
  });
});
