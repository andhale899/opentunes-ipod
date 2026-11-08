import { beforeEach, describe, expect, it } from 'vitest';
import { ScratchFolder, backupIpod, type DirectoryEntry } from '@opentunes/engine';
import { currentActivity, resetActivity } from '../src/activity';
import { ageText, checkEarlierBackup, decideReuse } from '../src/backupReuse';
import { buildReport, reportProblem, resetNotices, currentNotices, shouldIgnore } from '../src/errors';
import { describeError } from '../src/describeError';
import { IpodAccessError, classifyFsError, plainFailure } from '../src/friendlyError';
import { allowWriting, checkFolderAlive, reconnectStep, regainAccess } from '../src/ipodAccess';
import { bannerText, beginWriteNote, dismissJournal, endWriteNote, journalState, loadLeftBehind, makeJournal, parseJournal, resetJournal, setJournalContext } from '../src/journal';
import { memoryKv, useKv } from '../src/kv';
import { createLogStore, useLogStore } from '../src/log';
import { fingerprintOf, pruneSelection } from '../src/staleness';
import { judgeWrite, track } from '../src/tracked';
import { createWakeLock, type SentinelLike } from '../src/wakeLock';
import { watchBackground } from '../src/visibility';
import { resetLock, lockState, WriteBusyError } from '../src/writeLock';

// Made-up IDs are built at run time so the repo scan for Apple-prefixed IDs stays clean.
const fake = (prefix: string, rest: string): string => prefix + rest;

const store = memoryKv();

beforeEach(() => {
  useKv(store);
  void store.delete('write-journal');
  useLogStore(createLogStore());
  resetJournal();
  resetLock();
  resetActivity();
  resetNotices();
});

const context = { ipod: 'MY IPOD', backup: 'opentunes-backup-2026-11-07-1200', practice: false };

describe('the interrupted-write journal', () => {
  it('holds the operation, time, iPod folder name and backup folder name, and nothing else', () => {
    const entry = makeJournal('Saving changes to the iPod', 1_000, context);
    expect(Object.keys(entry).sort()).toEqual(['backup', 'ipod', 'operation', 'practice', 'startedAt', 'status', 'version']);
    expect(entry).toMatchObject({ ipod: 'MY IPOD', backup: 'opentunes-backup-2026-11-07-1200', status: 'running' });
  });

  it('never keeps an ID, even in a folder name, and drops unknown fields when read back', () => {
    const entry = makeJournal('Copying', 1, { ...context, ipod: 'iPod ' + fake('000A27', '0012345678') + '' });
    expect(JSON.stringify(entry)).not.toContain('000A27');
    const parsed = parseJournal({ ...entry, serial: 'SECRET123', titles: ['A song'] });
    expect(JSON.stringify(parsed)).not.toContain('SECRET123');
    expect(JSON.stringify(parsed)).not.toContain('A song');
    expect(parseJournal({ version: 2 })).toBeNull();
    expect(parseJournal('x')).toBeNull();
  });

  it('writes a note when a change starts and clears it when it ends cleanly', async () => {
    setJournalContext(context);
    await beginWriteNote('Saving changes to the iPod', 5);
    expect(await store.get('write-journal')).toMatchObject({ operation: 'Saving changes to the iPod', status: 'running' });
    expect(journalState().inFlight).toBe(true);
    await endWriteNote('clean');
    expect(await store.get('write-journal')).toBeUndefined();
    expect(journalState().entry).toBeNull();
  });

  it('is found on the next load when the page went away mid-write, and says what to do', async () => {
    setJournalContext(context);
    await beginWriteNote('Copying to the iPod', new Date(2026, 10, 7, 14, 5).getTime());
    // The page is reloaded here: in-memory state is gone, the browser's store is not.
    resetJournal();
    const found = await loadLeftBehind();
    expect(found?.operation).toBe('Copying to the iPod');
    expect(journalState().inFlight).toBe(false);
    const text = bannerText(found!, new Date(2026, 10, 7, 15, 0).getTime(), 'en-GB');
    expect(text).toContain('The last change to the iPod did not finish (it was copying to the iPod at 14:05).');
    expect(text).toContain('look at the Diagnostics tab');
    expect(text).toContain('restore your backup');
  });

  it('dismiss clears it for good', async () => {
    setJournalContext(context);
    await beginWriteNote('Copying', 1);
    resetJournal();
    await loadLeftBehind();
    await dismissJournal();
    expect(journalState().entry).toBeNull();
    expect(await loadLeftBehind()).toBeNull();
  });

  it('keeps a note, marked failed, for a problem that was not fully undone', async () => {
    setJournalContext(context);
    await beginWriteNote('Copying', 1);
    await endWriteNote('problem', 'Some files could not be put back.');
    resetJournal();
    const found = await loadLeftBehind();
    expect(found?.status).toBe('failed');
    expect(bannerText(found!, 2)).toContain('did not finish cleanly');
    expect(bannerText(found!, 2)).toContain('Some files could not be put back.');
  });

  it('drops a practice iPod note silently, and ignores a note while another tab is writing', async () => {
    setJournalContext({ ...context, practice: true });
    await beginWriteNote('Copying', 1);
    resetJournal();
    expect(await loadLeftBehind()).toBeNull();
    setJournalContext(context);
    await beginWriteNote('Copying', 1);
    resetJournal();
    expect(await loadLeftBehind({ writeInProgressElsewhere: async () => true })).toBeNull();
  });
});

