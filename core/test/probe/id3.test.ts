import { describe, expect, it } from 'vitest';
import {
  addUnsynchronisation,
  CBR_48K_128,
  chapterFrame,
  commentFrame,
  id3Frame,
  id3FramePlainSize,
  id3v2,
  mp3File,
  mpegFrames,
  pictureFrame,
  textFrame,
  tocFrame,
  type Id3Version,
  type TextEncoding,
  encodeText,
} from './build-mp3';
import { be16, be32, cat, fakeJpeg, fakePng, probeBytes, utf8 } from './helpers';

const audio = () => mpegFrames(CBR_48K_128, 100);

async function probeTag(version: Id3Version, frames: Uint8Array[], extra: { tagUnsync?: boolean; extendedHeader?: boolean; footer?: boolean; padding?: number } = {}) {
  return probeBytes('t.mp3', mp3File({ id3: id3v2({ version, frames, ...extra }), frames: [audio()] }));
}

describe('ID3v2.3 frames', () => {
  it('maps every tag field', async () => {
    const info = await probeTag(3, [
      textFrame(3, 'TIT2', 'The Title'),
      textFrame(3, 'TPE1', 'The Artist'),
      textFrame(3, 'TALB', 'The Album'),
      textFrame(3, 'TPE2', 'The Album Artist'),
      textFrame(3, 'TCON', 'Jazz'),
      textFrame(3, 'TCOM', 'The Composer'),
      textFrame(3, 'TYER', '1987'),
      textFrame(3, 'TRCK', '3/12'),
      textFrame(3, 'TPOS', '1/2'),
      textFrame(3, 'TBPM', '128'),
      commentFrame(3, 'COMM', 'A comment'),
      textFrame(3, 'TIT1', 'The Grouping'),
      textFrame(3, 'TCMP', '1'),
      commentFrame(3, 'USLT', 'La la la\nLa la'),
    ]);
    expect(info.tags).toEqual({
      title: 'The Title',
      artist: 'The Artist',
      album: 'The Album',
      albumArtist: 'The Album Artist',
      genre: 'Jazz',
      composer: 'The Composer',
      year: 1987,
      trackNumber: 3,
      trackTotal: 12,
      discNumber: 1,
      discTotal: 2,
      bpm: 128,
      comment: 'A comment',
      grouping: 'The Grouping',
      compilation: true,
      lyrics: 'La la la\nLa la',
    });
    expect(info.warnings).toEqual([]);
    expect(info.durationMs).toBe(2400);
  });

  it('keeps a track number with no total, and ignores junk numbers', async () => {
    const info = await probeTag(3, [textFrame(3, 'TRCK', '7'), textFrame(3, 'TPOS', 'two'), textFrame(3, 'TBPM', 'fast'), textFrame(3, 'TYER', '0000')]);
    expect(info.tags.trackNumber).toBe(7);
    expect(info.tags.trackTotal).toBeUndefined();
    expect(info.tags.discNumber).toBeUndefined();
    expect(info.tags.bpm).toBeUndefined();
    expect(info.tags.year).toBeUndefined();
  });

  it('prefers GRP1 over TIT1 for the grouping', async () => {
    const info = await probeTag(3, [textFrame(3, 'TIT1', 'Content group'), textFrame(3, 'GRP1', 'iTunes grouping')]);
    expect(info.tags.grouping).toBe('iTunes grouping');
  });

  it('reads the album artist from a TXXX frame when TPE2 is missing', async () => {
    const body = cat([3], encodeText('ALBUMARTIST', 3, true), encodeText('Various', 3));
    const info = await probeTag(3, [id3Frame(3, 'TXXX', body)]);
    expect(info.tags.albumArtist).toBe('Various');
  });
});

