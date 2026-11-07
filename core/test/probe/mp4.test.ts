import { describe, expect, it } from 'vitest';
import {
  AAC_RATE_INDEX,
  aacTrack,
  alacCookie,
  ascHeBackward,
  ascHeExplicit,
  ascLc,
  audioEntry,
  audioTrackWith,
  avcC,
  box,
  btrt,
  chapterTrack,
  chpl,
  COPY,
  covrItem,
  data,
  diskItem,
  esds,
  freeformItem,
  fullBox,
  gnreItem,
  hvcC,
  ilstMeta,
  ilstMetaQuickTime,
  intItem,
  movieFile,
  simpleAudioFile,
  sinf,
  smpbText,
  textItem,
  trknItem,
  videoTrackWith,
  visualEntry,
  ftyp,
  assemble,
  mvhd,
  trak,
} from './build-mp4';
import { be16, be32, cat, fakeJpeg, fakePng, probeBytes, utf8, zeros } from './helpers';

const lcEntry = (rate = 48000, channels = 2) => audioEntry('mp4a', { channels, rate }, esds({ objectType: 0x40, asc: ascLc(AAC_RATE_INDEX[rate as 48000] ?? 3, channels) }));
const h264Entry = (profile = 66, compat = 0xc0, level = 30, width = 640, height = 480) => visualEntry('avc1', { width, height }, avcC(profile, compat, level));
const withItems = (...items: Uint8Array[]) => simpleAudioFile({ items });

describe('M4A audio', () => {
  it('reads the stream, the length and a bitrate worked out from the sample sizes', async () => {
    const info = await probeBytes('song.m4a', simpleAudioFile({}));
    expect(info.container).toBe('m4a');
    // 1875 samples of 1024 at 48000 Hz is exactly 40 seconds, and 1875 x 640 bytes over 40 s is 240 kbps.
    expect(info.durationMs).toBe(40000);
    expect(info.audio).toEqual({ codec: 'aac', sampleRateHz: 48000, channels: 2, bitrateKbps: 240 });
    expect(info.video).toBeNull();
    expect(info.protected).toBe(false);
    expect(info.warnings).toEqual([]);
  });

  it('falls back to the bitrate in esds when there is no usable sample table', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 48000 }, esds({ objectType: 0x40, asc: ascLc(3, 2), avgBitrate: 192000 }));
    const file = movieFile({ tracks: [audioTrackWith(entry, { sampleBytes: 0, samples: 0 })], movieDuration: 40000 });
    const info = await probeBytes('esds.m4a', file);
    expect(info.audio?.bitrateKbps).toBe(192);
  });

  it('reads descriptors written with four byte lengths', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 44100 }, esds({ objectType: 0x40, asc: ascLc(4, 2), padded: true }));
    const info = await probeBytes('padded.m4a', movieFile({ tracks: [audioTrackWith(entry, { timescale: 44100 })] }));
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 44100, channels: 2 });
  });

  it('knows a mono track', async () => {
    const info = await probeBytes('mono.m4a', movieFile({ tracks: [audioTrackWith(lcEntry(48000, 1))] }));
    expect(info.audio?.channels).toBe(1);
  });

  it('reads 96000 Hz from the media timescale, because the 16 bit sample entry field cannot hold it', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 96000 }, esds({ objectType: 0x40, asc: ascLc(0, 2) }));
    const info = await probeBytes('hires.m4a', movieFile({ tracks: [audioTrackWith(entry, { timescale: 96000 })] }));
    expect(info.audio?.sampleRateHz).toBe(96000);
  });

  it('calls an esds that names MP3 an MP3', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 44100 }, esds({ objectType: 0x6b }));
    const info = await probeBytes('mp3in.mp4', movieFile({ tracks: [audioTrackWith(entry, { timescale: 44100 })] }));
    expect(info.audio?.codec).toBe('mp3');
  });

  it('says so when an AAC entry has no codec details', async () => {
    const info = await probeBytes('noesds.m4a', movieFile({ tracks: [audioTrackWith(audioEntry('mp4a', { channels: 2, rate: 48000 }))] }));
    expect(info.audio?.codec).toBe('unknown');
    expect(info.warnings.join(' ')).toContain('esds');
  });
});

describe('AAC-LC against HE-AAC', () => {
  const codecFor = async (entry: Uint8Array) => (await probeBytes('x.m4a', movieFile({ tracks: [audioTrackWith(entry)] }))).audio;

  it('reads plain AAC-LC as aac', async () => {
    expect(await codecFor(lcEntry())).toMatchObject({ codec: 'aac', sampleRateHz: 48000 });
  });

  it('reads HE-AAC announced with object type 5, and reports the output rate', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 24000 }, esds({ objectType: 0x40, asc: ascHeExplicit(AAC_RATE_INDEX[24000], AAC_RATE_INDEX[48000], 2) }));
    expect(await codecFor(entry)).toMatchObject({ codec: 'he-aac', sampleRateHz: 48000, channels: 2 });
  });

  it('reads HE-AAC announced by the backward compatible extension', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 24000 }, esds({ objectType: 0x40, asc: ascHeBackward(AAC_RATE_INDEX[24000], AAC_RATE_INDEX[48000], 2) }));
    expect(await codecFor(entry)).toMatchObject({ codec: 'he-aac', sampleRateHz: 48000 });
  });

  it('reads HE-AAC version 2 (parametric stereo) as two channels even when the core is mono', async () => {
    const explicit = audioEntry('mp4a', { channels: 1, rate: 24000 }, esds({ objectType: 0x40, asc: ascHeExplicit(AAC_RATE_INDEX[24000], AAC_RATE_INDEX[48000], 1, true) }));
    expect(await codecFor(explicit)).toMatchObject({ codec: 'he-aac', channels: 2 });
    const backward = audioEntry('mp4a', { channels: 1, rate: 24000 }, esds({ objectType: 0x40, asc: ascHeBackward(AAC_RATE_INDEX[24000], AAC_RATE_INDEX[48000], 1, true) }));
    expect(await codecFor(backward)).toMatchObject({ codec: 'he-aac', channels: 2 });
  });

  it('spots implicit SBR: an LC config at half the rate the track runs at', async () => {
    const entry = audioEntry('mp4a', { channels: 1, rate: 44100 }, esds({ objectType: 0x40, asc: ascLc(AAC_RATE_INDEX[22050], 1) }));
    expect(await codecFor(entry)).toMatchObject({ codec: 'he-aac', sampleRateHz: 44100, channels: 1 });
  });

  it('does not call LC at 22050 Hz HE-AAC when the track runs at 22050 Hz', async () => {
    const entry = audioEntry('mp4a', { channels: 1, rate: 22050 }, esds({ objectType: 0x40, asc: ascLc(AAC_RATE_INDEX[22050], 1) }));
    expect(await codecFor(entry)).toMatchObject({ codec: 'aac', sampleRateHz: 22050 });
  });

  it('keeps AAC when the config is missing', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 44100 }, esds({ objectType: 0x40 }));
    expect(await codecFor(entry)).toMatchObject({ codec: 'aac', sampleRateHz: 44100 });
  });
});

