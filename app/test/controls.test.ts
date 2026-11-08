import { PauseGate } from '@opentunes/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentActivity, requestStop, resetActivity, startActivity, togglePause } from '../src/activity';
import { watchOtherTabs } from '../src/otherTab';
import { isStopped } from '../src/stopped';
import { judgeWrite, track } from '../src/tracked';
import { explainWrongFolder } from '../src/wrongFolder';

beforeEach(() => resetActivity());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Stop in the activity bar', () => {
  it('runs the stop action once, and marks it requested', () => {
    let stopped = 0;
    const handle = startActivity('Job', { stop: { label: 'Stop', run: () => (stopped += 1) } });
    expect(requestStop(handle.id)).toBe(true);
    expect(requestStop(handle.id)).toBe(false);
    expect(stopped).toBe(1);
    expect(currentActivity().active[0]?.stop?.requested).toBe(true);
  });

  it('refuses a stop while the job says this part cannot be stopped safely', () => {
    let stopped = 0;
    const handle = startActivity('Job', { stop: { label: 'Stop', run: () => (stopped += 1) } });
    handle.setBlocked('This part cannot be stopped safely.');
    expect(requestStop(handle.id)).toBe(false);
    expect(stopped).toBe(0);
    handle.setBlocked(null);
    expect(requestStop(handle.id)).toBe(true);
  });

  it('keeps a paused write job in the bar with its warning flag, and resumes it', () => {
    const gate = new PauseGate();
    const handle = startActivity('Copying to the iPod', { writes: true, pause: gate });
    gate.join();
    togglePause(handle.id);
    expect(currentActivity().active[0]?.pause).toBe('pausing');
    void gate.checkpoint();
    expect(currentActivity().active[0]).toMatchObject({ writes: true, pause: 'paused' });
    togglePause(handle.id);
    expect(currentActivity().active[0]?.pause).toBe('running');
  });

  it('leaves a stopped banner that is not a failure', () => {
    startActivity('Backing up the iPod').end(true, 'Kept.', true);
    expect(currentActivity().finished).toMatchObject({ ok: true, stopped: true });
  });
});

describe('reading what an engine function returned', () => {
  it('treats a rolled-back sync as not done, and a clean stop as stopped', () => {
    expect(judgeWrite({ verified: false, rolledBack: true, failures: ['disk full'] })).toMatchObject({ ok: false, stopped: false, detail: 'disk full' });
    expect(judgeWrite({ verified: false, aborted: true, rolledBack: true, failures: ['stopped'], rollbackFailures: [] })).toMatchObject({ ok: true, stopped: true });
    expect(judgeWrite({ verified: false, aborted: true, rolledBack: true, rollbackFailures: ['x could not be put back'] }).ok).toBe(false);
    expect(judgeWrite({ report: { verified: true, rolledBack: false, failures: [] } })).toMatchObject({ ok: true, stopped: false });
    expect(judgeWrite({ complete: false, stopped: true, failures: ['The backup was stopped'] })).toMatchObject({ ok: true, stopped: true });
    expect(judgeWrite({ complete: false, failures: [] }).ok).toBe(false);
    expect(judgeWrite({ removed: [], kept: [] }).ok).toBe(true);
  });

  it('recognises the browser abort error as a stop', () => {
    expect(isStopped(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isStopped(new Error('x'))).toBe(false);
  });
});

describe('a tracked job that can be stopped', () => {
  const spec = { stop: { label: 'Stop', at: 1, blocked: (progress: unknown) => ((progress as { phase?: string }).phase === 'database' ? 'No.' : null) } };

  it('gives the engine a signal, and a stop from the bar aborts it', async () => {
    let seen: AbortSignal | undefined;
    const wrapped = track('Job', true, async (_a: string, options: { signal?: AbortSignal }) => {
      seen = options.signal;
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve()));
      return { verified: false, aborted: true, rolledBack: true, rollbackFailures: [] };
    }, spec);
    const run = wrapped('a', {});
    await tick();
    expect(requestStop(currentActivity().active[0]?.id ?? -1)).toBe(true);
    await run;
    expect(seen?.aborted).toBe(true);
    expect(currentActivity().finished).toMatchObject({ ok: true, stopped: true, writes: true });
  });

  it('ignores a caller stop during the part that cannot be stopped, and shows why', async () => {
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    const wrapped = track('Job', true, async (_a: string, options: { signal?: AbortSignal; onProgress: (progress: unknown) => void }) => {
      seen = options.signal;
      options.onProgress({ phase: 'database', message: 'Writing' });
      caller.abort();
      await tick();
      return { verified: true, failures: [] };
    }, spec);
    await wrapped('a', { signal: caller.signal, onProgress: () => undefined });
    expect(seen?.aborted).toBe(false);
  });

  it('turns a stop thrown before anything was written into a stopped banner, not a failure', async () => {
    const wrapped = track('Checking the iPod', false, async (_options: object) => {
      throw new DOMException('Stopped', 'AbortError');
    }, { stop: { label: 'Stop', at: 0 } });
    await expect(wrapped({})).rejects.toThrow();
    expect(currentActivity().finished).toMatchObject({ ok: true, stopped: true });
  });

  it('joins a second call with the same plan instead of starting another write', async () => {
    let runs = 0;
    const wrapped = track('Copying', true, async (_plan: object) => {
      runs += 1;
      await tick();
      return { verified: true };
    }, { joinSame: true });
    const plan = {};
    await Promise.all([wrapped(plan), wrapped(plan)]);
    expect(runs).toBe(1);
    await wrapped(plan);
    expect(runs).toBe(2);
  });
});

