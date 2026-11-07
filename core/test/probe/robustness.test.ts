import { describe, expect, it } from 'vitest';
import { probeMedia } from '../../src/media/probe/index';
import { Reader } from '../../src/media/probe/reader';
import { fileSourceFromBlob } from '../../src/media/source';
import type { FileSource, MediaContainer, MediaInfo } from '../../src/media/types';
import { adtsFrame, CBR_48K_128, chapterFrame, commentFrame, id3v1, id3v2, mp3File, mpegFrame, mpegFrames, pictureFrame, textFrame, tocFrame, vbrHeaderFrame } from './build-mp3';
import {
  aacTrack,
  ascLc,
  audioEntry,
  audioTrackWith,
  avcC,
  box,
  chapterTrack,
  chpl,
  esds,
  fullBox,
  ftyp,
  ilstMeta,
  mvhd,
  movieFile,
  sinf,
  textItem,
  trak,
  videoTrackWith,
  visualEntry,
  covrItem,
  COPY,
  intItem,
} from './build-mp4';
import {
  aiffChunk,
  aiffComm,
  aiffFile,
  asfAudioStream,
  asfContentDescription,
  asfFile,
  asfFileProperties,
  asfVideoStream,
  aviAudioFormat,
  aviFile,
  aviMainHeader,
  aviStreamHeader,
  aviVideoFormat,
  flacFile,
  listInfo,
  mkvAudioTrack,
  mkvFile,
  mkvVideoTrack,
  oggFile,
  opusHeadPacket,
  opusTagsPacket,
  pictureBody,
  simpleWav,
  ssnd,
  vorbisCommentPacket,
  vorbisIdPacket,
  vorbisSetupPacket,
  oggPage,
  el,
  elFloat,
  elStr,
  ebmlId,
  MKV,
} from './build-misc';
import { be32, be64, cat, fakeJpeg, probeBytes, randomBytes, recordingSource, utf8, zeros } from './helpers';

// ---- what a well formed result looks like ----

const CONTAINERS: MediaContainer[] = ['mp3', 'aac', 'm4a', 'm4b', 'm4v', 'mp4', 'mov', 'flac', 'wav', 'aiff', 'ogg', 'opus', 'wma', 'mkv', 'webm', 'avi', 'unknown'];
const AUDIO_CODECS = ['mp3', 'aac', 'he-aac', 'alac', 'pcm', 'flac', 'vorbis', 'opus', 'wma', 'ac3', 'eac3', 'dts', 'unknown'];
const VIDEO_CODECS = ['h264', 'mpeg4', 'hevc', 'mpeg2', 'vp8', 'vp9', 'av1', 'unknown'];
const KINDS = ['music', 'movie', 'music-video', 'tv-show', 'podcast', 'video-podcast', 'audiobook'];
const STRING_TAGS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'composer', 'comment', 'grouping', 'description', 'lyrics', 'show', 'episodeId', 'network', 'podcastCategory', 'podcastFeedUrl', 'podcastEpisodeUrl'];
const NUMBER_TAGS = ['year', 'trackNumber', 'trackTotal', 'discNumber', 'discTotal', 'bpm', 'season', 'episode'];

const finiteNonNegative = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`malformed result: ${message}`);
}

function expectWellFormed(info: MediaInfo, size: number): void {
  expect(typeof info.fileName).toBe('string');
  expect(info.sizeBytes).toBe(size);
  expect(CONTAINERS).toContain(info.container);
  check(info.durationMs === null || finiteNonNegative(info.durationMs), `durationMs ${info.durationMs}`);
  if (info.audio) {
    check(AUDIO_CODECS.includes(info.audio.codec), `audio codec ${info.audio.codec}`);
    check(finiteNonNegative(info.audio.sampleRateHz), `sample rate ${info.audio.sampleRateHz}`);
    check(finiteNonNegative(info.audio.channels), `channels ${info.audio.channels}`);
    check(info.audio.bitrateKbps === null || finiteNonNegative(info.audio.bitrateKbps), `audio bitrate ${info.audio.bitrateKbps}`);
    if (info.audio.bitDepth !== undefined) check(finiteNonNegative(info.audio.bitDepth), `bit depth ${info.audio.bitDepth}`);
  }
  if (info.video) {
    check(VIDEO_CODECS.includes(info.video.codec), `video codec ${info.video.codec}`);
    check(finiteNonNegative(info.video.width), `width ${info.video.width}`);
    check(finiteNonNegative(info.video.height), `height ${info.video.height}`);
    check(info.video.fps === null || finiteNonNegative(info.video.fps), `fps ${info.video.fps}`);
    check(info.video.bitrateKbps === null || finiteNonNegative(info.video.bitrateKbps), `video bitrate ${info.video.bitrateKbps}`);
  }
  for (const [key, value] of Object.entries(info.tags)) {
    if (STRING_TAGS.includes(key)) {
      check(typeof value === 'string' && value.length > 0, `tag ${key} is ${JSON.stringify(value)}`);
    } else if (NUMBER_TAGS.includes(key)) {
      check(Number.isInteger(value) && (value as number) > 0, `tag ${key} is ${JSON.stringify(value)}`);
    } else if (key === 'compilation') {
      check(typeof value === 'boolean', `tag ${key} is ${JSON.stringify(value)}`);
    } else if (key === 'declaredKind') {
      check(KINDS.includes(value as string), `tag ${key} is ${JSON.stringify(value)}`);
    } else {
      throw new Error(`unexpected tag key ${key}`);
    }
  }
  let last = -1;
  for (const chapter of info.chapters) {
    check(Number.isInteger(chapter.startMs) && chapter.startMs >= 0, `chapter start ${chapter.startMs}`);
    check(chapter.title.length > 0, 'chapter title is empty');
    check(chapter.startMs >= last, 'chapters are out of order');
    last = chapter.startMs;
  }
  if (info.artwork) {
    expect(info.artwork.mime.startsWith('image/')).toBe(true);
    expect(info.artwork.data).toBeInstanceOf(Uint8Array);
    expect(info.artwork.data.length).toBeGreaterThan(0);
  }
  expect(typeof info.protected).toBe('boolean');
  expect(Array.isArray(info.warnings)).toBe(true);
  for (const warning of info.warnings) {
    expect(typeof warning).toBe('string');
    expect(warning.length).toBeGreaterThan(0);
    expect(warning).not.toContain(String.fromCharCode(0x2014)); // plain sentences, no em dashes
    // The probe catches anything a format reader throws and turns it into this sentence. Reaching it means a reader
    // has a bug, because every damaged input these tests use should be handled by an ordinary check, not an exception.
    check(!/stopped early because the file looks damaged/.test(warning), `a format reader threw: ${warning}`);
  }
}