describe('channel count of AAC', () => {
  // ISO 14496-14 says the channel count in the sample entry is a placeholder (2). The AudioSpecificConfig has the real one.
  const channelsFor = async (asc: Uint8Array, entryChannels = 2) => {
    const entry = audioEntry('mp4a', { channels: entryChannels, rate: 48000 }, esds({ objectType: 0x40, asc }));
    return (await probeBytes('c.m4a', movieFile({ tracks: [audioTrackWith(entry)] }))).audio?.channels;
  };

  it('takes the channel count from the config, not from the sample entry', async () => {
    expect(await channelsFor(ascLc(3, 1))).toBe(1);
    expect(await channelsFor(ascLc(3, 2))).toBe(2);
    expect(await channelsFor(ascLc(3, 6))).toBe(6); // configuration 6 is 5.1
    expect(await channelsFor(ascLc(3, 7))).toBe(8); // configuration 7 is 7.1
  });

  it('falls back to the sample entry when the config says the layout is described elsewhere', async () => {
    expect(await channelsFor(ascLc(3, 0), 6)).toBe(6);
  });

  it('reads a mono AAC-LC file the way Apple wrote it (config bytes 13 88, with a placeholder 2 in the entry)', async () => {
    const entry = audioEntry('mp4a', { channels: 2, rate: 22050 }, esds({ objectType: 0x40, asc: Uint8Array.from([0x13, 0x88]), avgBitrate: 32638 }));
    const info = await probeBytes('apple.m4a', movieFile({ tracks: [audioTrackWith(entry, { timescale: 22050 })] }));
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 22050, channels: 1 });
  });

  it('reads the HE-AAC configs Apple wrote: a mono core at half the rate, with the output rate behind the sync extension', async () => {
    const v1 = audioEntry('mp4a', { channels: 2, rate: 11025 }, esds({ objectType: 0x40, asc: Uint8Array.from([0x15, 0x08, 0x56, 0xe5, 0xb8]) }));
    expect((await probeBytes('he.m4a', movieFile({ tracks: [audioTrackWith(v1, { timescale: 11025 })] }))).audio).toMatchObject({ codec: 'he-aac', sampleRateHz: 22050, channels: 1 });
    // Apple's HE-AAC v2 config has the SBR extension but no parametric stereo flag (that is signalled inside the audio
    // data), so from the header alone it reads as mono HE-AAC. Explicit PS signalling is covered with the synthetic files above.
    const v2 = audioEntry('mp4a', { channels: 2, rate: 16000 }, esds({ objectType: 0x40, asc: Uint8Array.from([0x14, 0x08, 0x56, 0xe5, 0xa8]) }));
    expect((await probeBytes('he2.m4a', movieFile({ tracks: [audioTrackWith(v2, { timescale: 16000 })] }))).audio).toMatchObject({ codec: 'he-aac', sampleRateHz: 32000, channels: 1 });
  });
});