describe('ID3v2.4 frames', () => {
  it('reads the date from TDRC and joins several values', async () => {
    const info = await probeTag(4, [
      textFrame(4, 'TIT2', 'Song'),
      textFrame(4, 'TDRC', '2019-03-04T10:00:00'),
      id3Frame(4, 'TPE1', cat([3], 'Alice', [0], 'Bob')),
    ]);
    expect(info.tags.year).toBe(2019);
    expect(info.tags.artist).toBe('Alice / Bob');
  });

  it('falls back to older year frames when TDRC is missing', async () => {
    expect((await probeTag(4, [textFrame(4, 'TDRL', '2001-01-01')])).tags.year).toBe(2001);
    expect((await probeTag(4, [textFrame(4, 'TDOR', '1975')])).tags.year).toBe(1975);
    expect((await probeTag(3, [textFrame(3, 'TORY', '1966')])).tags.year).toBe(1966);
  });

  it('reads frame sizes written as plain numbers, which some older writers did', async () => {
    // A 300 byte comment has a plain size of 300 and a synchsafe reading of 300 is different. The next frame shows which is right.
    const longComment = 'x'.repeat(300);
    const info = await probeTag(4, [id3FramePlainSize('COMM', cat([3], 'eng', [0], utf8(longComment))), textFrame(4, 'TIT2', 'After the long frame')]);
    expect(info.tags.comment).toBe(longComment);
    expect(info.tags.title).toBe('After the long frame');
  });

  it('reads per-frame unsynchronisation and the data length indicator', async () => {
    const text = 'ÿàÿà';
    const plain = cat([0], text); // ISO-8859-1: the bytes FF E0 FF E0
    const unsynced = addUnsynchronisation(plain);
    expect(unsynced.length).toBeGreaterThan(plain.length); // the fixture really added bytes
    const flagged = id3Frame(4, 'TIT2', unsynced, 0x0002);
    const withLength = id3Frame(4, 'TALB', cat([0, 0, 0, 5], cat([3], 'Disc')), 0x0001);
    const info = await probeTag(4, [flagged, withLength]);
    expect(info.tags.title).toBe(text);
    expect(info.tags.album).toBe('Disc');
  });

  it('skips the footer of a 2.4 tag and finds the audio right after it', async () => {
    const info = await probeTag(4, [textFrame(4, 'TIT2', 'Footer')], { footer: true });
    expect(info.tags.title).toBe('Footer');
    expect(info.warnings).toEqual([]);
    expect(info.durationMs).toBe(2400);
  });

  it('handles an extended header', async () => {
    const info = await probeTag(4, [textFrame(4, 'TIT2', 'Extended')], { extendedHeader: true });
    expect(info.tags.title).toBe('Extended');
  });
});

describe('ID3v2.3 specifics', () => {
  it('handles an extended header', async () => {
    const info = await probeTag(3, [textFrame(3, 'TIT2', 'Extended')], { extendedHeader: true });
    expect(info.tags.title).toBe('Extended');
  });

  it('undoes whole-tag unsynchronisation, including in cover art', async () => {
    const art = fakeJpeg(200);
    const info = await probeTag(3, [textFrame(3, 'TIT2', 'ÿàÿà', 0), pictureFrame(3, art)], { tagUnsync: true });
    expect(info.tags.title).toBe('ÿàÿà');
    expect(info.artwork?.mime).toBe('image/jpeg');
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(art));
  });

  it('skips compressed frames and carries on', async () => {
    const compressed = id3Frame(3, 'TIT2', cat([0, 0, 0, 20], [1, 2, 3, 4]), 0x0080);
    const info = await probeTag(3, [compressed, textFrame(3, 'TPE1', 'Still read')]);
    expect(info.tags.title).toBeUndefined();
    expect(info.tags.artist).toBe('Still read');
    expect(info.warnings.join(' ')).toContain('skipped');
  });
});

