/**
 * A made-up iPod for trying the app, and the tests, without any hardware.
 *
 * It holds one of each kind of media so every part of a library view has something to
 * show. The files do not exist: the sizes are invented, and nothing reads them.
 */

import type { Engine, Kind, TrackFields } from './engine.ts';

interface DemoTrack {
  kind: Kind;
  file: string;
  size: number;
  fields: TrackFields;
  chapters?: [number, string][];
}

const DEMO_TRACKS: DemoTrack[] = [
  {
    kind: 'music', file: 'morning-light.mp3', size: 8_400_000,
    fields: { title: 'Morning Light', artist: 'The Demo Band', album: 'Samples', genre: 'Rock', year: 2021, track_nr: 1, tracks: 2, tracklen: 214000, bitrate: 256, samplerate: 44100 },
  },
  {
    kind: 'music', file: 'night-drive.m4a', size: 7_100_000,
    fields: { title: 'Night Drive', artist: 'The Demo Band', album: 'Samples', genre: 'Rock', year: 2021, track_nr: 2, tracks: 2, tracklen: 187000, bitrate: 256, samplerate: 44100 },
  },
  {
    kind: 'podcast', file: 'episode-12.mp3', size: 31_000_000,
    fields: { title: 'Episode 12: Engines', artist: 'Demo Cast', album: 'Demo Cast', category: 'Technology', description: 'How a small engine fits in a browser tab.', podcasturl: 'https://example.com/12.mp3', tracklen: 1_980_000, bitrate: 128 },
  },
  {
    kind: 'audiobook', file: 'a-short-story.m4b', size: 52_000_000,
    fields: { title: 'A Short Story', artist: 'An Author', album: 'A Short Story', tracklen: 5_400_000, bitrate: 64 },
    chapters: [[0, 'Beginning'], [1_800_000, 'Middle'], [3_900_000, 'End']],
  },
  {
    kind: 'movie', file: 'demo-film.m4v', size: 410_000_000,
    fields: { title: 'Demo Film', year: 2019, tracklen: 5_400_000, description: 'A film that exists only in this demo.' },
  },
];

/** Adds the demo tracks and a playlist to the open iPod, then writes the database. */
function fillDemoIpod(engine: Engine): void {
  const handles: number[] = [];
  for (const demo of DEMO_TRACKS) {
    const handle = engine.addTrack(demo.kind, demo.fields);
    engine.commit(handle, engine.destPath(demo.file), demo.size);
    for (const [start, title] of demo.chapters ?? []) {
      engine.addChapter(handle, start, title);
    }
    handles.push(handle);
  }

  const playlist = engine.createPlaylist('Road trip');
  for (const handle of handles.slice(0, 2)) {
    engine.addToPlaylist(playlist, handle);
  }
  engine.write();
}

function makeFolder(engine: Engine, path: string): void {
  if (!engine.fs.analyzePath(path).exists) engine.fs.mkdir(path);
}

/** Sets up a blank iPod at `mount` and fills it. Leaves the database written and open. */
export function buildDemoIpod(engine: Engine, mount = '/ipod'): void {
  makeFolder(engine, mount);
  engine.init(mount, 'MA450', 'Demo iPod');
  fillDemoIpod(engine);
}

/** A made-up FireWire ID for the signed demo. It belongs to no real iPod. */
export const DEMO_FIREWIRE_ID = '0000000000000001';

/**
 * The least a SysInfoExtended needs for libgpod to treat the iPod like a nano 7G: DBVersion 5
 * (hashAB signing), SQLiteDB (iTunesCDB and the iTunes Library.itlp folder) and an ID.
 */
const DEMO_SYSINFO_EXTENDED = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>DBVersion</key>
  <integer>5</integer>
  <key>SQLiteDB</key>
  <true/>
  <key>FireWireGUID</key>
  <string>${DEMO_FIREWIRE_ID}</string>
</dict>
</plist>
`;

/**
 * Like the demo iPod, but laid out the way a nano 7G is: iTunesCDB, the iTunes Library.itlp
 * folder, and signatures from hashAB. It also holds the two big files a real nano 7G has
 * that libgpod never opens, as small stand-ins. Leaves the database written and open.
 */
export function buildSignedDemoIpod(engine: Engine, mount = '/ipod'): void {
  makeFolder(engine, mount);
  engine.init(mount, 'MA450', 'Demo nano 7G');
  engine.fs.writeFile(`${mount}/iPod_Control/Device/SysInfoExtended`, DEMO_SYSINFO_EXTENDED);
  engine.open(mount); // reopen so libgpod reads the device file
  fillDemoIpod(engine);

  makeFolder(engine, `${mount}/iPod_Control/Device/Radio`);
  engine.fs.writeFile(`${mount}/iPod_Control/iTunes/iTunesControl`, new Uint8Array(16));
  engine.fs.writeFile(`${mount}/iPod_Control/Device/Radio/RadioBuffer`, new Uint8Array(16));
}

/**
 * An iPod that has never been synced: the folders are there, and the database is an empty
 * file. Reading it fails, and the point is to see how that failure is explained.
 */
export function buildUnsyncedIpod(engine: Engine, mount = '/ipod'): void {
  for (const path of [mount, `${mount}/iPod_Control`, `${mount}/iPod_Control/iTunes`, `${mount}/iPod_Control/Device`, `${mount}/iPod_Control/Music`]) {
    makeFolder(engine, path);
  }
  for (let i = 0; i < 50; i += 1) makeFolder(engine, `${mount}/iPod_Control/Music/F${String(i).padStart(2, '0')}`);
  engine.fs.writeFile(`${mount}/iPod_Control/iTunes/iTunesDB`, new Uint8Array(0));
  engine.fs.writeFile(`${mount}/iPod_Control/Device/SysInfo`, 'ModelNumStr: MA450\n');
}