describe('gapless length (iTunSMPB)', () => {
  // Apple's AAC encoders write the movie length with the encoder's 2112 priming samples and some padding
  // included, and note the real length in an iTunSMPB item. 140630 valid samples at 22050 Hz is 6.378 s, which is
  // also what Apple's own afinfo tool reports for such a file.
  const withNote = (text: string, o: { timescale?: number; samples?: number; movieDuration?: number; video?: boolean } = {}) => {
    const timescale = o.timescale ?? 22050;
    const samples = o.samples ?? 140; // 140 x 1024 = 143360 ticks
    const entry = audioEntry('mp4a', { channels: 2, rate: timescale }, esds({ objectType: 0x40, asc: Uint8Array.from([0x13, 0x88]) }));
    const tracks = [audioTrackWith(entry, { timescale, samples })];
    if (o.video) tracks.push(videoTrackWith(h264Entry()));
    return movieFile({
      tracks,
      movieTimescale: timescale,
      movieDuration: o.movieDuration ?? samples * 1024,
      moovExtras: [box('udta', ilstMeta(freeformItem('iTunSMPB', text)))],
    });
  };
  const APPLE_NOTE = ' 00000000 00000840 0000026A 0000000000022556 00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000';

  it('uses the valid sample count instead of the length with priming and padding', async () => {
    const info = await probeBytes('gapless.m4a', withNote(APPLE_NOTE));
    expect(info.durationMs).toBe(6378);
  });

  it('is built by the fixture the same way Apple writes it', () => {
    expect(APPLE_NOTE.startsWith(smpbText({ priming: 2112, padding: 618, valid: 140630 }))).toBe(true);
  });

  it('counts in the track timescale, so HE-AAC at the core rate is right too', async () => {
    // Apple's HE-AAC file: timescale 11025, 73728 ticks in all, 70315 of them audio.
    const note = smpbText({ priming: 2112, padding: 1301, valid: 70315 });
    const info = await probeBytes('he.m4a', withNote(note, { timescale: 11025, samples: 72 }));
    expect(info.durationMs).toBe(6378);
  });

  it('gives the same length for a file whose header is already trimmed (Apple Lossless)', async () => {
    const note = smpbText({ priming: 0, padding: 2730, valid: 140630 });
    const info = await probeBytes('trimmed.m4a', withNote(note, { samples: 137, movieDuration: 140630 }));
    expect(info.durationMs).toBe(6378); // the movie length and the note agree
  });

  it('ignores a note that does not fit the track', async () => {
    const lengthWithPriming = Math.round((140 * 1024 * 1000) / 22050);
    expect((await probeBytes('a.m4a', withNote(smpbText({ priming: 2112, padding: 618, valid: 99_000_000 })))).durationMs).toBe(lengthWithPriming);
    expect((await probeBytes('b.m4a', withNote(smpbText({ priming: 0, padding: 0, valid: 1000 })))).durationMs).toBe(lengthWithPriming);
    expect((await probeBytes('c.m4a', withNote(' not a note at all'))).durationMs).toBe(lengthWithPriming);
    expect((await probeBytes('d.m4a', withNote(smpbText({ priming: 0, padding: 0, valid: 0 })))).durationMs).toBe(lengthWithPriming);
  });

  it('does not change the length of a file with video', async () => {
    const info = await probeBytes('video.m4v', withNote(APPLE_NOTE, { video: true }));
    expect(info.durationMs).toBe(Math.round((140 * 1024 * 1000) / 22050));
  });

  it('leaves the length from the movie header when there is no note', async () => {
    const info = await probeBytes('plain.m4a', movieFile({ tracks: [audioTrackWith(audioEntry('mp4a', { channels: 2, rate: 22050 }, esds({ objectType: 0x40, asc: Uint8Array.from([0x13, 0x88]) })), { timescale: 22050, samples: 140 })], movieTimescale: 22050, movieDuration: 143360 }));
    expect(info.durationMs).toBe(6502);
  });

  it('ignores other free-form items', async () => {
    const info = await probeBytes('other.m4a', movieFile({ tracks: [audioTrackWith(lcEntry())], moovExtras: [box('udta', ilstMeta(freeformItem('iTunNORM', ' 00000000 00000000 00000000'), textItem(`${COPY}nam`, 'Kept')))] }));
    expect(info.tags.title).toBe('Kept');
    expect(info.durationMs).toBe(40000);
  });
});

describe('other audio codecs', () => {
  const streamOf = async (entry: Uint8Array, timescale = 44100) => (await probeBytes('x.m4a', movieFile({ tracks: [audioTrackWith(entry, { timescale })] }))).audio;

  it('reads Apple Lossless with its bit depth, channels and exact rate from the magic cookie', async () => {
    const entry = audioEntry('alac', { channels: 2, rate: 96000, sampleSize: 24 }, alacCookie({ bitDepth: 24, channels: 2, sampleRate: 96000, avgBitrate: 1500000 }));
    // 1875 x 1024 ticks at 96000 Hz is 20 seconds, and 1875 x 640 bytes over 20 s is 480 kbps.
    expect(await streamOf(entry, 96000)).toEqual({ codec: 'alac', sampleRateHz: 96000, channels: 2, bitrateKbps: 480, bitDepth: 24 });
  });

  it('reads the ALAC bitrate from the cookie when sample sizes are missing', async () => {
    const entry = audioEntry('alac', { channels: 2, rate: 44100 }, alacCookie({ bitDepth: 16, channels: 2, sampleRate: 44100, avgBitrate: 900000 }));
    const info = await probeBytes('a.m4a', movieFile({ tracks: [audioTrackWith(entry, { timescale: 44100, sampleBytes: 0, samples: 0 })] }));
    expect(info.audio).toMatchObject({ codec: 'alac', bitrateKbps: 900, bitDepth: 16 });
  });

  it('names AC-3, E-AC-3, Opus and FLAC sample entries', async () => {
    expect((await streamOf(audioEntry('ac-3', { channels: 6, rate: 48000 }), 48000))?.codec).toBe('ac3');
    expect((await streamOf(audioEntry('ec-3', { channels: 6, rate: 48000 }), 48000))?.codec).toBe('eac3');
    expect((await streamOf(audioEntry('Opus', { channels: 2, rate: 48000 }), 48000))?.codec).toBe('opus');
    expect((await streamOf(audioEntry('fLaC', { channels: 2, rate: 44100 })))?.codec).toBe('flac');
  });

  it('reads PCM sample entries and their bit depths', async () => {
    expect(await streamOf(audioEntry('sowt', { channels: 2, rate: 44100, sampleSize: 16 }))).toMatchObject({ codec: 'pcm', bitDepth: 16 });
    expect(await streamOf(audioEntry('in24', { channels: 2, rate: 44100, sampleSize: 24 }))).toMatchObject({ codec: 'pcm', bitDepth: 24 });
    expect(await streamOf(audioEntry('fl32', { channels: 2, rate: 44100, sampleSize: 32 }))).toMatchObject({ codec: 'pcm', bitDepth: 32 });
  });

  it('reads a QuickTime version 2 sound description with a floating point rate', async () => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, 96000);
    const entry = box('lpcm', zeros(6), be16(1), be16(2), be16(0), be32(0), be16(3), be16(16), be16(0xfffe), be16(0), be32(65536), be32(72), new Uint8Array(view.buffer), be32(2), be32(0x7f000000), be32(24), be32(12), be32(6), be32(1));
    expect(await streamOf(entry, 96000)).toMatchObject({ codec: 'pcm', sampleRateHz: 96000, channels: 2, bitDepth: 24 });
  });

  it('finds the codec boxes of a QuickTime version 1 description inside its wave box', async () => {
    const entry = box(
      'mp4a',
      zeros(6),
      be16(1),
      be16(1),
      be16(0),
      be32(0),
      be16(2),
      be16(16),
      be16(0xffff),
      be16(0),
      be32(48000 * 65536),
      be32(1024),
      be32(0),
      be32(0),
      be32(2),
      box('wave', box('frma', 'mp4a'), esds({ objectType: 0x40, asc: ascLc(3, 2) }), box('\0\0\0\0')),
    );
    expect(await streamOf(entry, 48000)).toMatchObject({ codec: 'aac', sampleRateHz: 48000, channels: 2 });
  });
});