// ---- one small, rich file for each format ----

interface Fixture {
  name: string;
  bytes: Uint8Array;
  containers: MediaContainer[];
}

const MP4_FAMILY: MediaContainer[] = ['mp4', 'm4a', 'm4b', 'm4v', 'mov', 'unknown'];

function fixtures(): Fixture[] {
  const art = fakeJpeg(300, 7);
  const tag3 = id3v2({
    version: 3,
    frames: [textFrame(3, 'TIT2', 'Title'), textFrame(3, 'TPE1', 'Artist'), commentFrame(3, 'COMM', 'comment'), pictureFrame(3, art), chapterFrame(3, 'c1', 0, 1000, 'One'), chapterFrame(3, 'c2', 1000, 2000, 'Two'), tocFrame(3, 'toc', ['c1', 'c2'])],
    padding: 40,
  });
  const tag4 = id3v2({ version: 4, frames: [textFrame(4, 'TIT2', 'Title 2.4'), textFrame(4, 'TDRC', '2020'), pictureFrame(4, art, { flags: 0x0002 })], extendedHeader: true, footer: true });
  const mp3 = mp3File({ id3: tag3, frames: [vbrHeaderFrame({ kind: 'Xing', ...CBR_48K_128, frames: 12, bytes: 4992 }), mpegFrames(CBR_48K_128, 12)], id3v1: id3v1({ title: 'v1' }) });
  const mp3b = mp3File({ id3: tag4, frames: [mpegFrames(CBR_48K_128, 12)] });
  const aac = cat(tag3, ...Array.from({ length: 20 }, () => adtsFrame({ sampleRateIndex: 4, channelConfig: 2, payload: 100 })));

  const entry = audioEntry('mp4a', { channels: 2, rate: 48000 }, esds({ objectType: 0x40, asc: ascLc(3, 2) }));
  const items = [textItem(`${COPY}nam`, 'Title'), textItem(`${COPY}ART`, 'Artist'), intItem('stik', 2), covrItem({ bytes: art, flags: 13 })];
  const titles = [
    { title: 'One', ticks: 10000 },
    { title: 'Two', ticks: 20000 },
  ];
  const chapterData = chapterTrack({ id: 2, timescale: 1000, titles, dataOffset: 0 }).data;
  const m4b = (moovFirst: boolean) =>
    movieFile({
      brand: 'M4B ',
      moovFirst,
      mdatPayload: cat(chapterData, zeros(100)),
      tracks: (offset) => [audioTrackWith(entry, { chapters: 2, samples: 100 }), chapterTrack({ id: 2, timescale: 1000, titles, dataOffset: offset }).trak],
      moovExtras: [box('udta', ilstMeta(...items), chpl([{ startMs: 0, title: 'One' }, { startMs: 10000, title: 'Two' }]))],
    });
  const video = movieFile({
    brand: 'M4V ',
    tracks: [videoTrackWith(visualEntry('avc1', { width: 320, height: 240 }, avcC(66, 0xc0, 30)), { samples: 50, duration: 1500 }), audioTrackWith(entry, { samples: 50 })],
    moovExtras: [box('udta', ilstMeta(intItem('stik', 21)))],
  });
  const drm = movieFile({ tracks: [audioTrackWith(audioEntry('drms', { channels: 2, rate: 44100 }, esds({ objectType: 0x40, asc: ascLc(4, 2) }), sinf('mp4a')), { samples: 50 })] });
  const mov = movieFile({ brand: null, tracks: [audioTrackWith(entry, { samples: 50 })] });

  const vorbisFile = oggFile({
    head: vorbisIdPacket({ channels: 2, rate: 44100, nominalBitrate: 96000 }),
    comments: vorbisCommentPacket(['TITLE=Vorbis', 'ARTIST=Someone', `METADATA_BLOCK_PICTURE=${Buffer.from(pictureBody({ mime: 'image/jpeg', data: art })).toString('base64')}`]),
    setup: vorbisSetupPacket(),
    lastGranule: 44100,
  });
  const opusFile = oggFile({ head: opusHeadPacket({ channels: 2, preSkip: 312 }), comments: opusTagsPacket(['TITLE=Opus']), lastGranule: 48312 });

  return [
    { name: 'mp3 with ID3v2.3, Xing and ID3v1', bytes: mp3, containers: ['mp3', 'unknown'] },
    { name: 'mp3 with ID3v2.4, extended header and footer', bytes: mp3b, containers: ['mp3', 'unknown'] },
    { name: 'aac', bytes: aac, containers: ['aac', 'mp3', 'unknown'] },
    { name: 'm4b with chapters, moov last', bytes: m4b(false), containers: MP4_FAMILY },
    { name: 'm4b with chapters, moov first', bytes: m4b(true), containers: MP4_FAMILY },
    { name: 'm4v with H.264 and AAC', bytes: video, containers: MP4_FAMILY },
    { name: 'FairPlay m4p', bytes: drm, containers: MP4_FAMILY },
    { name: 'QuickTime mov', bytes: mov, containers: MP4_FAMILY },
    { name: 'FLAC with tags and a picture', bytes: flacFile({ comments: ['TITLE=Flac', 'CHAPTER001=00:00:00.000', 'CHAPTER001NAME=One'], pictures: [{ mime: 'image/jpeg', data: art }], audioBytes: 300 }), containers: ['flac', 'unknown'] },
    { name: 'WAV with LIST', bytes: simpleWav({ dataBytes: 400, after: [listInfo({ INAM: 'Wav', IART: 'Someone' })] }), containers: ['wav', 'unknown'] },
    { name: 'AIFF', bytes: aiffFile({ chunks: [aiffComm({ channels: 2, frames: 100, bits: 16, rate: 44100 }), aiffChunk('NAME', utf8('Aiff')), ssnd(400)] }), containers: ['aiff', 'unknown'] },
    { name: 'Ogg Vorbis with a picture', bytes: vorbisFile, containers: ['ogg', 'unknown'] },
    { name: 'Ogg Opus', bytes: opusFile, containers: ['opus', 'ogg', 'unknown'] },
    {
      name: 'Matroska',
      bytes: mkvFile({ durationTicks: 3000, tracks: [mkvVideoTrack({ codecId: 'V_MPEG4/ISO/AVC', width: 320, height: 240, defaultDurationNs: 40000000, codecPrivate: Uint8Array.from([1, 66, 0, 30]) }), mkvAudioTrack({ codecId: 'A_AAC', rate: 44100, channels: 2, codecPrivate: ascLc(4, 2) })], clusterBytes: 100 }),
      containers: ['mkv', 'webm', 'unknown'],
    },
    {
      name: 'AVI',
      bytes: aviFile({
        main: aviMainHeader({ microsPerFrame: 40000, totalFrames: 50, width: 320, height: 240 }),
        streams: [
          [aviStreamHeader({ type: 'vids', handler: 'XVID', scale: 1, rate: 25, length: 50 }), aviVideoFormat({ width: 320, height: 240, compression: 'XVID' })],
          [aviStreamHeader({ type: 'auds', handler: '\0\0\0\0', scale: 1, rate: 44100, length: 10 }), aviAudioFormat({ tag: 0x55, channels: 2, rate: 44100, avgBytes: 16000, bits: 0 })],
        ],
        moviBytes: 50,
      }),
      containers: ['avi', 'unknown'],
    },
    {
      name: 'ASF',
      bytes: asfFile([asfFileProperties({ playDuration100ns: 50_000_000, prerollMs: 100 }), asfAudioStream({ tag: 0x161, channels: 2, rate: 44100, avgBytes: 16000, bits: 16 }), asfVideoStream({ width: 320, height: 240, compression: 'WMV3' }), asfContentDescription({ title: 'Asf', author: 'Someone' })]),
      containers: ['wma', 'unknown'],
    },
  ];
}

