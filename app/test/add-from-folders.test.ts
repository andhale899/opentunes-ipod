import { describe, expect, it } from 'vitest';
import { devices } from '@opentunes/core';
import { trackFieldsFor } from '@opentunes/engine';
import { inspectFile, prepareItem, redecide } from '../src/addFiles';

const nano = devices.find((device) => device.id === 'nano-7g') as (typeof devices)[number];

/** A short silent 16-bit 44.1 kHz stereo WAV, which the iPod plays as it is and which has no tags. */
function wav(name: string): File {
  const data = new Uint8Array(400);
  const bytes = new Uint8Array(44 + data.length);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 176400, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, data.length, true);
  bytes.set(data, 44);
  return new File([bytes], name);
}

describe('choosing a folder named for a kind', () => {
  it('sets the kind from the folder, fills the missing tags, and they reach the library fields', async () => {
    const candidate = await inspectFile(wav('03 - Chapter Three.wav'), nano, undefined, 'Ursula Le Guin / A Wizard of Earthsea', ['Audiobooks', 'Ursula Le Guin', 'A Wizard of Earthsea']);
    expect(candidate.userKind).toBe('audiobook');
    expect(candidate.kindFromFolder).toBe(true);
    expect(candidate.decision.kind).toBe('audiobook');
    expect(candidate.info.tags).toMatchObject({ artist: 'Ursula Le Guin', album: 'A Wizard of Earthsea', trackNumber: 3, title: 'Chapter Three' });
    expect([...(candidate.filledFromFolders ?? [])].sort()).toEqual(['album', 'artist', 'title', 'trackNumber']);

    // What prepareItem hands the sync, and the track fields the sync turns it into.
    const item = await prepareItem(candidate);
    expect(item?.kind).toBe('audiobook');
    expect(item?.info.tags).toMatchObject({ artist: 'Ursula Le Guin', album: 'A Wizard of Earthsea', trackNumber: 3 });
    const fields = trackFieldsFor(item as NonNullable<typeof item>);
    expect(fields).toMatchObject({ artist: 'Ursula Le Guin', album: 'A Wizard of Earthsea', track_nr: 3, title: 'Chapter Three' });
  });

  it('reads a podcast show from its folder', async () => {
    const candidate = await inspectFile(wav('2026-01-05 Episode.wav'), nano, undefined, 'Show Name', ['Podcasts', 'Show Name']);
    expect(candidate.decision.kind).toBe('podcast');
    const item = await prepareItem(candidate);
    expect(trackFieldsFor(item as NonNullable<typeof item>)).toMatchObject({ album: 'Show Name', title: 'Episode', year: 2026 });
  });

  it('lets the person change the kind afterwards, and then it is no longer "from the folder name"', async () => {
    const candidate = await inspectFile(wav('01 Song.wav'), nano, undefined, 'A / B', ['Audiobooks', 'A', 'B']);
    expect(candidate.kindFromFolder).toBe(true);
    const music = redecide(candidate, nano, 'music');
    expect(music.userKind).toBe('music');
    expect(music.kindFromFolder).toBe(false);
    expect(music.decision.kind).toBe('music');
    expect(redecide(candidate, nano, candidate.userKind).kindFromFolder).toBe(true);
  });

  it('changes nothing for a folder with no known name, or when no folders are given', async () => {
    const plain = await inspectFile(wav('01 First.wav'), nano, undefined, 'Album', ['testmedia', 'Album']);
    expect(plain.userKind).toBeUndefined();
    expect(plain.kindFromFolder).toBe(false);
    expect(plain.filledFromFolders).toBeUndefined();
    expect(plain.info.tags).toEqual({});
    const loose = await inspectFile(wav('01 First.wav'), nano);
    expect(loose.userKind).toBeUndefined();
  });

  it('keeps a kind the person already chose over the folder name', async () => {
    const candidate = await inspectFile(wav('01 Song.wav'), nano, 'podcast', 'A', ['Audiobooks', 'A']);
    expect(candidate.userKind).toBe('podcast');
    expect(candidate.kindFromFolder).toBe(false);
  });
});