describe('video', () => {
  const movie = (video: Uint8Array, audio: Uint8Array = lcEntry(), extra: Partial<Parameters<typeof movieFile>[0]> = {}) =>
    movieFile({ brand: 'M4V ', tracks: [videoTrackWith(video, { width: 640, height: 480 }), audioTrackWith(audio)], movieDuration: 25000, ...extra });

  it('gives both streams of an H.264 file with its profile, level, size, frame rate and bitrates', async () => {
    const info = await probeBytes('film.m4v', movie(h264Entry(66, 0xc0, 30)));
    expect(info.container).toBe('m4v');
    expect(info.durationMs).toBe(25000);
    // 750 samples of 4000 bytes over 25 seconds is 960 kbps.
    expect(info.video).toEqual({ codec: 'h264', profile: 'Baseline', level: '3.0', width: 640, height: 480, fps: 30, bitrateKbps: 960 });
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 48000, channels: 2 });
  });

  it('names the H.264 profiles and levels', async () => {
    const profile = async (idc: number, compat: number, level: number) => (await probeBytes('v.mp4', movie(h264Entry(idc, compat, level)))).video;
    expect(await profile(77, 0, 31)).toMatchObject({ profile: 'Main', level: '3.1' });
    expect(await profile(100, 0, 40)).toMatchObject({ profile: 'High', level: '4.0' });
    expect(await profile(110, 0, 51)).toMatchObject({ profile: 'High 10', level: '5.1' });
    expect(await profile(88, 0, 13)).toMatchObject({ profile: 'Extended', level: '1.3' });
    expect(await profile(66, 0, 21)).toMatchObject({ level: '2.1' });
    // Level 1b is written as level_idc 9, or as 11 with constraint_set3 on the low profiles.
    expect(await profile(100, 0, 9)).toMatchObject({ level: '1b' });
    expect(await profile(66, 0x10, 11)).toMatchObject({ level: '1b' });
    expect(await profile(66, 0, 11)).toMatchObject({ level: '1.1' });
  });

  it('calculates a fractional frame rate', async () => {
    const file = movieFile({ brand: 'M4V ', tracks: [videoTrackWith(h264Entry(), { timescale: 30000, duration: 3_000_000, samples: 2997 })], movieDuration: 100000 });
    expect((await probeBytes('ntsc.m4v', file)).video?.fps).toBe(29.97);
  });

  it('takes the size from the track header when the sample entry has none', async () => {
    const entry = visualEntry('avc1', { width: 0, height: 0 }, avcC(100, 0, 40));
    const file = movieFile({ brand: 'M4V ', tracks: [videoTrackWith(entry, { width: 1280, height: 720 })], movieDuration: 25000 });
    expect((await probeBytes('hd.m4v', file)).video).toMatchObject({ width: 1280, height: 720 });
  });

  it('reads the bitrate from btrt when there is no sample table', async () => {
    const entry = visualEntry('avc1', { width: 320, height: 240 }, avcC(66, 0, 13), btrt(500000));
    const file = movieFile({ brand: 'M4V ', tracks: [videoTrackWith(entry, { sampleBytes: 0, samples: 0 })], movieDuration: 25000 });
    expect((await probeBytes('b.m4v', file)).video?.bitrateKbps).toBe(500);
  });

  it('reads HEVC, MPEG-4 part 2 and the newer codecs', async () => {
    const codecOf = async (entry: Uint8Array) => (await probeBytes('v.mp4', movie(entry))).video;
    expect(await codecOf(visualEntry('hvc1', { width: 1920, height: 1080 }, hvcC(1, 120)))).toMatchObject({ codec: 'hevc', profile: 'Main', level: '4.0', width: 1920, height: 1080 });
    expect(await codecOf(visualEntry('hev1', { width: 1920, height: 1080 }, hvcC(2, 153)))).toMatchObject({ codec: 'hevc', profile: 'Main 10', level: '5.1' });
    expect(await codecOf(visualEntry('mp4v', { width: 320, height: 240 }, esds({ objectType: 0x20 })))).toMatchObject({ codec: 'mpeg4', width: 320 });
    expect(await codecOf(visualEntry('avc3', { width: 640, height: 360 }, avcC(77, 0, 30)))).toMatchObject({ codec: 'h264', profile: 'Main' });
    expect((await codecOf(visualEntry('vp09', { width: 640, height: 360 })))?.codec).toBe('vp9');
    expect((await codecOf(visualEntry('av01', { width: 640, height: 360 })))?.codec).toBe('av1');
  });

  it('does not count a still picture stored as a video track', async () => {
    const picture = visualEntry('jpeg', { width: 600, height: 600 });
    const file = movieFile({ tracks: [audioTrackWith(lcEntry()), videoTrackWith(picture, { samples: 1 })] });
    const info = await probeBytes('cover-track.m4a', file);
    expect(info.video).toBeNull();
    expect(info.container).toBe('m4a');
  });

  it('does not count a one-frame H.264 track (cover art stored as a track), so a podcast stays an audio podcast', async () => {
    const still = videoTrackWith(h264Entry(100, 0, 40, 600, 600), { samples: 1, duration: 600 });
    const file = movieFile({ brand: 'M4A ', tracks: [audioTrackWith(lcEntry()), still], moovExtras: [box('udta', ilstMeta(intItem('stik', 21)))] });
    const info = await probeBytes('podcast-with-art.m4a', file);
    expect(info.video).toBeNull();
    expect(info.tags.declaredKind).toBe('podcast');
  });

  it('prefers an enabled video track', async () => {
    const off = videoTrackWith(h264Entry(66, 0, 13, 160, 120), { id: 2, enabled: false });
    const on = videoTrackWith(h264Entry(100, 0, 40, 1280, 720), { id: 3 });
    const info = await probeBytes('two.m4v', movieFile({ brand: 'M4V ', tracks: [off, on, audioTrackWith(lcEntry())] }));
    expect(info.video).toMatchObject({ width: 1280, height: 720 });
  });
});