const ALL = fixtures();

/** Every cut offset for a small file, an even spread for a bigger one, and always the first and last few. */
function cutOffsets(length: number): number[] {
  const step = length <= 4000 ? 1 : Math.ceil(length / 2000);
  const set = new Set<number>();
  for (let at = 0; at < length; at += step) set.add(at);
  for (let at = 0; at < Math.min(64, length); at += 1) set.add(at);
  for (let at = Math.max(0, length - 40); at < length; at += 1) set.add(at);
  return [...set].sort((a, b) => a - b);
}

describe('truncated files', () => {
  for (const fixture of ALL) {
    it(`never throw, at any cut point: ${fixture.name}`, async () => {
      // The whole file first, to be sure the fixture itself reads cleanly.
      const whole = await probeBytes('whole', fixture.bytes);
      expectWellFormed(whole, fixture.bytes.length);
      expect(fixture.containers).toContain(whole.container);
      expect(whole.container).not.toBe('unknown');

      for (const cut of cutOffsets(fixture.bytes.length)) {
        const info = await probeBytes('cut', fixture.bytes.subarray(0, cut));
        expectWellFormed(info, cut);
        expect(fixture.containers).toContain(info.container);
      }
    });
  }

  // These formats say how long their data should be (a VBR header, a box size, a chunk size), so a cut can be seen.
  // A plain constant bitrate MP3, an Ogg file or a FLAC file just ends, and nothing in them can say it is short.
  it('says so when a file that states its own size is cut in half', async () => {
    const detectable = /^(mp3 with ID3v2\.3|m4|FairPlay|QuickTime|WAV|AIFF)/;
    for (const fixture of ALL.filter((f) => detectable.test(f.name))) {
      const half = await probeBytes('half', fixture.bytes.subarray(0, Math.floor(fixture.bytes.length / 2)));
      expect(half.warnings.length, fixture.name).toBeGreaterThan(0);
    }
  });
});