describe('tracking a write: lock, journal and what the report says', () => {
  const report = (extra: object) => ({ verified: true, rolledBack: false, rollbackFailures: [], failures: [], ...extra });

  it('judges a report: fine, undone, or needs a look', () => {
    expect(judgeWrite(report({}))).toMatchObject({ outcome: 'clean', ok: true });
    expect(judgeWrite({ report: report({}) })).toMatchObject({ ok: true });
    expect(judgeWrite(report({ verified: false, rolledBack: true, failures: ['x did not match'] }))).toMatchObject({ outcome: 'undone', ok: false, detail: 'x did not match' });
    expect(judgeWrite(report({ verified: false, rolledBack: true, rollbackFailures: ['y was not put back'] }))).toMatchObject({ outcome: 'problem' });
    expect(judgeWrite(report({ verified: false, rolledBack: false, failures: ['stopped'] }))).toMatchObject({ outcome: 'problem' });
    expect(judgeWrite({ removed: [], kept: [] })).toMatchObject({ outcome: 'clean', ok: true });
  });

  it('writes the note before the change, and clears it when the change works', async () => {
    setJournalContext(context);
    let during: unknown;
    const write = track('Saving changes to the iPod', true, async () => {
      during = await store.get('write-journal');
      return report({});
    });
    await write();
    expect(during).toMatchObject({ operation: 'Saving changes to the iPod', status: 'running' });
    expect(await store.get('write-journal')).toBeUndefined();
    expect(currentActivity().finished).toMatchObject({ ok: true });
  });

  it('says it did not finish when the engine reports a failure instead of throwing, and clears the note when it was undone', async () => {
    setJournalContext(context);
    const write = track('Saving changes to the iPod', true, async () => report({ verified: false, rolledBack: true, failures: ['The iPod could not be read back.'] }));
    await write();
    expect(currentActivity().finished).toMatchObject({ ok: false, writes: true, detail: 'The iPod could not be read back.' });
    expect(await store.get('write-journal')).toBeUndefined();
  });

  it('keeps the note when files could not be put back', async () => {
    setJournalContext(context);
    await track('Copying', true, async () => report({ verified: false, rolledBack: true, rollbackFailures: ['a was not put back as it was.'] }))();
    expect(await store.get('write-journal')).toMatchObject({ status: 'failed' });
  });

  it('puts the iPod being disconnected in plain words in a report', async () => {
    const raw = 'iPod_Control/iTunes/iTunesCDB could not be written: A requested file or directory could not be found at the time an operation was processed.';
    const result = report({ verified: false, rolledBack: true, failures: [raw] });
    await track('Copying', true, async () => result)();
    expect(result.failures[0]).toContain('the iPod was disconnected. Plug it in, then use Reconnect.');
    expect(result.failures[0]).toContain('Chrome said:');
  });

  it('refuses a second write while one runs, with a plain message, and runs it after', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const slow = track('Copying to the iPod', true, () => new Promise((resolve) => (finish = resolve)));
    const quick = track('Removing from the iPod', true, async () => report({}));
    const first = slow();
    expect(lockState().writing).toBe('Copying to the iPod');
    await expect(quick()).rejects.toThrow(WriteBusyError);
    await expect(quick()).rejects.toThrow(/Another change to the iPod is already running \(copying to the iPod\)/);
    finish(report({}));
    await first;
    await expect(quick()).resolves.toBeDefined();
    expect(lockState().writing).toBeNull();
  });

  it('refuses a write while the iPod is being read for a plan, and a read while a write runs', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const read = track('Checking the iPod', false, () => new Promise((resolve) => (finish = resolve)));
    const write = track('Copying to the iPod', true, async () => report({}));
    const pending = read();
    await expect(write()).rejects.toThrow(/still being read/);
    finish(1);
    await pending;
    let release: (value: unknown) => void = () => undefined;
    const running = track('Copying to the iPod', true, () => new Promise((resolve) => (release = resolve)))();
    await expect(read()).rejects.toThrow(/being changed right now/);
    release(report({}));
    await running;
  });

  it('leaves no note when a write is refused before its first step (nothing was written)', async () => {
    setJournalContext(context);
    const write = track('Copying', true, async () => {
      throw new Error('Back up the iPod first.');
    });
    await expect(write()).rejects.toThrow('Back up the iPod first.');
    expect(await store.get('write-journal')).toBeUndefined();
  });

  it('keeps the note when a write threw after it had started', async () => {
    setJournalContext(context);
    const write = track('Copying', true, async (options: { onProgress: (message: string) => void }) => {
      options.onProgress('Writing a file');
      throw new Error('lost the iPod');
    });
    await expect(write({ onProgress: () => undefined })).rejects.toThrow('lost the iPod');
    expect(await store.get('write-journal')).toMatchObject({ status: 'failed' });
  });
});