describe('containers named by the file type box', () => {
  const containerFor = async (brand: string | null, compatible?: string[]) => (await probeBytes('f', movieFile({ brand, compatible, tracks: [audioTrackWith(lcEntry())] }))).container;
  it('maps the brands', async () => {
    expect(await containerFor('M4A ')).toBe('m4a');
    expect(await containerFor('M4B ')).toBe('m4b');
    expect(await containerFor('M4V ')).toBe('m4v');
    expect(await containerFor('qt  ')).toBe('mov');
    expect(await containerFor('isom', ['isom', 'mp42'])).toBe('mp4');
    expect(await containerFor('mp42', ['mp41', 'mp42'])).toBe('mp4');
    expect(await containerFor('isom', ['isom', 'M4B '])).toBe('m4b');
    expect(await containerFor('mp42', ['mp42', 'M4A '])).toBe('m4a');
  });

  it('reads an old QuickTime file that has no ftyp box as mov', async () => {
    expect(await containerFor(null)).toBe('mov');
  });

  it('does not take the M4B brand as a claim to be an audiobook', async () => {
    const info = await probeBytes('book.m4b', movieFile({ brand: 'M4B ', tracks: [audioTrackWith(lcEntry())] }));
    expect(info.container).toBe('m4b');
    expect(info.tags.declaredKind).toBeUndefined();
  });
});

describe('what the file declares about itself (stik, pcst and genre)', () => {
  const kindOf = async (...items: Uint8Array[]) => (await probeBytes('f.m4a', withItems(...items))).tags.declaredKind;

  it('maps the media kinds of the stik atom', async () => {
    expect(await kindOf(intItem('stik', 1))).toBe('music');
    expect(await kindOf(intItem('stik', 2))).toBe('audiobook');
    expect(await kindOf(intItem('stik', 6))).toBe('music-video');
    expect(await kindOf(intItem('stik', 9))).toBe('movie');
    expect(await kindOf(intItem('stik', 10))).toBe('tv-show');
    expect(await kindOf(intItem('stik', 21))).toBe('podcast');
  });

  it('leaves other stik values alone', async () => {
    for (const value of [0, 3, 4, 5, 8, 11, 14, 23]) expect(await kindOf(intItem('stik', value))).toBeUndefined();
  });

  it('calls a podcast flag with no stik a podcast', async () => {
    expect(await kindOf(intItem('pcst', 1))).toBe('podcast');
    expect(await kindOf(intItem('pcst', 0))).toBeUndefined();
  });

  it('lets stik win over the podcast flag, whichever comes first', async () => {
    expect(await kindOf(intItem('stik', 2), intItem('pcst', 1))).toBe('audiobook');
    expect(await kindOf(intItem('pcst', 1), intItem('stik', 2))).toBe('audiobook');
  });

  it('turns a podcast with a video stream into a video podcast', async () => {
    const withVideo = (...items: Uint8Array[]) =>
      movieFile({ brand: 'M4V ', tracks: [videoTrackWith(h264Entry()), audioTrackWith(lcEntry())], moovExtras: [box('udta', ilstMeta(...items))] });
    expect((await probeBytes('v.m4v', withVideo(intItem('stik', 21)))).tags.declaredKind).toBe('video-podcast');
    expect((await probeBytes('v.m4v', withVideo(intItem('pcst', 1)))).tags.declaredKind).toBe('video-podcast');
    expect((await probeBytes('v.m4v', withVideo(textItem(`${COPY}gen`, 'Podcast')))).tags.declaredKind).toBe('video-podcast');
    // Other kinds keep their meaning with a video stream.
    expect((await probeBytes('v.m4v', withVideo(intItem('stik', 9)))).tags.declaredKind).toBe('movie');
    expect((await probeBytes('v.m4v', withVideo(intItem('stik', 6)))).tags.declaredKind).toBe('music-video');
    expect((await probeBytes('v.m4v', withVideo(intItem('stik', 10)))).tags.declaredKind).toBe('tv-show');
  });

  it('uses an Audiobook or Podcast genre when nothing else says', async () => {
    expect(await kindOf(textItem(`${COPY}gen`, 'Audiobook'))).toBe('audiobook');
    expect(await kindOf(textItem(`${COPY}gen`, 'Podcast'))).toBe('podcast');
    expect(await kindOf(textItem(`${COPY}gen`, 'Rock'))).toBeUndefined();
    expect(await kindOf(gnreItem(184))).toBe('audiobook'); // the number is the ID3 index plus one
    expect(await kindOf(gnreItem(187))).toBe('podcast');
  });
});