describe('ID3v2.2 frames', () => {
  it('maps the three-letter frames', async () => {
    const art = fakePng(100);
    const info = await probeTag(2, [
      textFrame(2, 'TT2', 'Old Title'),
      textFrame(2, 'TP1', 'Old Artist'),
      textFrame(2, 'TAL', 'Old Album'),
      textFrame(2, 'TP2', 'Old Album Artist'),
      textFrame(2, 'TCO', '(13)'),
      textFrame(2, 'TCM', 'Old Composer'),
      textFrame(2, 'TYE', '1999'),
      textFrame(2, 'TRK', '2/9'),
      textFrame(2, 'TPA', '2/3'),
      textFrame(2, 'TBP', '90'),
      commentFrame(2, 'COM', 'Old comment'),
      textFrame(2, 'TT1', 'Old grouping'),
      textFrame(2, 'TCP', '1'),
      commentFrame(2, 'ULT', 'Old lyrics'),
      pictureFrame(2, art, { mime: 'image/png' }),
    ]);
    expect(info.tags).toEqual({
      title: 'Old Title',
      artist: 'Old Artist',
      album: 'Old Album',
      albumArtist: 'Old Album Artist',
      genre: 'Pop',
      composer: 'Old Composer',
      year: 1999,
      trackNumber: 2,
      trackTotal: 9,
      discNumber: 2,
      discTotal: 3,
      bpm: 90,
      comment: 'Old comment',
      grouping: 'Old grouping',
      compilation: true,
      lyrics: 'Old lyrics',
    });
    expect(info.artwork?.mime).toBe('image/png');
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(art));
  });

  it('undoes unsynchronisation of a whole 2.2 tag', async () => {
    const info = await probeTag(2, [textFrame(2, 'TT2', 'ÿàÿà', 0)], { tagUnsync: true });
    expect(info.tags.title).toBe('ÿàÿà');
  });
});

describe('text encodings', () => {
  const text = 'Beyoncé € Ünïcödé 日本語';
  const cases: [string, TextEncoding, string][] = [
    ['UTF-8', 3, text],
    ['UTF-16 with a byte order mark', 1, text],
    ['UTF-16BE', 2, text],
    ['ISO-8859-1', 0, 'Beyoncé Ünïcödé'],
  ];
  for (const version of [3, 4] as const) {
    for (const [name, encoding, value] of cases) {
      it(`reads ${name} in a 2.${version} tag`, async () => {
        const info = await probeTag(version, [textFrame(version, 'TIT2', value, encoding), commentFrame(version, 'COMM', value, 'd', encoding)]);
        expect(info.tags.title).toBe(value);
        expect(info.tags.comment).toBe(value);
      });
    }
  }

  it('reads big-endian UTF-16 that starts with its own byte order mark', async () => {
    const bytes = cat([1, 0xfe, 0xff], Uint8Array.from('Café'.split('').flatMap((c) => be16(c.charCodeAt(0)))));
    const info = await probeTag(3, [id3Frame(3, 'TIT2', bytes)]);
    expect(info.tags.title).toBe('Café');
  });

  it('drops trailing NUL characters and surrounding spaces', async () => {
    const info = await probeTag(3, [id3Frame(3, 'TIT2', cat([0], '  Padded  ', [0, 0]))]);
    expect(info.tags.title).toBe('Padded');
  });
});

describe('genres', () => {
  const genreOf = async (text: string) => (await probeTag(3, [textFrame(3, 'TCON', text)])).tags.genre;
  it('turns numeric forms into names', async () => {
    expect(await genreOf('(17)')).toBe('Rock');
    expect(await genreOf('17')).toBe('Rock');
    expect(await genreOf('(0)')).toBe('Blues');
    expect(await genreOf('(7)')).toBe('Hip-Hop');
    expect(await genreOf('(17)(18)')).toBe('Rock / Techno');
  });

  it('prefers the name after the numbers', async () => {
    expect(await genreOf('(17)Hard Rock')).toBe('Hard Rock');
  });

  it('knows the special codes and the escape', async () => {
    expect(await genreOf('(RX)')).toBe('Remix');
    expect(await genreOf('(CR)')).toBe('Cover');
    expect(await genreOf('((Quiet) Riot')).toBe('(Quiet) Riot');
  });

  it('passes ordinary names through', async () => {
    expect(await genreOf('Drum & Bass')).toBe('Drum & Bass');
  });

  it('keeps an unknown number as it is', async () => {
    expect(await genreOf('(250)')).toBe('250');
  });
});

