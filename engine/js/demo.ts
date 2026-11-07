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

/** Sets up a blank iPod at `mount` and fills it. Leaves the database written and open. */
export function buildDemoIpod(engine: Engine, mount = '/ipod'): void {
  if (!engine.fs.analyzePath(mount).exists) {
    engine.fs.mkdir(mount);
  }
  engine.init(mount, 'MA450', 'Demo iPod');

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