describe('iTunes metadata atoms', () => {
  const jpeg = fakeJpeg(100, 3);
  const everything = [
    textItem(`${COPY}nam`, 'The Title'),
    textItem(`${COPY}ART`, 'The Artist'),
    textItem('aART', 'The Album Artist'),
    textItem(`${COPY}alb`, 'The Album'),
    textItem(`${COPY}gen`, 'Jazz'),
    textItem(`${COPY}day`, '2019-03-04T08:00:00Z'),
    textItem(`${COPY}wrt`, 'The Composer'),
    textItem(`${COPY}cmt`, 'A comment'),
    textItem(`${COPY}grp`, 'A grouping'),
    textItem('desc', 'Short description'),
    textItem('ldes', 'The long description of it'),
    trknItem(3, 12),
    diskItem(1, 2),
    intItem('tmpo', 128, 2),
    intItem('cpil', 1),
    textItem(`${COPY}lyr`, 'Some lyrics'),
    textItem('catg', 'Technology'),
    box('purl', data(0, utf8('https://example.test/feed.xml'))),
    textItem('egid', 'ep-5-guid'),
    textItem('tvsh', 'The Show'),
    intItem('tvsn', 2, 4),
    intItem('tves', 5, 4),
    textItem('tven', 'S02E05'),
    textItem('tvnn', 'The Network'),
    covrItem({ bytes: jpeg, flags: 13 }),
  ];

  it('maps every item to its field', async () => {
    const info = await probeBytes('tagged.m4a', withItems(...everything));
    expect(info.tags).toEqual({
      title: 'The Title',
      artist: 'The Artist',
      albumArtist: 'The Album Artist',
      album: 'The Album',
      genre: 'Jazz',
      year: 2019,
      composer: 'The Composer',
      comment: 'A comment',
      grouping: 'A grouping',
      description: 'Short description',
      lyrics: 'Some lyrics',
      trackNumber: 3,
      trackTotal: 12,
      discNumber: 1,
      discTotal: 2,
      bpm: 128,
      compilation: true,
      podcastCategory: 'Technology',
      podcastFeedUrl: 'https://example.test/feed.xml',
      podcastEpisodeUrl: 'ep-5-guid',
      show: 'The Show',
      season: 2,
      episode: 5,
      episodeId: 'S02E05',
      network: 'The Network',
    });
    expect(info.artwork?.mime).toBe('image/jpeg');
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(jpeg));
    expect(info.warnings).toEqual([]);
  });

  it('reads UTF-8 text and a track without a total', async () => {
    const info = await probeBytes('u.m4a', withItems(textItem(`${COPY}nam`, 'Café 日本語'), trknItem(7, 0)));
    expect(info.tags.title).toBe('Café 日本語');
    expect(info.tags.trackNumber).toBe(7);
    expect(info.tags.trackTotal).toBeUndefined();
  });

  it('turns the numeric genre atom into a name', async () => {
    expect((await probeBytes('g.m4a', withItems(gnreItem(18)))).tags.genre).toBe('Rock'); // value 18 is index 17
    expect((await probeBytes('g.m4a', withItems(gnreItem(1)))).tags.genre).toBe('Blues');
  });

  it('uses the short description, and the long one only when there is no short one', async () => {
    expect((await probeBytes('d.m4a', withItems(textItem('ldes', 'Long'), textItem('desc', 'Short')))).tags.description).toBe('Short');
    expect((await probeBytes('d.m4a', withItems(textItem('ldes', 'Only long')))).tags.description).toBe('Only long');
  });

  it('reads PNG cover art, and the first picture when there are several', async () => {
    const png = fakePng(80, 2);
    const only = await probeBytes('c.m4a', withItems(covrItem({ bytes: png, flags: 14 })));
    expect(only.artwork?.mime).toBe('image/png');
    expect(Array.from(only.artwork?.data ?? [])).toEqual(Array.from(png));
    const two = await probeBytes('c.m4a', withItems(covrItem({ bytes: jpeg, flags: 13 }, { bytes: png, flags: 14 })));
    expect(two.artwork?.mime).toBe('image/jpeg');
  });

  it('trusts the picture bytes over the type flag', async () => {
    const info = await probeBytes('c.m4a', withItems(covrItem({ bytes: jpeg, flags: 14 })));
    expect(info.artwork?.mime).toBe('image/jpeg');
  });

  it('copies cover art out of the file', async () => {
    const file = withItems(covrItem({ bytes: jpeg, flags: 13 }));
    const info = await probeBytes('c.m4a', file);
    file.fill(0);
    expect(info.artwork?.data[0]).toBe(0xff);
  });

  it('skips a cover that is not a picture', async () => {
    const info = await probeBytes('c.m4a', withItems(covrItem({ bytes: utf8('not an image'), flags: 13 })));
    expect(info.artwork).toBeNull();
    expect(info.warnings.join(' ')).toContain('not recognised');
  });

  it('reads the tags of a file whose meta box has no version and flags (QuickTime style)', async () => {
    const file = movieFile({ tracks: [audioTrackWith(lcEntry())], moovExtras: [box('udta', ilstMetaQuickTime(textItem(`${COPY}nam`, 'QT meta')))] });
    expect((await probeBytes('qt.m4a', file)).tags.title).toBe('QT meta');
  });

  it('reads a meta box placed straight in moov', async () => {
    const file = movieFile({ tracks: [audioTrackWith(lcEntry())], moovExtras: [ilstMeta(textItem(`${COPY}nam`, 'Direct'))] });
    expect((await probeBytes('d.m4a', file)).tags.title).toBe('Direct');
  });

  it('reads the older QuickTime text atoms in udta and lets ilst win', async () => {
    const atom = (name: string, text: string) => box(name, be16(text.length), be16(0x15c7), utf8(text));
    const file = movieFile({
      tracks: [audioTrackWith(lcEntry())],
      moovExtras: [box('udta', atom(`${COPY}nam`, 'Old title'), atom(`${COPY}ART`, 'Old artist'), atom(`${COPY}alb`, 'Old album'), ilstMeta(textItem(`${COPY}nam`, 'New title')))],
    });
    const info = await probeBytes('qt.mov', file);
    expect(info.tags).toMatchObject({ title: 'New title', artist: 'Old artist', album: 'Old album' });
  });

  it('skips items that are too large to read, with a warning, and keeps the rest', async () => {
    const huge = box(`${COPY}cmt`, data(1, zeros(1024 * 1024 + 10)));
    const info = await probeBytes('h.m4a', withItems(textItem(`${COPY}nam`, 'Kept'), huge));
    expect(info.tags.title).toBe('Kept');
    expect(info.tags.comment).toBeUndefined();
    expect(info.warnings.join(' ')).toContain('too large');
  });
});