describe('damaged files', () => {
  it('never throws for random garbage', async () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const bytes = randomBytes((seed * 37) % 6000, seed);
      const info = await probeBytes('garbage.bin', bytes);
      expectWellFormed(info, bytes.length);
    }
  });

  it('never throws for random bytes behind each format signature', async () => {
    const signatures: Uint8Array[] = [
      utf8('ID3'),
      Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x7f, 0x7f]),
      Uint8Array.from([0xff, 0xfb, 0x90, 0x00]),
      Uint8Array.from([0xff, 0xf1, 0x50, 0x80]),
      utf8('fLaC'),
      cat([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]),
      utf8('OggS'),
      cat('OggS', [0, 2], zeros(8), be32(7), zeros(8), [1, 30], 'OpusHead', [1, 2]),
      cat('OggS', [0, 2], zeros(8), be32(7), zeros(8), [1, 30], [1], 'vorbis'),
      cat('RIFF', [0xff, 0xff, 0xff, 0x7f], 'WAVE'),
      cat('RIFF', [0xff, 0xff, 0xff, 0x7f], 'AVI '),
      cat('FORM', [0, 0, 0xff, 0xff], 'AIFF'),
      cat('FORM', [0, 0, 0xff, 0xff], 'AIFC'),
      cat(be32(24), 'ftyp', 'M4A ', be32(0), 'mp42', 'isom'),
      cat(be32(1), 'ftyp', be64(0xffffffffff)),
      cat(be32(0xffffffff), 'ftyp'),
      cat(be32(100), 'moov'),
      cat(be32(0), 'mdat'),
      Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]),
      Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      Uint8Array.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]),
    ];
    for (let s = 0; s < signatures.length; s += 1) {
      for (let seed = 1; seed <= 25; seed += 1) {
        const tail = randomBytes(seed * 50, seed * 1000 + s);
        const bytes = cat(signatures[s] as Uint8Array, tail);
        const info = await probeBytes('sig.bin', bytes);
        expectWellFormed(info, bytes.length);
      }
    }
  });

  it('never throws when bytes of a good file are changed', async () => {
    for (const fixture of ALL) {
      for (let round = 0; round < 300; round += 1) {
        const bytes = fixture.bytes.slice();
        const noise = randomBytes(64, round * 7919 + 13);
        const changes = 1 + (round % 8);
        for (let c = 0; c < changes; c += 1) {
          const at = ((noise[c * 2] as number) * 256 + (noise[c * 2 + 1] as number)) % bytes.length;
          if (round % 3 === 0) {
            // Put the biggest possible number where a length or count might be.
            for (let k = 0; k < 4 && at + k < bytes.length; k += 1) bytes[at + k] = 0xff;
          } else if (round % 3 === 1) {
            for (let k = 0; k < 4 && at + k < bytes.length; k += 1) bytes[at + k] = 0;
          } else {
            bytes[at] = noise[c + 32] as number;
          }
        }
        const info = await probeBytes('mutated', bytes);
        try {
          expectWellFormed(info, bytes.length);
        } catch (error) {
          throw new Error(`${fixture.name}, round ${round}: ${(error as Error).message}`);
        }
      }
    }
  }, 60000);

  it('survives lengths and counts that claim far more than the file holds', async () => {
    const hugeBox = cat(ftyp('M4A '), be32(1), 'moov', be64(2 ** 52));
    expectWellFormed(await probeBytes('huge.m4a', hugeBox), hugeBox.length);

    const lyingTable = trak({ id: 1, handler: 'soun', timescale: 48000, duration: 100000, sampleCount: 0xffffffff, sampleSize: 0, entry: audioEntry('mp4a', { channels: 2, rate: 48000 }, esds({ objectType: 0x40, asc: ascLc(3, 2) })) });
    const lying = await probeBytes('lying.m4a', movieFile({ tracks: [lyingTable] }));
    expectWellFormed(lying, lying.sizeBytes);
    expect(lying.audio?.codec).toBe('aac');

    const bigCount = cat('fLaC', Uint8Array.from([0x84, 0xff, 0xff, 0xff]), zeros(20));
    expectWellFormed(await probeBytes('c.flac', bigCount), bigCount.length);

    const hugeVorbis = oggFile({ head: vorbisIdPacket({ channels: 2, rate: 44100 }), comments: cat([3], 'vorbis', Uint8Array.from([0xff, 0xff, 0xff, 0x7f]), zeros(12)), lastGranule: 44100 });
    expectWellFormed(await probeBytes('h.ogg', hugeVorbis), hugeVorbis.length);

    const wavHuge = cat('RIFF', [0xff, 0xff, 0xff, 0xff], 'WAVE', 'fmt ', [16, 0, 0, 0], [1, 0, 2, 0], [0x44, 0xac, 0, 0], [0x10, 0xb1, 2, 0], [4, 0, 16, 0], 'data', [0xff, 0xff, 0xff, 0xff], zeros(100));
    const wav = await probeBytes('h.wav', wavHuge);
    expectWellFormed(wav, wavHuge.length);
    expect(wav.audio?.sampleRateHz).toBe(44100);
  });
});

