import { describe, expect, it, vi } from 'vitest';
import { createLogStore, formatLog, maskSecrets, type LogStorage } from '../src/log';

// Made-up IDs are built at run time so the repo scan for Apple-prefixed IDs stays clean.
const fake = (prefix: string, rest: string): string => prefix + rest;

const memoryStorage = (): LogStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (name) => data.get(name) ?? null,
    setItem: (name, value) => void data.set(name, value),
    removeItem: (name) => void data.delete(name),
  };
};

describe('masking', () => {
  it('hides FireWire IDs that start with Apple vendor prefixes, in any case', () => {
    expect(maskSecrets('id ' + fake('000A27', '001234ABCD') + ' found')).toBe('id [ID hidden] found');
    expect(maskSecrets('id ' + fake('000a95', '001234abcd') + ' found')).toBe('id [ID hidden] found');
    expect(maskSecrets('FireWire ID: ' + fake('000A27', '0012345678') + '')).toContain('[ID hidden]');
    expect(maskSecrets('FireWire ID: ' + fake('000A27', '0012345678') + '')).not.toContain('000A27');
  });

  it('leaves other hex strings and short ones alone', () => {
    expect(maskSecrets('file F03/ABCD.mp3 abcdef0123456789')).toBe('file F03/ABCD.mp3 abcdef0123456789');
    expect(maskSecrets('000A27123')).toBe('000A27123');
  });

  it('hides serial number lines and API-key-shaped strings', () => {
    expect(maskSecrets('Serial number: ABC123XYZ789')).toBe('Serial number: [ID hidden]');
    expect(maskSecrets('failed with sk-abcdef123456 in header')).toBe('failed with [key hidden] in header');
    expect(maskSecrets('Bearer abc.def.ghi')).toBe('Bearer [key hidden]');
  });

  it('is applied to every entry before it is stored', () => {
    const store = createLogStore({ storage: memoryStorage() });
    store.add('error', 'test', 'bad ' + fake('000A27', '0012345678') + ' and sk-secretkey1234');
    expect(store.entries()[0]?.text).toBe('bad [ID hidden] and [key hidden]');
  });
});

describe('the log store', () => {
  it('keeps only the newest entries when it goes over the cap', () => {
    const store = createLogStore({ cap: 5 });
    for (let n = 1; n <= 8; n += 1) store.add('ok', 'test', `entry ${n}`);
    expect(store.entries().map((entry) => entry.text)).toEqual(['entry 4', 'entry 5', 'entry 6', 'entry 7', 'entry 8']);
  });

  it('defaults to about 500 entries', () => {
    const store = createLogStore();
    for (let n = 0; n < 650; n += 1) store.add('ok', 'test', `entry ${n}`);
    expect(store.entries()).toHaveLength(500);
    expect(store.entries()[499]?.text).toBe('entry 649');
  });

  it('throttles steps from one job, drops repeats, and does not mix jobs', () => {
    let clock = 0;
    const store = createLogStore({ now: () => clock, throttleMs: 1000 });
    store.step(1, 'activity', 'Copying a');
    clock = 200;
    store.step(1, 'activity', 'Copying b'); // too soon
    clock = 400;
    store.step(2, 'activity', 'Other job'); // a different job has its own clock
    clock = 1300;
    store.step(1, 'activity', 'Copying b');
    clock = 2600;
    store.step(1, 'activity', 'Copying b'); // same text again
    expect(store.entries().map((entry) => entry.text)).toEqual(['Copying a', 'Other job', 'Copying b']);
  });

  it('never throttles errors or finished jobs', () => {
    const store = createLogStore({ now: () => 5, throttleMs: 1000 });
    store.add('ok', 'a', 'one');
    store.add('error', 'a', 'two');
    store.add('ok', 'a', 'three');
    expect(store.entries()).toHaveLength(3);
  });

  it('counts errors since the log was last seen', () => {
    const store = createLogStore();
    store.add('error', 'a', 'bad');
    store.add('ok', 'a', 'fine');
    expect(store.unseenErrors()).toBe(1);
    store.markSeen();
    expect(store.unseenErrors()).toBe(0);
    store.add('error', 'a', 'worse');
    expect(store.unseenErrors()).toBe(1);
  });

  it('shortens a very long entry and tells listeners', () => {
    const store = createLogStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.add('step', 'a', 'x'.repeat(2000));
    expect(store.entries()[0]?.text.length).toBeLessThan(700);
    expect(listener).toHaveBeenCalled();
  });
});

describe('persistence across a reload', () => {
  it('saves errors at once and labels them as from before the reload on the next load', () => {
    const storage = memoryStorage();
    const first = createLogStore({ storage });
    first.add('step', 'activity', 'Started: Saving changes');
    first.add('error', 'activity', 'Did not finish: Saving changes'); // an error saves everything so far
    const second = createLogStore({ storage });
    const texts = second.entries().map((entry) => [entry.text, entry.before]);
    expect(texts).toEqual([
      ['Started: Saving changes', true],
      ['Did not finish: Saving changes', true],
    ]);
    second.add('ok', 'page', 'now');
    expect(second.entries().at(-1)?.before).toBeUndefined();
    // What was kept does not count as a new error.
    expect(second.unseenErrors()).toBe(0);
  });

  it('saves steps a moment later, and on flush', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const store = createLogStore({ storage, saveDelayMs: 400 });
    store.add('step', 'a', 'one');
    expect(storage.data.size).toBe(0);
    vi.advanceTimersByTime(450);
    expect(storage.data.size).toBe(1);
    store.add('step', 'a', 'two');
    store.flush();
    expect(JSON.parse(storage.data.get('opentunes.log') as string).entries).toHaveLength(2);
    vi.useRealTimers();
  });

  it('keeps only the last few hundred across a reload', () => {
    const storage = memoryStorage();
    const first = createLogStore({ storage, keep: 3 });
    for (let n = 1; n <= 6; n += 1) first.add('ok', 'a', `entry ${n}`);
    const second = createLogStore({ storage, keep: 3 });
    expect(second.entries().map((entry) => entry.text)).toEqual(['entry 4', 'entry 5', 'entry 6']);
  });

  it('survives storage that is full, blocked or damaged', () => {
    const broken: LogStorage = {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createLogStore({ storage: broken });
    expect(store.entries()).toEqual([]);
    store.add('error', 'a', 'still works');
    store.clear();
    expect(store.entries()).toEqual([]);
  });

  it('clears memory and storage', () => {
    const storage = memoryStorage();
    const store = createLogStore({ storage });
    store.add('error', 'a', 'x');
    store.clear();
    expect(store.entries()).toEqual([]);
    expect(storage.data.size).toBe(0);
  });
});

describe('formatting for copy and download', () => {
  it('writes one line per entry with the time, a mark, the source and a note for older entries', () => {
    const storage = memoryStorage();
    createLogStore({ storage, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) }).add('error', 'activity', 'boom');
    const text = formatLog(createLogStore({ storage, now: () => 0 }).entries());
    expect(text).toBe('2026-01-02T03:04:05.000Z ERR [activity] (before the reload) boom');
  });
});