describe('what the file declares about itself', () => {
  it('reads the iTunes podcast flag frame as a podcast', async () => {
    const info = await probeTag(3, [textFrame(3, 'TIT2', 'Episode 5'), id3Frame(3, 'PCST', Uint8Array.from([0, 0, 0, 0]))]);
    expect(info.tags.declaredKind).toBe('podcast');
  });

  it('does not call a file a podcast when there is no flag frame', async () => {
    const info = await probeTag(3, [textFrame(3, 'TIT2', 'Song'), textFrame(3, 'TCAT', 'Not enough on its own? It is a podcast field, but not the flag.')]);
    expect(info.tags.declaredKind).toBeUndefined();
  });

  it('uses an Audiobook or Podcast genre, by name or by the ID3 number, and nothing else', async () => {
    expect((await probeTag(3, [textFrame(3, 'TCON', 'Audiobook')])).tags.declaredKind).toBe('audiobook');
    expect((await probeTag(3, [textFrame(3, 'TCON', '(183)')])).tags.declaredKind).toBe('audiobook');
    expect((await probeTag(3, [textFrame(3, 'TCON', 'Podcast')])).tags.declaredKind).toBe('podcast');
    expect((await probeTag(3, [textFrame(3, 'TCON', '(186)')])).tags.declaredKind).toBe('podcast');
    expect((await probeTag(3, [textFrame(3, 'TCON', 'Rock')])).tags.declaredKind).toBeUndefined();
    expect((await probeTag(3, [textFrame(3, 'TCON', 'Podcast Hits')])).tags.declaredKind).toBeUndefined();
    expect((await probeTag(3, [textFrame(3, 'TIT2', 'An Audiobook About Rock')])).tags.declaredKind).toBeUndefined();
  });

  it('reads the podcast category, feed and episode id', async () => {
    const info = await probeTag(3, [
      textFrame(3, 'TCAT', 'Technology'),
      id3Frame(3, 'WFED', cat('https://example.test/feed.xml', [0])),
      textFrame(3, 'TGID', 'https://example.test/ep/5'),
      textFrame(3, 'TDES', 'About this episode'),
    ]);
    expect(info.tags.podcastCategory).toBe('Technology');
    expect(info.tags.podcastFeedUrl).toBe('https://example.test/feed.xml');
    expect(info.tags.podcastEpisodeUrl).toBe('https://example.test/ep/5');
    expect(info.tags.description).toBe('About this episode');
  });
});

describe('comments', () => {
  it('ignores the iTunes bookkeeping comments and keeps the real one', async () => {
    const info = await probeTag(3, [
      commentFrame(3, 'COMM', ' 00000000 00000000', 'iTunNORM'),
      commentFrame(3, 'COMM', '00000000 00000840', 'iTunSMPB'),
      commentFrame(3, 'COMM', 'Real comment'),
    ]);
    expect(info.tags.comment).toBe('Real comment');
  });

  it('prefers the comment with no description', async () => {
    const info = await probeTag(3, [commentFrame(3, 'COMM', 'Other', 'something'), commentFrame(3, 'COMM', 'Plain')]);
    expect(info.tags.comment).toBe('Plain');
  });
});

describe('cover art', () => {
  it('picks the front cover when there are several pictures', async () => {
    const back = fakeJpeg(80, 5);
    const front = fakePng(120, 9);
    const info = await probeTag(3, [pictureFrame(3, back, { type: 4 }), pictureFrame(3, front, { type: 3, mime: 'image/png' })]);
    expect(info.artwork?.mime).toBe('image/png');
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(front));
  });

  it('trusts the picture bytes over a wrong declared type', async () => {
    const info = await probeTag(4, [pictureFrame(4, fakeJpeg(90), { mime: 'image/png' })]);
    expect(info.artwork?.mime).toBe('image/jpeg');
  });

  it('reads a picture whose description is UTF-16', async () => {
    const art = fakeJpeg(150);
    const info = await probeTag(4, [pictureFrame(4, art, { description: 'Front é', encoding: 1 })]);
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(art));
  });

  it('gives a copy of the bytes, not a view into the file', async () => {
    const art = fakeJpeg(64);
    const file = mp3File({ id3: id3v2({ version: 3, frames: [pictureFrame(3, art)] }), frames: [audio()] });
    const info = await probeBytes('a.mp3', file);
    file.fill(0);
    expect(info.artwork?.data[0]).toBe(0xff);
  });

  it('skips something that is not a picture', async () => {
    const info = await probeTag(3, [pictureFrame(3, utf8('this is not an image at all'))]);
    expect(info.artwork).toBeNull();
    expect(info.warnings.join(' ')).toContain('not recognised');
  });
});