describe('sources that misbehave', () => {
  it('returns a result when every read fails', async () => {
    const source: FileSource = { name: 'broken', size: 5000, slice: async () => Promise.reject(new Error('disk gone')) };
    const info = await probeMedia(source);
    expectWellFormed(info, 5000);
    expect(info.container).toBe('unknown');
    expect(info.warnings.join(' ')).toContain('could not be read');
  });

  it('returns what it had when reads start failing partway', async () => {
    // A 200 KB mdat in front means the moov is past the first block that is read, so reading it needs a second slice.
    const bytes = movieFile({ brand: 'M4B ', tracks: [audioTrackWith(audioEntry('mp4a', { channels: 2, rate: 48000 }, esds({ objectType: 0x40, asc: ascLc(3, 2) })))], mdatPayload: zeros(200_000) });
    let calls = 0;
    const source: FileSource = {
      name: 'flaky.m4b',
      size: bytes.length,
      slice: async (start, end) => {
        calls += 1;
        if (calls > 1) throw new Error('read error');
        return bytes.subarray(start, end);
      },
    };
    const info = await probeMedia(source);
    expectWellFormed(info, bytes.length);
    expect(info.container).toBe('m4b'); // what the first read gave is kept
    expect(info.warnings.join(' ')).toContain('could not be read');
  });

  it('reads through a Blob source the way a browser File is read', async () => {
    for (const fixture of ALL) {
      const viaBlob = await probeMedia(fileSourceFromBlob('f', new Blob([fixture.bytes.slice()])));
      const viaBytes = await probeBytes('f', fixture.bytes);
      expect(viaBlob, fixture.name).toEqual(viaBytes);
    }
  });

  it('copes with a source that throws something that is not an Error, or returns the wrong thing', async () => {
    const thrower: FileSource = { name: 't', size: 100, slice: () => { throw 'a string'; } };
    expectWellFormed(await probeMedia(thrower), 100);
    const wrong = { name: 'w', size: 100, slice: async () => 'not bytes' } as unknown as FileSource;
    expectWellFormed(await probeMedia(wrong), 100);
    const undef = { name: 'u', size: 100, slice: async () => undefined } as unknown as FileSource;
    expectWellFormed(await probeMedia(undef), 100);
  });

  it('copes with a slice that returns more than was asked for', async () => {
    const bytes = ALL[0]?.bytes as Uint8Array;
    const greedy: FileSource = { name: 'g.mp3', size: bytes.length, slice: async (start) => bytes.subarray(start) };
    const info = await probeMedia(greedy);
    expectWellFormed(info, bytes.length);
    expect(info.container).toBe('mp3');
    expect(info.tags.title).toBe('Title');
  });

  it('copes with a source that says it is bigger or smaller than it is', async () => {
    const bytes = ALL[0]?.bytes as Uint8Array;
    const bigger: FileSource = { name: 'b.mp3', size: bytes.length + 1000, slice: async (s, e) => bytes.subarray(s, e) };
    expectWellFormed(await probeMedia(bigger), bytes.length + 1000);
    const smaller: FileSource = { name: 's.mp3', size: 200, slice: async (s, e) => bytes.subarray(s, e) };
    expectWellFormed(await probeMedia(smaller), 200);
  });

  it('copes with a size that is not a sensible number', async () => {
    for (const size of [Number.NaN, -5, Number.POSITIVE_INFINITY, 0.5]) {
      const info = await probeMedia({ name: 'odd', size, slice: async () => new Uint8Array(0) });
      expect(info.container).toBe('unknown');
      expect(finiteNonNegative(info.sizeBytes)).toBe(true);
    }
  });

  it('copes with a source whose properties throw', async () => {
    const hostile = {
      get name(): string {
        throw new Error('no name');
      },
      get size(): number {
        throw new Error('no size');
      },
      slice: async () => new Uint8Array(0),
    } as unknown as FileSource;
    const info = await probeMedia(hostile);
    expect(info.container).toBe('unknown');
    expect(info.warnings.length).toBeGreaterThan(0);
  });

  it('does not change the bytes it reads, and gives the same answer twice', async () => {
    for (const fixture of ALL) {
      const copy = fixture.bytes.slice();
      const first = await probeBytes('x', fixture.bytes);
      const second = await probeBytes('x', fixture.bytes);
      expect(fixture.bytes).toEqual(copy);
      expect(second).toEqual(first);
    }
  });
});