describe('MP4 chapters', () => {
  const titles = [
    { title: 'Prologue', ticks: 10000 },
    { title: 'Part 1', ticks: 20000 },
    { title: 'Part 2', ticks: 15000 },
  ];
  const withChapterTrack = (o: { titles?: typeof titles; onePerChunk?: boolean; co64?: boolean; entryType?: string; extra?: Uint8Array[] }) => {
    const list = o.titles ?? titles;
    const payload = chapterTrack({ id: 2, timescale: 1000, titles: list, dataOffset: 0 }).data;
    return movieFile({
      brand: 'M4B ',
      mdatPayload: cat(payload, zeros(64)),
      tracks: (offset) => [audioTrackWith(lcEntry(), { chapters: 2 }), chapterTrack({ id: 2, timescale: 1000, titles: list, dataOffset: offset, onePerChunk: o.onePerChunk, co64: o.co64, entryType: o.entryType }).trak],
      moovExtras: o.extra,
    });
  };
  const expected = [
    { startMs: 0, title: 'Prologue' },
    { startMs: 10000, title: 'Part 1' },
    { startMs: 30000, title: 'Part 2' },
  ];

  it('reads a QuickTime chapter text track, with all samples in one chunk', async () => {
    const info = await probeBytes('book.m4b', withChapterTrack({}));
    expect(info.chapters).toEqual(expected);
    expect(info.container).toBe('m4b');
  });

  it('reads it with one sample per chunk and with 64 bit chunk offsets', async () => {
    expect((await probeBytes('b.m4b', withChapterTrack({ onePerChunk: true }))).chapters).toEqual(expected);
    expect((await probeBytes('b.m4b', withChapterTrack({ co64: true }))).chapters).toEqual(expected);
  });

  it('reads chapter titles written as UTF-16 and 3GPP timed text entries', async () => {
    const utf16 = [
      { title: 'Café 日本', ticks: 5000, utf16: true },
      { title: 'Second', ticks: 5000, utf16: true },
    ];
    const info = await probeBytes('b.m4b', withChapterTrack({ titles: utf16 }));
    expect(info.chapters).toEqual([
      { startMs: 0, title: 'Café 日本' },
      { startMs: 5000, title: 'Second' },
    ]);
    expect((await probeBytes('b.m4b', withChapterTrack({ entryType: 'tx3g' }))).chapters).toEqual(expected);
  });

  it('reads Nero chapters from the chpl atom', async () => {
    const file = movieFile({
      brand: 'M4B ',
      tracks: [audioTrackWith(lcEntry())],
      moovExtras: [box('udta', chpl([{ startMs: 0, title: 'Intro' }, { startMs: 60000, title: 'Chapter One' }, { startMs: 125500, title: 'Two' }]))],
    });
    expect((await probeBytes('n.m4b', file)).chapters).toEqual([
      { startMs: 0, title: 'Intro' },
      { startMs: 60000, title: 'Chapter One' },
      { startMs: 125500, title: 'Two' },
    ]);
  });

  it('reads a chpl atom that has no reserved bytes', async () => {
    const file = movieFile({ tracks: [audioTrackWith(lcEntry())], moovExtras: [box('udta', chpl([{ startMs: 0, title: 'A' }, { startMs: 1000, title: 'B' }], false))] });
    expect((await probeBytes('n.m4b', file)).chapters).toEqual([
      { startMs: 0, title: 'A' },
      { startMs: 1000, title: 'B' },
    ]);
  });

  it('uses the chapter track, and says so, when it and the Nero list disagree', async () => {
    const info = await probeBytes('b.m4b', withChapterTrack({ extra: [box('udta', chpl([{ startMs: 0, title: 'Only one' }]))] }));
    expect(info.chapters).toEqual(expected);
    expect(info.warnings.join(' ')).toContain('chapter track');
  });

  it('says nothing when the chapter track and the Nero list agree', async () => {
    const same = chpl(expected);
    const info = await probeBytes('b.m4b', withChapterTrack({ extra: [box('udta', same)] }));
    expect(info.chapters).toEqual(expected);
    expect(info.warnings).toEqual([]);
  });

  it('ignores a chapter reference to a track that does not exist', async () => {
    const file = movieFile({ tracks: [audioTrackWith(lcEntry(), { chapters: 9 })] });
    const info = await probeBytes('b.m4b', file);
    expect(info.chapters).toEqual([]);
    expect(info.audio?.codec).toBe('aac');
  });
});

describe('box layout', () => {
  const baseline = async () => {
    const info = await probeBytes('a.m4a', simpleAudioFile({ items: [textItem(`${COPY}nam`, 'Same')] }));
    return { container: info.container, durationMs: info.durationMs, audio: info.audio, tags: info.tags };
  };

  const same = async (file: Uint8Array) => {
    const info = await probeBytes('a.m4a', file);
    expect({ container: info.container, durationMs: info.durationMs, audio: info.audio, tags: info.tags }).toEqual(await baseline());
    expect(info.warnings).toEqual([]);
  };
  const items = [textItem(`${COPY}nam`, 'Same')];

  it('reads moov after mdat, moov before mdat, and 64 bit mdat sizes', async () => {
    await same(simpleAudioFile({ items, moovFirst: false }));
    await same(simpleAudioFile({ items, moovFirst: true }));
    await same(simpleAudioFile({ items, moovFirst: false, mdat64: true }));
    await same(simpleAudioFile({ items, moovFirst: true, mdat64: true }));
  });

  it('reads past free, skip, wide and uuid boxes', async () => {
    const filler = cat(box('free', zeros(100)), box('skip', zeros(7)), box('wide'), box('uuid', zeros(16), zeros(40)));
    const file = assemble({
      ftyp: ftyp('M4A ', ['M4A ', 'mp42', 'isom']),
      filler,
      mdatPayload: zeros(256),
      moov: () => box('moov', mvhd({ timescale: 1000, duration: 40000 }), aacTrack({ rate: 48000, asc: ascLc(3, 2), samples: 1875, sampleBytes: 640 }), box('udta', ilstMeta(...items))),
    });
    await same(file);
  });

  it('reads a file whose mdat size is 0, meaning "to the end of the file"', async () => {
    const file = movieFile({
      tracks: [aacTrack({ rate: 48000, asc: ascLc(3, 2), samples: 1875, sampleBytes: 640 })],
      moovExtras: [box('udta', ilstMeta(...items))],
      moovFirst: true,
      mdatToEnd: true,
    });
    await same(file);
  });

  it('reads version 1 (64 bit) movie, track and media headers', async () => {
    const file = movieFile({ mvhdVersion: 1, tracks: [audioTrackWith(lcEntry(), { version: 1 })], moovExtras: [box('udta', ilstMeta(...items))] });
    await same(file);
  });

  it('takes the length from the fragment header when the movie header has none', async () => {
    const info = await probeBytes('frag.m4a', movieFile({ movieDuration: 0, tracks: [audioTrackWith(lcEntry(), { samples: 0, sampleBytes: 0 })], moovExtras: [box('mvex', fullBox('mehd', 0, 0, be32(30000)))] }));
    expect(info.durationMs).toBe(30000);
  });

  it('falls back to the longest track when the movie header has no length', async () => {
    const info = await probeBytes('nolen.m4a', movieFile({ movieDuration: 0, tracks: [audioTrackWith(lcEntry())] }));
    expect(info.durationMs).toBe(40000);
  });

  it('uses the movie header length, not the track length, when they differ', async () => {
    const info = await probeBytes('differ.m4a', movieFile({ movieDuration: 39000, tracks: [audioTrackWith(lcEntry())] }));
    expect(info.durationMs).toBe(39000);
  });

  it('reads a version 0 movie header duration of all ones as unknown', async () => {
    const info = await probeBytes('ones.m4a', movieFile({ movieDuration: 0xffffffff, tracks: [audioTrackWith(lcEntry())] }));
    expect(info.durationMs).toBe(40000);
  });
});