describe('ID3 chapters', () => {
  it('reads CHAP frames with titles in time order', async () => {
    const info = await probeTag(3, [
      chapterFrame(3, 'ch2', 60000, 120000, 'Second'),
      chapterFrame(3, 'ch1', 0, 60000, 'First'),
      chapterFrame(3, 'ch3', 120000, 180000, 'Third'),
    ]);
    expect(info.chapters).toEqual([
      { startMs: 0, title: 'First' },
      { startMs: 60000, title: 'Second' },
      { startMs: 120000, title: 'Third' },
    ]);
  });

  it('follows the table of contents and leaves out chapters it does not list', async () => {
    const info = await probeTag(4, [
      chapterFrame(4, 'a', 0, 1000, 'Part A'),
      chapterFrame(4, 'b', 1000, 2000, 'Part B'),
      chapterFrame(4, 'sub', 500, 900, 'Nested detail'),
      tocFrame(4, 'toc', ['a', 'b']),
    ]);
    expect(info.chapters.map((c) => c.title)).toEqual(['Part A', 'Part B']);
  });

  it('names an untitled chapter by its position', async () => {
    const info = await probeTag(4, [chapterFrame(4, 'a', 0, 1000), chapterFrame(4, 'b', 1000, 2000, 'Named')]);
    expect(info.chapters).toEqual([
      { startMs: 0, title: 'Chapter 1' },
      { startMs: 1000, title: 'Named' },
    ]);
  });
});

describe('damaged ID3 tags', () => {
  it('reads what it can from a tag that is cut short', async () => {
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'Complete'), textFrame(3, 'TPE1', 'Truncated artist name')] });
    const cut = tag.subarray(0, tag.length - 8);
    const info = await probeBytes('cut.mp3', cut);
    expect(info.tags.title).toBe('Complete');
    expect(info.warnings.length).toBeGreaterThan(0);
  });

  it('stops at a damaged frame header and keeps the frames before it', async () => {
    const good = textFrame(3, 'TIT2', 'Before');
    const bad = cat([0x01, 0x02, 0x03, 0x04], be32(5), be16(0), [1, 2, 3, 4, 5]);
    const info = await probeBytes('bad.mp3', mp3File({ id3: id3v2({ version: 3, frames: [good, bad, textFrame(3, 'TPE1', 'Lost')] }), frames: [audio()] }));
    expect(info.tags.title).toBe('Before');
    expect(info.tags.artist).toBeUndefined();
    expect(info.warnings.join(' ')).toContain('damaged');
  });

  it('survives a tag whose size field is wrong', async () => {
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'Short')] });
    const lying = tag.slice();
    lying.set([0x7f, 0x7f, 0x7f, 0x7f], 6); // claims a 256 MB tag
    const info = await probeBytes('lying.mp3', cat(lying, audio()));
    expect(info.tags.title).toBe('Short');
  });

  it('survives several tags in a row and keeps the first one winning', async () => {
    const first = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'First')] });
    const second = id3v2({ version: 4, frames: [textFrame(4, 'TIT2', 'Second'), textFrame(4, 'TPE1', 'Only in second')] });
    const info = await probeBytes('two.mp3', cat(first, second, audio()));
    expect(info.tags.title).toBe('First');
    expect(info.tags.artist).toBe('Only in second');
    expect(info.durationMs).toBe(2400);
  });
});