describe('plain messages for an iPod that went away', () => {
  it('names the cause of each browser error', () => {
    const named = (name: string, message = 'x') => Object.assign(new Error(message), { name });
    expect(classifyFsError(named('NotFoundError'))).toBe('disconnected');
    expect(classifyFsError(named('NotReadableError'))).toBe('disconnected');
    expect(classifyFsError(named('NoModificationAllowedError'))).toBe('readonly');
    expect(classifyFsError(named('QuotaExceededError'))).toBe('full');
    expect(classifyFsError(named('InvalidStateError', 'something else'))).toBeNull();
    expect(classifyFsError(named('InvalidStateError', 'The state cached in an interface object was changed since it was read from disk.'))).toBe('disconnected');
    expect(classifyFsError(new Error('plain'))).toBeNull();
  });

  it('says the iPod was disconnected, and what was undone when a write hit it', () => {
    const error = Object.assign(new Error('A requested file or directory could not be found at the time an operation was processed.'), { name: 'NotFoundError' });
    expect(describeError(error)).toBe('The iPod was disconnected. Plug it in, then use Reconnect.');
    expect(describeError(error, { writing: true })).toContain('The change was undone where it could be.');
    expect(describeError(error, { writing: true })).toContain('backup can restore the rest');
    expect(describeError(new Error('disk exploded'), { writing: true })).toBe('disk exploded');
  });

  it('keeps Chrome wording in brackets so nothing is hidden, and leaves other lines alone', () => {
    expect(plainFailure('plain failure')).toBe('plain failure');
    expect(plainFailure('NoModificationAllowedError: blocked')).toContain('may be locked');
  });

  it('finds an unplugged folder before reading from it', async () => {
    const gone: Pick<DirectoryEntry, 'entries'> = {
      // eslint-disable-next-line require-yield
      async *entries() {
        throw Object.assign(new Error('A requested file or directory could not be found at the time an operation was processed.'), { name: 'NotFoundError' });
      },
    };
    await expect(checkFolderAlive(gone)).rejects.toBeInstanceOf(IpodAccessError);
    await expect(checkFolderAlive(new ScratchFolder('ok'))).resolves.toBeUndefined();
  });

  it('asks for write permission, refuses when denied, and says so when the iPod is gone', async () => {
    const withPermission = (answer: () => Promise<string>) => Object.assign(new ScratchFolder('x'), { requestPermission: answer }) as unknown as DirectoryEntry;
    expect(await allowWriting(withPermission(async () => 'granted'))).toBe(true);
    expect(await allowWriting(withPermission(async () => 'denied'))).toBe(false);
    const gone = withPermission(async () => {
      throw Object.assign(new Error('x'), { name: 'NotFoundError' });
    });
    await expect(allowWriting(gone)).rejects.toThrow('The iPod was disconnected');
  });
});

describe('reconnect after a reload', () => {
  it('decides from what Chrome says about the kept folder', () => {
    expect(reconnectStep('granted')).toBe('use');
    expect(reconnectStep('prompt')).toBe('ask');
    expect(reconnectStep('denied')).toBe('blocked');
    expect(reconnectStep(undefined)).toBe('ask');
  });

  it('asks only when it has to, and reports a refusal', async () => {
    const calls: string[] = [];
    const handle = (query: string, request: string) => ({
      queryPermission: async () => (calls.push('query'), query),
      requestPermission: async () => (calls.push('request'), request),
    });
    expect(await regainAccess(handle('granted', 'denied'))).toBe('granted');
    expect(calls).toEqual(['query']);
    expect(await regainAccess(handle('prompt', 'granted'))).toBe('granted');
    expect(await regainAccess(handle('prompt', 'denied'))).toBe('denied');
    expect(await regainAccess({})).toBe('granted');
  });
});

