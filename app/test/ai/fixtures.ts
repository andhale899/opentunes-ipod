import type { DigestSource } from '../../src/ai/digest';

/** A small library with made-up tracks. The paths look like an iPod's, but belong to no real one. */
export function track(overrides: Partial<DigestSource> = {}): DigestSource {
  return {
    ipod_path: ':iPod_Control:Music:F00:ABCD.m4a',
    title: 'Morning Light',
    artist: 'The Examples',
    album: 'Demo Album',
    albumartist: null,
    genre: 'Rock',
    year: 2011,
    track_nr: 3,
    tracklen: 200000,
    kind: 'music',
    size: 4_000_000,
    ...overrides,
  };
}

export function library(): DigestSource[] {
  return [
    track({ ipod_path: ':iPod_Control:Music:F00:AAAA.m4a', title: 'Morning Light', artist: 'Beatls', album: 'Demo Album' }),
    track({ ipod_path: ':iPod_Control:Music:F01:BBBB.m4a', title: 'Evening Song', artist: 'The Beatles', album: 'Demo Album', track_nr: 4 }),
    track({ ipod_path: ':iPod_Control:Music:F02:CCCC.m4b', title: 'Chapter 1', artist: 'A. Writer', album: 'A Short Story', genre: 'Speech', year: 0, track_nr: 1, kind: 'music' }),
    track({ ipod_path: ':iPod_Control:Music:F03:DDDD.m4v', title: 'Demo Film', artist: '', album: '', genre: '', year: 0, track_nr: 0, kind: 'movie' }),
  ];
}