describe('a second tab', () => {
  it('hears another tab that has an iPod open, and forgets it when it closes', async () => {
    const heard: boolean[] = [];
    const a = watchOtherTabs((open) => heard.push(open));
    const b = watchOtherTabs(() => undefined);
    b.announce(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard.at(-1)).toBe(true);
    b.announce(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard.at(-1)).toBe(false);
    a.close();
    b.close();
  });
});

type Node = { kind: 'file' | 'directory'; name: string; children?: Record<string, Node> };
const dir = (name: string, children: Record<string, Node> = {}): Node => ({ kind: 'directory', name, children });
const file = (name: string): Node => ({ kind: 'file', name });
const handle = (node: Node): never =>
  ({
    kind: node.kind,
    name: node.name,
    async *entries() {
      for (const [name, child] of Object.entries(node.children ?? {})) yield [name, { kind: child.kind }];
    },
    async getDirectoryHandle(name: string) {
      const child = node.children?.[name];
      if (!child) throw new Error('missing');
      return handle(child);
    },
  }) as never;

describe('choosing a folder that is not an iPod', () => {
  it('says a backup folder is a backup', async () => {
    const message = await explainWrongFolder(handle(dir('opentunes-backup-1', { 'backup-info.json': file('backup-info.json'), iPod_Control: dir('iPod_Control') })));
    expect(message).toMatch(/backup made by OpenTunes, not an iPod/);
  });

  it('says an offload folder is a copy of music', async () => {
    const message = await explainWrongFolder(handle(dir('opentunes-offload-1', { 'library.csv': file('library.csv'), 'playlists.csv': file('playlists.csv'), F00: dir('F00') })));
    expect(message).toMatch(/copy of the music taken off an iPod/);
  });

  it('points at the folder above iPod_Control, and at one level down', async () => {
    expect(await explainWrongFolder(handle(dir('iPod_Control', { iTunes: dir('iTunes'), Music: dir('Music') })))).toMatch(/Choose the folder above it/);
    expect(await explainWrongFolder(handle(dir('Volumes', { MYPOD: dir('MYPOD', { iPod_Control: dir('iPod_Control') }), Other: dir('Other') })))).toMatch(/Choose "MYPOD" instead/);
  });

  it('lets a real iPod through', async () => {
    expect(await explainWrongFolder(handle(dir('IPOD', { iPod_Control: dir('iPod_Control') })))).toBeNull();
  });
});