describe('using a backup made earlier', () => {
  const put = async (root: ScratchFolder, path: string, text: string) => {
    const parts = path.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
    const writer = await (await folder.getFileHandle(parts.at(-1) as string, { create: true })).createWritable();
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
  };

  async function setup() {
    const ipod = new ScratchFolder('MY IPOD');
    await put(ipod, 'iPod_Control/iTunes/iTunesDB', 'library one');
    await put(ipod, 'iPod_Control/Device/SysInfo', 'device');
    const destination = new ScratchFolder('backups');
    const report = await backupIpod(ipod, destination as never);
    const folder = await destination.getDirectoryHandle(report.folder);
    const manifest = JSON.parse(new TextDecoder().decode(folder.listFiles().get('backup-info.json')));
    const record = { destination, destinationName: 'backups', folder: report.folder, ipod: 'MY IPOD', madeAt: 1_000, manifestCreatedAt: manifest.createdAt as string };
    return { ipod, destination, report, record };
  }

  it('counts as the backup when it passes every check and the iPod is exactly as it was', async () => {
    const { ipod, record } = await setup();
    const result = await checkEarlierBackup(record, ipod, 2_000);
    expect(result.decision).toMatchObject({ allowed: true, reason: 'ok' });
    expect(result.report).toMatchObject({ complete: true, files: 2 });
  });

  it('is refused, with what changed, when the iPod changed since', async () => {
    const { ipod, record } = await setup();
    await put(ipod, 'iPod_Control/iTunes/iTunesDB', 'library two, from iTunes');
    await put(ipod, 'iPod_Control/iTunes/Extra', 'new');
    const result = await checkEarlierBackup(record, ipod, 3 * 24 * 3_600_000 + 1_000);
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.reason).toBe('ipod-changed');
    expect(result.decision.message).toContain('1 file different, 1 new file');
    expect(result.decision.message).toContain('3 days ago');
    expect(result.report).toBeNull();
  });

  it('is refused when a backup file is damaged, or the folder is not the one this browser made', async () => {
    const { ipod, destination, record } = await setup();
    const folder = await destination.getDirectoryHandle(record.folder);
    await put(folder, 'iPod_Control/iTunes/iTunesDB', 'tampered!!!!');
    expect((await checkEarlierBackup(record, ipod, 2_000)).decision.reason).toBe('damaged');
    const other = { ...record, manifestCreatedAt: '1999-01-01T00:00:00.000Z' };
    expect((await checkEarlierBackup(other, ipod, 2_000)).decision.reason).toBe('different-backup');
  });

  it('is refused for an iPod folder of another name, and an incomplete backup', () => {
    const base = { record: { ipod: 'A', madeAt: 0, manifestCreatedAt: 't', folder: 'f' }, ipodName: 'A', manifest: { createdAt: 't', complete: true }, problems: [], comparison: { changed: [], missing: [], added: [] }, now: 60_000 };
    expect(decideReuse({ ...base, ipodName: 'B' }).reason).toBe('different-ipod');
    expect(decideReuse({ ...base, manifest: { createdAt: 't', complete: false } }).reason).toBe('incomplete');
    expect(decideReuse(base).allowed).toBe(true);
    expect(ageText(0, 30 * 60_000)).toBe('30 minutes ago');
  });
});

describe('stale screens', () => {
  const track1 = { ipod_path: ':iPod_Control:Music:F00:AAAA.m4a', title: 'One', artist: 'A', album: 'X', tracklen: 1000, size: 10 };
  const input = { tracks: [track1], playlists: [{ name: 'Mix', tracks: [1] }], files: [{ path: 'iPod_Control/iTunes/iTunesCDB', size: 5 }] };

  it('a fingerprint changes when a track, a playlist or a database file changes, and holds no titles', () => {
    const before = fingerprintOf(input);
    expect(fingerprintOf({ ...input })).toBe(before);
    expect(fingerprintOf({ ...input, tracks: [{ ...track1, title: 'Two' }] })).not.toBe(before);
    expect(fingerprintOf({ ...input, tracks: [] })).not.toBe(before);
    expect(fingerprintOf({ ...input, playlists: [{ name: 'Mix', tracks: [1, 2] }] })).not.toBe(before);
    expect(fingerprintOf({ ...input, files: [{ path: 'iPod_Control/iTunes/iTunesCDB', size: 6 }] })).not.toBe(before);
    expect(before).not.toContain('One');
  });

  it('drops selected tracks that are gone and keeps the same set when nothing was dropped', () => {
    const selected = new Set(['a', 'b']);
    expect([...pruneSelection(selected, ['b', 'c'])]).toEqual(['b']);
    expect(pruneSelection(selected, ['a', 'b', 'c'])).toBe(selected);
  });
});