describe('the reader', () => {
  const warnings: string[] = [];
  const bytes = Uint8Array.from({ length: 300_000 }, (_, i) => i & 0xff);

  it('clamps reads to the file and never returns more than asked', async () => {
    const reader = new Reader({ name: 'r', size: bytes.length, slice: async (s, e) => bytes.subarray(s, e) }, (m) => warnings.push(m));
    expect((await reader.read(bytes.length - 10, 100)).length).toBe(10);
    expect((await reader.read(bytes.length + 5, 10)).length).toBe(0);
    expect((await reader.read(-50, 10)).length).toBe(10);
    expect((await reader.read(10, -3)).length).toBe(0);
    expect((await reader.read(Number.NaN, 10)).length).toBe(0);
    expect(await reader.readExact(0, 4)).toEqual(Uint8Array.from([0, 1, 2, 3]));
    expect(await reader.readExact(bytes.length - 2, 4)).toBeNull();
  });

  it('serves many small reads in a row from one slice', async () => {
    const recorded = recordingSource('r', bytes);
    const reader = new Reader(recorded.source, () => undefined);
    for (let at = 0; at < 8000; at += 16) await reader.read(at, 16);
    expect(recorded.calls().length).toBe(1);
  });

  it('does not cache big reads', async () => {
    const recorded = recordingSource('r', bytes);
    const reader = new Reader(recorded.source, () => undefined);
    await reader.read(0, 100_000);
    await reader.read(0, 100_000);
    expect(recorded.calls().length).toBe(2);
  });

  it('returns the right bytes from the cached block', async () => {
    const recorded = recordingSource('r', bytes);
    const reader = new Reader(recorded.source, () => undefined);
    await reader.read(1000, 16);
    expect(Array.from(await reader.read(1100, 4))).toEqual([1100 & 0xff, 1101 & 0xff, 1102 & 0xff, 1103 & 0xff]);
  });

  it('warns once when the source fails', async () => {
    const seen: string[] = [];
    const reader = new Reader({ name: 'r', size: 1000, slice: async () => Promise.reject(new Error('x')) }, (m) => seen.push(m));
    await reader.read(0, 10);
    await reader.read(500, 10);
    expect(seen.length).toBe(1);
  });
});

// ---- large files are read in pieces ----

/** A file that exists only as a size and a few real pieces. Everything else reads as zeros, or as `fill` produces. */
function virtualFile(o: { size: number; pieces: [number, Uint8Array][]; fill?: (out: Uint8Array, start: number) => void }) {
  const calls: [number, number][] = [];
  const source: FileSource = {
    name: 'virtual',
    size: o.size,
    slice: async (start, end) => {
      const from = Math.max(0, start);
      const to = Math.min(o.size, end);
      calls.push([from, to]);
      const length = Math.max(0, to - from);
      if (length > 80_000_000) throw new Error('the test source refuses a slice this big');
      const out = new Uint8Array(length);
      o.fill?.(out, from);
      for (const [at, piece] of o.pieces) {
        const lo = Math.max(from, at);
        const hi = Math.min(to, at + piece.length);
        if (hi > lo) out.set(piece.subarray(lo - at, hi - at), lo - from);
      }
      return out;
    },
  };
  return {
    source,
    requested: () => calls.reduce((sum, [a, b]) => sum + (b - a), 0),
    biggest: () => calls.reduce((max, [a, b]) => Math.max(max, b - a), 0),
    count: () => calls.length,
  };
}

