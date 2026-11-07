import { ScratchFolder, buildSignedDemoIpod, mediaPathOf, type Engine } from '@opentunes/engine';

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
