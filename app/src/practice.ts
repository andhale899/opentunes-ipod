import { newEngine } from './engineLoader';
import { beginRead, beginWrite } from './writeLock';
import { ScratchFolder, applyRemoval, buildSignedDemoIpod, loadIpodFolder, mediaPathOf, planRemoval, trackKey, withCoverFormats, type Engine, type IpodRoot } from '@opentunes/engine';

const ITUNES = 'iPod_Control/iTunes';

async function writeInto(folder: ScratchFolder, path: string, bytes: Uint8Array): Promise<void> {
  const parts = path.split('/');
  let directory = folder;
  for (const part of parts.slice(0, -1)) directory = (await directory.getDirectoryHandle(part, { create: true })) as ScratchFolder;
  const writer = await (await directory.getFileHandle(parts[parts.length - 1] as string, { create: true })).createWritable();
  await writer.write(bytes);
  await writer.close();
}

async function copyDirectory(engine: Engine, from: string, into: ScratchFolder, prefix: string): Promise<void> {
  for (const name of engine.fs.readdir(from)) {
    if (name === '.' || name === '..') continue;
    const path = `${from}/${name}`;
    if (engine.fs.isDir(engine.fs.stat(path).mode)) await copyDirectory(engine, path, into, `${prefix}${name}/`);
    else await writeInto(into, `${prefix}${name}`, engine.fs.readFile(path));
  }
}

/**
 * A nano 7G-style iPod held in memory that the page can write to, for trying the add, remove and
 * edit panels with no iPod at all. Each demo track gets a small stand-in file, so the music
 * folders hold what the library lists, as on a real iPod. Nothing here reaches a disk.
 */
export async function buildPracticeIpod(engine: Engine, mount: string): Promise<ScratchFolder> {
  buildSignedDemoIpod(engine, mount);
  // A real nano 7G has no iTunesDB, only iTunesCDB and the SQLite library.
  engine.fs.unlink(`${mount}/${ITUNES}/iTunesDB`);
  const ipod = new ScratchFolder('PRACTICE IPOD');
  await copyDirectory(engine, mount, ipod, '');
  // The practice iPod's description is stripped down. Give it the album art formats a real nano 7G
  // declares, so album art can be tried on it too.
  const description = `${mount}/iPod_Control/Device/SysInfoExtended`;
  if (engine.fs.analyzePath(description).exists) {
    await writeInto(ipod, 'iPod_Control/Device/SysInfoExtended', new TextEncoder().encode(withCoverFormats(new TextDecoder().decode(engine.fs.readFile(description)))));
  }
  // A real iPod has all fifty music folders, F00 to F49, empty or not. libgpod picks a number
  // below the count of folders and expects every one of them to exist, so a sparse set fails.
  for (let number = 0; number < 50; number += 1) {
    const music = await (await ipod.getDirectoryHandle('iPod_Control', { create: true })).getDirectoryHandle('Music', { create: true });
    await music.getDirectoryHandle(`F${String(number).padStart(2, '0')}`, { create: true });
  }
  for (const track of engine.tracks()) {
    const path = mediaPathOf(track.ipod_path);
    if (path) await writeInto(ipod, path, new TextEncoder().encode(`stand-in for ${track.title}`));
  }
  return ipod;
}

/**
 * For the smoke test only, and only for the practice iPod, which lives in memory and is never a real
 * device. Lets the test make a change "behind the page's back", the way iTunes or another computer
 * would, to check that Reload from the iPod notices it. Not linked from anywhere in the page.
 */
export function exposePracticeForTests(ipod: ScratchFolder): void {
  let releaseLock: (() => void) | null = null;
  let releaseRead: (() => void) | null = null;
  (window as unknown as { __opentunesPractice?: unknown }).__opentunesPractice = {
    root: ipod,
    /** Takes the write lock, as a running write would, so the test can look at what the page turns off. */
    holdWriteLock(): boolean {
      if (releaseLock) return false;
      releaseLock = beginWrite('Test write');
      return true;
    },
    /** Asks for the write lock a second time, the way a second write would, and says what happened. */
    tryAnotherWrite(): string {
      try {
        beginWrite('Another test write')();
        return 'ran';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    /** Takes a read lock, as a running backup or copy would, so the test can look at what the page turns off while a read job runs. */
    holdReadLock(label: string): boolean {
      if (releaseRead) return false;
      releaseRead = beginRead(label);
      return true;
    },
    releaseReadLock(): void {
      releaseRead?.();
      releaseRead = null;
    },
    releaseWriteLock(): void {
      releaseLock?.();
      releaseLock = null;
    },
    /** Removes the first track through the engine directly, without telling the page. */
    async removeFirstTrackBehindTheBack(): Promise<number> {
      const engine = await newEngine();
      const load = await loadIpodFolder(ipod, engine, { mount: '/ipod' });
      engine.open(load.mount);
      const first = engine.tracks()[0];
      if (!first) return 0;
      const key = trackKey(first);
      const plan = await planRemoval(ipod as unknown as IpodRoot, newEngine, [key]);
      const report = await applyRemoval(plan, ipod as unknown as IpodRoot, newEngine, {
        backup: { folder: 'test', files: 1, bytes: 1, verified: 1, failures: [], left: [], complete: true, stopped: false },
      });
      return report.verified ? 1 : 0;
    },
  };
}