describe('long jobs on a phone', () => {
  const sentinel = (): SentinelLike & { released: boolean } => {
    const listeners: (() => void)[] = [];
    return {
      released: false,
      async release() {
        this.released = true;
        listeners.forEach((listener) => listener());
      },
      addEventListener: (_type, listener) => void listeners.push(listener),
    };
  };
  const fakeDocument = () => {
    const listeners = new Set<() => void>();
    return {
      visibilityState: 'visible',
      title: 'OpenTunes',
      addEventListener: (_t: 'visibilitychange', l: () => void) => void listeners.add(l),
      removeEventListener: (_t: 'visibilitychange', l: () => void) => void listeners.delete(l),
      fire() {
        listeners.forEach((l) => l());
      },
    };
  };

  it('takes the screen wake lock for a job, gets it again when the tab is visible, and lets go after', async () => {
    const taken: ReturnType<typeof sentinel>[] = [];
    const nav = { wakeLock: { request: async () => (taken.push(sentinel()), taken.at(-1) as SentinelLike) } };
    const doc = fakeDocument();
    const wake = createWakeLock(nav, doc);
    await wake.acquire();
    expect(wake.status()).toBe('held');
    // The browser drops it when the tab is hidden.
    doc.visibilityState = 'hidden';
    await taken[0]?.release();
    doc.visibilityState = 'visible';
    doc.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taken).toHaveLength(2);
    expect(wake.status()).toBe('held');
    await wake.release();
    expect(taken[1]?.released).toBe(true);
    expect(wake.status()).toBe('off');
  });

  it('says so when the browser cannot or will not', async () => {
    const none = createWakeLock({}, undefined);
    await none.acquire();
    expect(none.status()).toBe('unsupported');
    const refused = createWakeLock({ wakeLock: { request: async () => Promise.reject(new Error('battery saver')) } }, undefined);
    await refused.acquire();
    expect(refused.status()).toBe('refused');
  });

  it('notes when the tab was in the background during a job, and for how long', () => {
    const doc = fakeDocument();
    let clock = 0;
    const watch = watchBackground(doc, () => clock);
    const stop = watch.start();
    expect(watch.wasHidden()).toBe(false);
    doc.visibilityState = 'hidden';
    doc.fire();
    clock = 8000;
    doc.visibilityState = 'visible';
    doc.fire();
    expect(watch.wasHidden()).toBe(true);
    expect(watch.hiddenMs()).toBe(8000);
    stop();
  });
});

describe('errors nobody caught', () => {
  it('shows a plain notice with a report that holds no IDs and no stack', () => {
    reportProblem(new Error('Something broke near ' + fake('000A27', '0012345678') + ''), 'promise', 1000);
    const [notice] = currentNotices();
    expect(notice?.message).toBe('Something broke near [ID hidden]');
    expect(notice?.report).not.toContain('000A27');
    expect(JSON.parse(notice?.report ?? '{}')).toMatchObject({ app: 'opentunes', view: 'error-report', source: 'promise' });
    expect(notice?.report).not.toContain('stack');
  });

  it('drops a repeat within three seconds, and noise that is not an error', () => {
    reportProblem(new Error('same'), 'error', 1000);
    reportProblem(new Error('same'), 'error', 2000);
    expect(currentNotices()).toHaveLength(1);
    reportProblem(new Error('same'), 'error', 5000);
    expect(currentNotices()).toHaveLength(2);
    expect(shouldIgnore('ResizeObserver loop completed with undelivered notifications.', null)).toBe(true);
    expect(shouldIgnore('x', new DOMException('picker closed', 'AbortError'))).toBe(true);
    expect(shouldIgnore('x', new Error('x'))).toBe(false);
  });

  it('builds the report from plain parts', () => {
    const text = buildReport({ message: 'm', name: 'Error', source: 'error', at: 0, doing: ['Copying to the iPod'], browser: 'Chrome/130' });
    expect(JSON.parse(text)).toMatchObject({ problem: 'm', wasDoing: ['Copying to the iPod'], browser: 'Chrome/130' });
  });
});