describe('protected files (FairPlay)', () => {
  it('flags a drms audio entry with the original format in sinf/frma, and still names the codec', async () => {
    const entry = audioEntry('drms', { channels: 2, rate: 44100 }, esds({ objectType: 0x40, asc: ascLc(4, 2) }), sinf('mp4a'));
    const info = await probeBytes('bought.m4p', movieFile({ brand: 'M4P ', tracks: [audioTrackWith(entry, { timescale: 44100 })] }));
    expect(info.protected).toBe(true);
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 44100 });
    expect(info.container).toBe('m4a');
  });

  it('flags a drms entry that has no sinf', async () => {
    const entry = audioEntry('drms', { channels: 2, rate: 44100 }, esds({ objectType: 0x40, asc: ascLc(4, 2) }));
    const info = await probeBytes('d.m4p', movieFile({ tracks: [audioTrackWith(entry, { timescale: 44100 })] }));
    expect(info.protected).toBe(true);
    expect(info.audio?.codec).toBe('aac');
  });

  it('flags a drms entry with nothing else to go on and leaves its codec unknown', async () => {
    const info = await probeBytes('d.m4p', movieFile({ tracks: [audioTrackWith(audioEntry('drms', { channels: 2, rate: 44100 }), { timescale: 44100 })] }));
    expect(info.protected).toBe(true);
    expect(info.audio?.codec).toBe('unknown');
  });

  it('flags an ordinary entry that carries sinf/frma', async () => {
    const entry = audioEntry('enca', { channels: 2, rate: 48000 }, esds({ objectType: 0x40, asc: ascLc(3, 2) }), sinf('mp4a'));
    expect((await probeBytes('e.mp4', movieFile({ tracks: [audioTrackWith(entry)] }))).protected).toBe(true);
  });

  it('flags protected video and still reads its codec from frma', async () => {
    const entry = visualEntry('drmi', { width: 640, height: 480 }, avcC(100, 0, 40), sinf('avc1'));
    const info = await probeBytes('m.m4v', movieFile({ brand: 'M4V ', tracks: [videoTrackWith(entry), audioTrackWith(lcEntry())] }));
    expect(info.protected).toBe(true);
    expect(info.video).toMatchObject({ codec: 'h264', profile: 'High' });
  });

  it('does not flag a normal file', async () => {
    expect((await probeBytes('n.m4a', simpleAudioFile({}))).protected).toBe(false);
    expect((await probeBytes('n.m4v', movieFile({ brand: 'M4V ', tracks: [videoTrackWith(h264Entry()), audioTrackWith(lcEntry())] }))).protected).toBe(false);
  });

  it('does not flag a purchased file only because it carries store atoms', async () => {
    const info = await probeBytes('plus.m4a', withItems(textItem('apID', 'someone@example.test'), textItem('cprt', 'x')));
    expect(info.protected).toBe(false);
  });
});

describe('damaged MP4 files', () => {
  it('reports a file with no moov box and reads nothing from it', async () => {
    const info = await probeBytes('nomoov.m4a', cat(ftyp('M4A '), box('mdat', zeros(1000))));
    expect(info.container).toBe('m4a');
    expect(info.audio).toBeNull();
    expect(info.durationMs).toBeNull();
    expect(info.warnings.join(' ')).toContain('moov');
  });

  it('reads what it can from a moov box that is cut off', async () => {
    const full = simpleAudioFile({ moovFirst: true, items: [textItem(`${COPY}nam`, 'Survives')] });
    // With the moov first the mdat (8 byte header and 256 bytes) is last. Remove it and 40 bytes of the metadata before it.
    const cut = full.subarray(0, full.length - 264 - 40);
    const info = await probeBytes('cut.m4a', cut);
    expect(info.container).toBe('m4a');
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 48000 });
    expect(info.durationMs).toBe(40000);
    expect(info.warnings.join(' ')).toContain('cut short');
  });

  it('survives a box whose size is smaller than its header', async () => {
    const bad = cat(ftyp('M4A '), be32(3), 'free', zeros(20));
    const info = await probeBytes('bad.m4a', bad);
    expect(info.container).toBe('m4a');
    expect(info.warnings.length).toBeGreaterThan(0);
  });

  it('reads a track list with a sample table box missing', async () => {
    const trackWithoutTables = box('trak', box('mdia', box('mdhd'), hdlr0('soun'), box('minf')));
    const info = await probeBytes('empty.m4a', movieFile({ tracks: [trackWithoutTables] }));
    expect(info.container).toBe('m4a');
    expect(info.audio).toBeNull();
  });

  it('keeps the track when the sample table is bigger than the file', async () => {
    const entry = lcEntry();
    const lying = trak({ id: 1, handler: 'soun', timescale: 48000, duration: 1920000, sampleCount: 5_000_000, sampleSizes: undefined, entry });
    const info = await probeBytes('lying.m4a', movieFile({ tracks: [lying] }));
    expect(info.audio?.codec).toBe('aac');
  });
});

function hdlr0(handler: string): Uint8Array {
  return fullBox('hdlr', 0, 0, be32(0), handler, be32(0), be32(0), be32(0), [0]);
}