describe('large files are read in pieces', () => {
  const GB = 1_000_000_000;

  it('reads a 3 GB MP4 with the moov first without touching the mdat', async () => {
    const head = cat(ftyp('M4B ', ['M4B ', 'mp42', 'isom']), box('moov', mvhd({ timescale: 1000, duration: 36_000_000 }), aacTrack({ rate: 48000, asc: ascLc(3, 2), samples: 1_687_500, sampleBytes: 1779 }), box('udta', ilstMeta(textItem(`${COPY}nam`, 'A very long audiobook'), intItem('stik', 2)))));
    const mdatHeader = cat(be32(1), 'mdat', be64(3 * GB + 16));
    const file = virtualFile({ size: head.length + mdatHeader.length + 3 * GB, pieces: [[0, head], [head.length, mdatHeader]] });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('m4b');
    expect(info.durationMs).toBe(36_000_000);
    expect(info.tags).toMatchObject({ title: 'A very long audiobook', declaredKind: 'audiobook' });
    expect(info.audio?.codec).toBe('aac');
    expect(info.sizeBytes).toBe(head.length + mdatHeader.length + 3 * GB);
    expect(file.requested()).toBeLessThan(300_000);
    expect(file.biggest()).toBeLessThan(200_000);
  });

  it('finds a moov that sits after a 3 GB mdat with a 64 bit size', async () => {
    const front = ftyp('M4A ', ['M4A ', 'mp42', 'isom']);
    const mdatHeader = cat(be32(1), 'mdat', be64(3 * GB + 16));
    const moov = box('moov', mvhd({ timescale: 1000, duration: 40000 }), aacTrack({ rate: 48000, asc: ascLc(3, 2), samples: 1875, sampleBytes: 640 }), box('udta', ilstMeta(textItem(`${COPY}nam`, 'Moov last'))));
    const moovAt = front.length + mdatHeader.length + 3 * GB;
    const file = virtualFile({ size: moovAt + moov.length, pieces: [[0, front], [front.length, mdatHeader], [moovAt, moov]] });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('m4a');
    expect(info.durationMs).toBe(40000);
    expect(info.tags.title).toBe('Moov last');
    expect(file.requested()).toBeLessThan(300_000);
    expect(file.count()).toBeLessThan(60);
  });

  it('reads a big sample table in 1 MB pieces, and no more than it needs', async () => {
    const samples = 800_000; // about 10 hours of AAC
    const sizes = new Array<number>(samples).fill(1500);
    const entry = audioEntry('mp4a', { channels: 2, rate: 22050 }, esds({ objectType: 0x40, asc: ascLc(7, 2) }));
    const track = trak({ id: 1, handler: 'soun', timescale: 22050, duration: samples * 1024, sampleCount: samples, sampleSizes: sizes, entry });
    const head = cat(ftyp('M4B '), box('moov', mvhd({ timescale: 1000, duration: Math.round((samples * 1024 * 1000) / 22050) }), track));
    const mdatHeader = cat(be32(1), 'mdat', be64(1_200_000_000 + 16));
    const file = virtualFile({ size: head.length + mdatHeader.length + 1_200_000_000, pieces: [[0, head], [head.length, mdatHeader]] });
    const info = await probeMedia(file.source);
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 22050 });
    // 800000 samples x 1500 bytes over 37151 seconds is 258 kbps, from the table.
    expect(info.audio?.bitrateKbps).toBe(258);
    expect(file.biggest()).toBeLessThanOrEqual(1024 * 1024 + 16);
    expect(file.requested()).toBeLessThan(4_500_000);
  });

  it('reads a 1.9 GB constant bitrate MP3 from its first and last bytes only', async () => {
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'Huge')] });
    const frame = mpegFrame(CBR_48K_128); // 384 bytes
    const frames = 5_000_000;
    const size = tag.length + 384 * frames + 128;
    const trailer = id3v1({ title: 'Huge v1' });
    const file = virtualFile({
      size,
      pieces: [[0, tag], [size - 128, trailer]],
      fill: (out, start) => {
        for (let i = 0; i < out.length; i += 1) {
          const rel = start + i - tag.length;
          if (rel >= 0 && rel % 384 < 4) out[i] = frame[rel % 384] as number;
        }
      },
    });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('mp3');
    expect(info.audio).toMatchObject({ sampleRateHz: 48000, bitrateKbps: 128, variableBitrate: false });
    expect(info.durationMs).toBe(120_000_000); // 5,000,000 frames of 24 ms
    expect(info.tags.title).toBe('Huge');
    expect(file.requested()).toBeLessThan(400_000);
  });

  it('does not read a cover picture that it does not use', async () => {
    const front = fakeJpeg(1_000_000, 1);
    const back = fakeJpeg(4_000_000, 2);
    const tag = id3v2({ version: 3, frames: [pictureFrame(3, back, { type: 4 }), pictureFrame(3, front, { type: 3 }), textFrame(3, 'TIT2', 'Two pictures')] });
    const frame = mpegFrame(CBR_48K_128);
    const file = virtualFile({
      size: tag.length + 384 * 1_000_000,
      pieces: [[0, tag]],
      fill: (out, start) => {
        for (let i = 0; i < out.length; i += 1) {
          const rel = start + i - tag.length;
          if (rel >= 0 && rel % 384 < 4) out[i] = frame[rel % 384] as number;
        }
      },
    });
    const info = await probeMedia(file.source);
    expect(info.tags.title).toBe('Two pictures');
    expect(info.artwork?.data.length).toBe(front.length);
    expect(file.requested()).toBeLessThan(1_800_000); // the 1 MB front cover and a few small blocks, and not the 4 MB back cover
    expect(file.biggest()).toBeLessThan(1_100_000);
  });

  it('reads a 1 GB FLAC from its metadata only', async () => {
    const head = flacFile({ samples: 44100 * 3600, comments: ['TITLE=Long mix'], audioBytes: 0 });
    const file = virtualFile({ size: head.length + GB, pieces: [[0, head]] });
    const info = await probeMedia(file.source);
    expect(info.durationMs).toBe(3_600_000);
    expect(info.tags.title).toBe('Long mix');
    expect(info.audio?.bitrateKbps).toBe(Math.round((GB * 8) / 3_600_000));
    expect(file.requested()).toBeLessThan(200_000);
  });

  it('reads a 4 GB WAV from its header only', async () => {
    const dataBytes = 4_000_000_000;
    const header = cat('RIFF', [0xff, 0xff, 0xff, 0xff], 'WAVE', 'fmt ', [16, 0, 0, 0], [1, 0, 2, 0], [0x44, 0xac, 0, 0], [0x10, 0xb1, 2, 0], [4, 0, 16, 0], 'data', [0x00, 0x28, 0x6b, 0xee]);
    const file = virtualFile({ size: header.length + dataBytes, pieces: [[0, header]] });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('wav');
    expect(info.durationMs).toBe(Math.round((dataBytes * 1000) / 176400));
    expect(file.requested()).toBeLessThan(100_000);
  });

  it('reads a 1 GB Ogg file from its first pages and its last pages', async () => {
    const head = oggFile({ head: vorbisIdPacket({ channels: 2, rate: 44100, nominalBitrate: 192000 }), comments: vorbisCommentPacket(['TITLE=Big ogg']), setup: vorbisSetupPacket(), lastGranule: null });
    const tail = cat(oggPage({ serial: 1111, seq: 1000, granule: 44100 * 3600, flags: 4, lacing: [100], body: zeros(100) }));
    const size = head.length + GB;
    const file = virtualFile({ size, pieces: [[0, head], [size - tail.length, tail]] });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('ogg');
    expect(info.durationMs).toBe(3_600_000);
    expect(info.tags.title).toBe('Big ogg');
    expect(file.requested()).toBeLessThan(400_000);
  });

  it('skips a 2 GB Matroska cluster by its size to reach the tracks behind it', async () => {
    const header = el(MKV.EBML, elStr(MKV.DocType, 'webm'));
    const segmentHeader = cat(ebmlId(MKV.Segment), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // unknown size
    const infoElement = el(MKV.Info, elFloat(MKV.Duration, 7_200_000));
    const clusterHeader = cat(ebmlId(MKV.Cluster), [0x01, 0, 0, 0, 0x77, 0x35, 0x94, 0]); // 8 byte size: 2,000,000,000
    const front = cat(header, segmentHeader, infoElement, clusterHeader);
    const tracks = el(MKV.Tracks, mkvVideoTrack({ codecId: 'V_VP9', width: 1920, height: 1080 }));
    const file = virtualFile({ size: front.length + 2_000_000_000 + tracks.length, pieces: [[0, front], [front.length + 2_000_000_000, tracks]] });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('webm');
    expect(info.video).toMatchObject({ codec: 'vp9', width: 1920, height: 1080 });
    expect(info.durationMs).toBe(7_200_000);
    expect(file.requested()).toBeLessThan(100_000);
  });

  it('estimates the length of a 1 GB AAC stream from its first part, and says it is an estimate', async () => {
    const frame = adtsFrame({ sampleRateIndex: 4, channelConfig: 2, payload: 193 }); // 200 bytes
    const size = 200 * 5_000_000;
    const file = virtualFile({
      size,
      pieces: [],
      fill: (out, start) => {
        for (let i = 0; i < out.length; i += 1) out[i] = frame[(start + i) % 200] as number;
      },
    });
    const info = await probeMedia(file.source);
    expect(info.container).toBe('aac');
    // 5,000,000 frames of 1024 samples at 44100 Hz
    expect(info.durationMs).toBe(Math.round((5_000_000 * 1024 * 1000) / 44100));
    expect(info.warnings.join(' ')).toContain('estimate');
    expect(file.requested()).toBeLessThan(600_000);
  });

  it('stops reading after a fixed total when a crafted file asks for gigabytes', async () => {
    // An ilst that holds 1000 items of 1 MB each. Each is small enough to read, but together they are a gigabyte.
    const items = 1000;
    const itemSize = 1_000_000;
    const hdlr = fullBox('hdlr', 0, 0, be32(0), 'mdir', 'appl', be32(0), be32(0), [0]);
    const ilstSize = 8 + items * itemSize;
    const metaSize = 8 + 4 + hdlr.length + ilstSize;
    const udtaSize = 8 + metaSize;
    const mvhdBox = mvhd({ timescale: 1000, duration: 5000 });
    const moovSize = 8 + mvhdBox.length + udtaSize;
    const front = cat(ftyp('M4A '), be32(moovSize), 'moov', mvhdBox, be32(udtaSize), 'udta', be32(metaSize), 'meta', be32(0), hdlr, be32(ilstSize), 'ilst');
    const file = virtualFile({
      size: front.length + items * itemSize,
      pieces: [[0, front]],
      fill: (out, start) => {
        // Every megabyte begins with an item header: its size and a name of its own (a copyright sign and three letters).
        const first = Math.ceil((start - front.length) / itemSize) * itemSize + front.length;
        for (let at = Math.max(first, front.length); at < start + out.length; at += itemSize) {
          const n = (at - front.length) / itemSize;
          const header = [...be32(itemSize), 0xa9, 97 + (n % 26), 97 + (Math.floor(n / 26) % 26), 97 + (Math.floor(n / 676) % 26)];
          header.forEach((byte, i) => {
            const index = at + i - start;
            if (index >= 0 && index < out.length) out[index] = byte;
          });
        }
      },
    });
    const info = await probeMedia(file.source);
    expectWellFormed(info, front.length + items * itemSize);
    expect(info.warnings.join(' ')).toContain('more reading than is reasonable');
    expect(file.requested()).toBeLessThan(200 * 1024 * 1024);
  }, 30000);

  it('steps over a 64 bit box with a size beyond 4 GB', async () => {
    const front = ftyp('M4A ');
    const free = cat(be32(1), 'free', be64(6_000_000_000 + 16));
    const moov = box('moov', mvhd({ timescale: 1000, duration: 5000 }), aacTrack({ rate: 48000, asc: ascLc(3, 2), samples: 235, sampleBytes: 640 }));
    const at = front.length + free.length + 6_000_000_000;
    const file = virtualFile({ size: at + moov.length, pieces: [[0, front], [front.length, free], [at, moov]] });
    const info = await probeMedia(file.source);
    expect(info.durationMs).toBe(5000);
    expect(info.audio?.codec).toBe('aac');
  });
});
