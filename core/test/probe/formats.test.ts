import { describe, expect, it } from 'vitest';
import { id3v2, textFrame } from './build-mp3';
import { ascLc, ascHeExplicit, AAC_RATE_INDEX } from './build-mp4';
import {
  aiffChunk,
  aiffComm,
  aiffFile,
  asfAudioStream,
  asfContentDescription,
  asfExtendedContent,
  asfFile,
  asfFileProperties,
  asfVideoStream,
  aviAudioFormat,
  aviFile,
  aviMainHeader,
  aviStreamHeader,
  aviVideoFormat,
  el,
  elStr,
  extended80,
  flacBlock,
  flacFile,
  flacStreamInfo,
  listInfo,
  mkvAudioTrack,
  mkvFile,
  mkvVideoTrack,
  oggFile,
  oggPage,
  opusHeadPacket,
  opusTagsPacket,
  pictureBody,
  riffChunk,
  simpleWav,
  ssnd,
  theoraBeginPage,
  vorbisCommentPacket,
  vorbisIdPacket,
  vorbisSetupPacket,
  wavFile,
  wavFmt,
  vorbisComment,
} from './build-misc';
import { be16, cat, fakeJpeg, fakePng, le32, le64, probeBytes, utf8, zeros } from './helpers';

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('FLAC', () => {
  it('reads STREAMINFO: rate, channels, bit depth, length and a bitrate from the audio size', async () => {
    // 441000 samples at 44100 Hz is 10 seconds. 1,250,000 bytes of audio over 10 s is 1000 kbps.
    const info = await probeBytes('a.flac', flacFile({ audioBytes: 1_250_000 }));
    expect(info.container).toBe('flac');
    expect(info.durationMs).toBe(10000);
    expect(info.audio).toEqual({ codec: 'flac', sampleRateHz: 44100, channels: 2, bitrateKbps: 1000, bitDepth: 16 });
    expect(info.warnings).toEqual([]);
  });

  it('reads high resolution and unusual streams', async () => {
    const hires = await probeBytes('h.flac', flacFile({ rate: 96000, bits: 24, samples: 96000 * 60 }));
    expect(hires.audio).toMatchObject({ sampleRateHz: 96000, bitDepth: 24, channels: 2 });
    expect(hires.durationMs).toBe(60000);
    const wide = await probeBytes('w.flac', flacFile({ rate: 192000, channels: 6, bits: 32, samples: 192000 }));
    expect(wide.audio).toMatchObject({ sampleRateHz: 192000, channels: 6, bitDepth: 32 });
    expect(wide.durationMs).toBe(1000);
    const mono = await probeBytes('m.flac', flacFile({ rate: 8000, channels: 1, bits: 8, samples: 4000 }));
    expect(mono.audio).toMatchObject({ sampleRateHz: 8000, channels: 1, bitDepth: 8 });
    expect(mono.durationMs).toBe(500);
  });

  it('keeps the length unknown, and says so, when the sample count is zero', async () => {
    const info = await probeBytes('n.flac', flacFile({ samples: 0 }));
    expect(info.durationMs).toBeNull();
    expect(info.audio?.sampleRateHz).toBe(44100);
    expect(info.warnings.join(' ')).toContain('length is unknown');
  });

  it('maps the Vorbis comments, ignoring the case of the keys', async () => {
    const info = await probeBytes(
      't.flac',
      flacFile({
        comments: [
          'TITLE=The Title',
          'artist=The Artist',
          'Album=The Album',
          'ALBUMARTIST=The Album Artist',
          'GENRE=Jazz',
          'DATE=2019-05-03',
          'TRACKNUMBER=3',
          'TRACKTOTAL=12',
          'DISCNUMBER=1/2',
          'COMPOSER=The Composer',
          'COMMENT=A comment',
          'DESCRIPTION=A description',
          'GROUPING=A grouping',
          'LYRICS=la la',
          'BPM=128',
          'COMPILATION=1',
        ],
      }),
    );
    expect(info.tags).toEqual({
      title: 'The Title',
      artist: 'The Artist',
      album: 'The Album',
      albumArtist: 'The Album Artist',
      genre: 'Jazz',
      year: 2019,
      trackNumber: 3,
      trackTotal: 12,
      discNumber: 1,
      discTotal: 2,
      composer: 'The Composer',
      comment: 'A comment',
      description: 'A description',
      grouping: 'A grouping',
      lyrics: 'la la',
      bpm: 128,
      compilation: true,
    });
  });

  it('reads the other common spellings and joins repeated keys', async () => {
    const info = await probeBytes(
      't.flac',
      flacFile({ comments: ['ARTIST=Alice', 'ARTIST=Bob', 'ALBUM ARTIST=Various', 'TRACKNUMBER=3/12', 'TOTALTRACKS=99', 'DISCNUMBER=2', 'TOTALDISCS=3', 'YEAR=1999', 'TEMPO=90'] }),
    );
    expect(info.tags).toMatchObject({ artist: 'Alice / Bob', albumArtist: 'Various', trackNumber: 3, trackTotal: 12, discNumber: 2, discTotal: 3, year: 1999, bpm: 90 });
  });

  it('reads Unicode text', async () => {
    const info = await probeBytes('u.flac', flacFile({ comments: ['TITLE=Café 日本語 \u{1f3b5}'] }));
    expect(info.tags.title).toBe('Café 日本語 \u{1f3b5}');
  });

  it('declares a podcast or audiobook only from the genre', async () => {
    expect((await probeBytes('a.flac', flacFile({ comments: ['GENRE=Audiobook'] }))).tags.declaredKind).toBe('audiobook');
    expect((await probeBytes('a.flac', flacFile({ comments: ['GENRE=Podcast'] }))).tags.declaredKind).toBe('podcast');
    expect((await probeBytes('a.flac', flacFile({ comments: ['GENRE=Rock'] }))).tags.declaredKind).toBeUndefined();
  });

  it('reads chapters written as CHAPTERnnn comments', async () => {
    const info = await probeBytes('c.flac', flacFile({ comments: ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro', 'CHAPTER002=00:01:30.500', 'CHAPTER002NAME=Second', 'CHAPTER003=01:00:00.000'] }));
    expect(info.chapters).toEqual([
      { startMs: 0, title: 'Intro' },
      { startMs: 90500, title: 'Second' },
      { startMs: 3600000, title: 'Chapter 3' },
    ]);
  });

  it('picks the front cover from the PICTURE blocks', async () => {
    const back = fakePng(90, 1);
    const front = fakeJpeg(120, 2);
    const info = await probeBytes('p.flac', flacFile({ pictures: [{ type: 4, mime: 'image/png', data: back }, { type: 3, mime: 'image/jpeg', data: front }] }));
    expect(info.artwork?.mime).toBe('image/jpeg');
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(front));
  });

  it('uses the picture bytes to name the type, and skips something that is not a picture', async () => {
    expect((await probeBytes('p.flac', flacFile({ pictures: [{ mime: 'image/png', data: fakeJpeg(50) }] }))).artwork?.mime).toBe('image/jpeg');
    const bad = await probeBytes('p.flac', flacFile({ pictures: [{ mime: 'image/jpeg', data: utf8('plain text, not a picture') }] }));
    expect(bad.artwork).toBeNull();
    expect(bad.warnings.join(' ')).toContain('not recognised');
  });

  it('skips an ID3v2 tag at the start and reads the stream after it', async () => {
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'From ID3'), textFrame(3, 'TPE1', 'ID3 artist')], padding: 500 });
    const info = await probeBytes('id3.flac', flacFile({ id3: tag, comments: ['TITLE=From Vorbis'] }));
    expect(info.container).toBe('flac');
    expect(info.audio?.sampleRateHz).toBe(44100);
    expect(info.durationMs).toBe(10000);
    expect(info.tags.title).toBe('From Vorbis'); // the Vorbis comment wins
    expect(info.tags.artist).toBe('ID3 artist'); // the ID3 tag fills a gap
  });

  it('reads past padding and application blocks', async () => {
    const info = await probeBytes('b.flac', flacFile({ extraBlocks: [flacBlock(1, zeros(4000)), flacBlock(2, cat('abcd', zeros(20)))], comments: ['TITLE=After padding'] }));
    expect(info.tags.title).toBe('After padding');
  });

  it('warns when STREAMINFO is missing', async () => {
    const info = await probeBytes('n.flac', flacFile({ omitStreamInfo: true, comments: ['TITLE=No info'] }));
    expect(info.container).toBe('flac');
    expect(info.audio).toBeNull();
    expect(info.tags.title).toBe('No info');
    expect(info.warnings.join(' ')).toContain('STREAMINFO');
  });

  it('reads STREAMINFO even when the file ends right after it', async () => {
    const info = await probeBytes('s.flac', cat('fLaC', flacBlock(0, flacStreamInfo({ rate: 44100, channels: 2, bits: 16, samples: 44100 }), false)));
    expect(info.durationMs).toBe(1000);
    expect(info.warnings.length).toBeGreaterThan(0);
  });
});

describe('WAV', () => {
  it('reads 16 bit PCM: rate, channels, depth, bitrate and the length from the data size', async () => {
    // 1,764,000 bytes at 176,400 bytes a second is 10 seconds.
    const info = await probeBytes('a.wav', simpleWav({ dataBytes: 1_764_000 }));
    expect(info.container).toBe('wav');
    expect(info.durationMs).toBe(10000);
    expect(info.audio).toEqual({ codec: 'pcm', sampleRateHz: 44100, channels: 2, bitrateKbps: 1411, bitDepth: 16 });
    expect(info.warnings).toEqual([]);
  });

  it('reads 24 bit, 96 kHz and mono files', async () => {
    const hires = await probeBytes('h.wav', simpleWav({ rate: 96000, bits: 24, dataBytes: 1_152_000 }));
    expect(hires.audio).toMatchObject({ sampleRateHz: 96000, bitDepth: 24, bitrateKbps: 4608 });
    expect(hires.durationMs).toBe(2000);
    const mono = await probeBytes('m.wav', simpleWav({ channels: 1, rate: 8000, bits: 8, dataBytes: 8000 }));
    expect(mono.audio).toMatchObject({ channels: 1, sampleRateHz: 8000, bitDepth: 8 });
    expect(mono.durationMs).toBe(1000);
  });

  it('does not trust a wrong byte rate field for PCM', async () => {
    // Block align 4 at 44100 Hz makes 176400 bytes a second, whatever the header's byte rate says.
    const wrong = wavFile({ chunks: [wavFmt({ channels: 2, rate: 44100, bits: 16, byteRate: 12345 }), riffChunk('data', zeros(1_764_000))] });
    const zero = wavFile({ chunks: [wavFmt({ channels: 2, rate: 44100, bits: 16, byteRate: 0 }), riffChunk('data', zeros(1_764_000))] });
    expect((await probeBytes('wrong.wav', wrong)).durationMs).toBe(10000);
    expect((await probeBytes('zero.wav', zero)).durationMs).toBe(10000);
  });

  it('reads the extensible format and uses the valid bit count', async () => {
    const file = wavFile({ chunks: [wavFmt({ channels: 2, rate: 48000, bits: 32, extensible: { subTag: 1, validBits: 24 } }), riffChunk('data', zeros(384000))] });
    const info = await probeBytes('x.wav', file);
    expect(info.audio).toMatchObject({ codec: 'pcm', sampleRateHz: 48000, channels: 2, bitDepth: 24 });
    expect(info.durationMs).toBe(1000); // 384000 bytes at 48000 x 8 bytes a second is 1 second
  });

  it('names floating point audio and warns about it', async () => {
    const info = await probeBytes('f.wav', simpleWav({ bits: 32, tag: 3, dataBytes: 352800 }));
    expect(info.audio).toMatchObject({ codec: 'pcm', bitDepth: 32 });
    expect(info.warnings.join(' ')).toContain('floating point');
    const ext = await probeBytes('f2.wav', wavFile({ chunks: [wavFmt({ channels: 2, rate: 44100, bits: 32, extensible: { subTag: 3, validBits: 32 } }), riffChunk('data', zeros(352800))] }));
    expect(ext.audio?.codec).toBe('pcm');
    expect(ext.warnings.join(' ')).toContain('floating point');
  });

  it('names MP3 inside a WAV and warns about a format it does not know', async () => {
    const mp3 = await probeBytes('m.wav', wavFile({ chunks: [wavFmt({ tag: 0x55, channels: 2, rate: 44100, bits: 16, byteRate: 16000 }), riffChunk('data', zeros(160000))] }));
    expect(mp3.audio).toMatchObject({ codec: 'mp3', bitrateKbps: 128 });
    expect(mp3.durationMs).toBe(10000);
    const odd = await probeBytes('o.wav', wavFile({ chunks: [wavFmt({ tag: 0x9999, channels: 2, rate: 44100, bits: 16 }), riffChunk('data', zeros(1000))] }));
    expect(odd.audio?.codec).toBe('unknown');
    expect(odd.warnings.join(' ')).toContain('not recognised');
  });

  it('reads LIST/INFO tags', async () => {
    const info = await probeBytes(
      't.wav',
      simpleWav({
        dataBytes: 1000,
        after: [listInfo({ INAM: 'The Title', IART: 'The Artist', IPRD: 'The Album', IGNR: 'Jazz', ICRD: '2017-06-01', ICMT: 'A comment', ITRK: '4/10', IMUS: 'The Composer' })],
      }),
    );
    expect(info.tags).toEqual({ title: 'The Title', artist: 'The Artist', album: 'The Album', genre: 'Jazz', year: 2017, comment: 'A comment', trackNumber: 4, trackTotal: 10, composer: 'The Composer' });
  });

  it('keeps the chunk positions right across chunks with an odd size', async () => {
    const odd = riffChunk('junk', zeros(5)); // padded to 6
    const info = await probeBytes('p.wav', simpleWav({ dataBytes: 1001, before: [odd], after: [listInfo({ INAM: 'After odd chunks' })] }));
    expect(info.tags.title).toBe('After odd chunks');
    expect(info.warnings).toEqual([]);
  });

  it('reads an ID3 chunk', async () => {
    const tag = id3v2({ version: 4, frames: [textFrame(4, 'TIT2', 'In an ID3 chunk')] });
    const info = await probeBytes('i.wav', simpleWav({ dataBytes: 100, after: [riffChunk('id3 ', tag)] }));
    expect(info.tags.title).toBe('In an ID3 chunk');
  });

  it('uses what is there when the data chunk is shorter than its header says, and warns', async () => {
    const whole = simpleWav({ dataBytes: 1_764_000 });
    const cut = whole.subarray(0, whole.length - 882_000); // half the data is gone
    const info = await probeBytes('cut.wav', cut);
    expect(info.durationMs).toBe(5000);
    expect(info.warnings.join(' ')).toContain('cut short');
  });

  it('reads an RF64 file whose data size is in the ds64 chunk', async () => {
    const ds64 = riffChunk('ds64', cat(le64(0), le64(176400), le64(44100), le32(0)));
    const dataChunk = cat('data', le32(0xffffffff), zeros(176400));
    const file = wavFile({ riff: 'RF64', chunks: [ds64, wavFmt({ channels: 2, rate: 44100, bits: 16 }), dataChunk] });
    const info = await probeBytes('big.wav', file);
    expect(info.container).toBe('wav');
    expect(info.durationMs).toBe(1000);
  });

  it('reports a WAV with no fmt chunk', async () => {
    const info = await probeBytes('n.wav', wavFile({ chunks: [riffChunk('data', zeros(100))] }));
    expect(info.container).toBe('wav');
    expect(info.audio).toBeNull();
    expect(info.warnings.join(' ')).toContain('fmt');
  });
});

describe('AIFF and AIFF-C', () => {
  it('reads the 80 bit sample rate for the common rates', async () => {
    for (const rate of [8000, 11025, 22050, 32000, 44100, 48000, 88200, 96000, 192000]) {
      const info = await probeBytes('r.aif', aiffFile({ chunks: [aiffComm({ channels: 2, frames: rate, bits: 16, rate }), ssnd(rate * 4)] }));
      expect(info.audio?.sampleRateHz).toBe(rate);
      expect(info.durationMs).toBe(1000);
    }
  });

  it('encodes the 80 bit float the way the format says (checked against known bytes)', () => {
    // 44100 Hz is 0x400E AC44 0000 0000 0000 in the AIFF specification's own example.
    expect(Array.from(extended80(44100))).toEqual([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
  });

  it('reads the format, length and bitrate', async () => {
    const info = await probeBytes('a.aif', aiffFile({ chunks: [aiffComm({ channels: 2, frames: 441000, bits: 16, rate: 44100 }), ssnd(1_764_000)] }));
    expect(info.container).toBe('aiff');
    expect(info.durationMs).toBe(10000);
    expect(info.audio).toEqual({ codec: 'pcm', sampleRateHz: 44100, channels: 2, bitrateKbps: 1411, bitDepth: 16 });
    expect(info.warnings).toEqual([]);
  });

  it('reads 24 bit and mono', async () => {
    const info = await probeBytes('b.aif', aiffFile({ chunks: [aiffComm({ channels: 1, frames: 48000, bits: 24, rate: 48000 }), ssnd(144000)] }));
    expect(info.audio).toMatchObject({ channels: 1, bitDepth: 24, sampleRateHz: 48000 });
    expect(info.durationMs).toBe(1000);
  });

  it('reads the compression type of AIFF-C', async () => {
    const aifc = (compression: string, bits = 16) => aiffFile({ aifc: true, chunks: [aiffComm({ channels: 2, frames: 44100, bits, rate: 44100, compression }), ssnd(176400)] });
    expect((await probeBytes('a.aifc', aifc('NONE'))).audio).toMatchObject({ codec: 'pcm', bitDepth: 16 });
    expect((await probeBytes('a.aifc', aifc('sowt'))).audio).toMatchObject({ codec: 'pcm' });
    expect((await probeBytes('a.aifc', aifc('fl32', 32))).audio).toMatchObject({ codec: 'pcm', bitDepth: 32 });
    const ima = await probeBytes('a.aifc', aifc('ima4'));
    expect(ima.audio?.codec).toBe('unknown');
    expect(ima.warnings.join(' ')).toContain('ima4');
    expect((await probeBytes('a.aifc', aifc('NONE'))).container).toBe('aiff');
  });

  it('reads NAME, AUTH and ANNO, with an odd sized chunk in front', async () => {
    const info = await probeBytes(
      't.aif',
      aiffFile({ chunks: [aiffComm({ channels: 2, frames: 100, bits: 16, rate: 44100 }), aiffChunk('NAME', utf8('Odd')), aiffChunk('AUTH', utf8('The Author')), aiffChunk('ANNO', utf8('A note')), ssnd(400)] }),
    );
    expect(info.tags).toEqual({ title: 'Odd', artist: 'The Author', comment: 'A note' });
  });

  it('reads an ID3 chunk and lets it fill what NAME and AUTH left', async () => {
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'ID3 title'), textFrame(3, 'TALB', 'ID3 album')] });
    const info = await probeBytes('i.aif', aiffFile({ chunks: [aiffComm({ channels: 2, frames: 100, bits: 16, rate: 44100 }), aiffChunk('NAME', utf8('NAME title')), aiffChunk('ID3 ', tag), ssnd(400)] }));
    expect(info.tags).toMatchObject({ title: 'NAME title', album: 'ID3 album' });
  });

  it('warns when the audio data is shorter than the header says', async () => {
    const info = await probeBytes('s.aif', aiffFile({ chunks: [aiffComm({ channels: 2, frames: 441000, bits: 16, rate: 44100 }), ssnd(400_000)] }));
    expect(info.warnings.join(' ')).toContain('cut short');
  });

  it('reports a file with no COMM chunk', async () => {
    const info = await probeBytes('n.aif', aiffFile({ chunks: [ssnd(100)] }));
    expect(info.container).toBe('aiff');
    expect(info.audio).toBeNull();
    expect(info.warnings.join(' ')).toContain('COMM');
  });
});

describe('Ogg Vorbis', () => {
  const vorbis = (o: { entries?: string[]; granule?: number | null; nominal?: number; rate?: number; channels?: number } = {}) =>
    oggFile({
      head: vorbisIdPacket({ channels: o.channels ?? 2, rate: o.rate ?? 44100, nominalBitrate: o.nominal }),
      comments: vorbisCommentPacket(o.entries ?? []),
      setup: vorbisSetupPacket(),
      lastGranule: o.granule === undefined ? 441000 : o.granule,
    });

  it('reads the identification header and the length from the last page', async () => {
    const info = await probeBytes('a.ogg', vorbis({ nominal: 128000 }));
    expect(info.container).toBe('ogg');
    expect(info.durationMs).toBe(10000); // 441000 samples at 44100 Hz
    expect(info.audio).toEqual({ codec: 'vorbis', sampleRateHz: 44100, channels: 2, bitrateKbps: 128, variableBitrate: true });
  });

  it('calculates an average bitrate when the header gives no nominal one', async () => {
    const file = vorbis({ granule: 44100 }); // 1 second
    const info = await probeBytes('a.ogg', file);
    expect(info.audio?.bitrateKbps).toBe(Math.round((file.length * 8) / 1000));
  });

  it('reads mono and other rates', async () => {
    const info = await probeBytes('m.ogg', vorbis({ rate: 22050, channels: 1, granule: 22050 * 30 }));
    expect(info.audio).toMatchObject({ sampleRateHz: 22050, channels: 1 });
    expect(info.durationMs).toBe(30000);
  });

  it('maps the comments', async () => {
    const info = await probeBytes(
      't.ogg',
      vorbis({ entries: ['TITLE=The Title', 'ARTIST=The Artist', 'ALBUM=The Album', 'ALBUMARTIST=The Album Artist', 'GENRE=Rock', 'DATE=2001', 'TRACKNUMBER=2', 'TRACKTOTAL=9', 'DISCNUMBER=1', 'COMPOSER=The Composer'] }),
    );
    expect(info.tags).toEqual({ title: 'The Title', artist: 'The Artist', album: 'The Album', albumArtist: 'The Album Artist', genre: 'Rock', year: 2001, trackNumber: 2, trackTotal: 9, discNumber: 1, composer: 'The Composer' });
  });

  it('reads chapters', async () => {
    const info = await probeBytes('c.ogg', vorbis({ entries: ['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=One', 'CHAPTER002=00:00:10.250', 'CHAPTER002NAME=Two'] }));
    expect(info.chapters).toEqual([
      { startMs: 0, title: 'One' },
      { startMs: 10250, title: 'Two' },
    ]);
  });

  it('reads cover art from METADATA_BLOCK_PICTURE, even when the comment header spans several pages', async () => {
    const art = fakeJpeg(150_000, 4); // bigger than one page can hold
    const info = await probeBytes('p.ogg', vorbis({ entries: ['TITLE=Big header', `METADATA_BLOCK_PICTURE=${base64(pictureBody({ mime: 'image/jpeg', data: art }))}`] }));
    expect(info.tags.title).toBe('Big header');
    expect(info.artwork?.mime).toBe('image/jpeg');
    expect(Array.from(info.artwork?.data ?? [])).toEqual(Array.from(art));
    expect(info.durationMs).toBe(10000);
  });

  it('uses the last page that has a position, skipping a final page that has none', async () => {
    const file = cat(vorbis(), oggPage({ serial: 1111, seq: 99, granule: null, flags: 4, lacing: [10], body: zeros(10) }));
    expect((await probeBytes('n.ogg', file)).durationMs).toBe(10000);
  });

  it('finds the Vorbis stream when another stream comes first', async () => {
    const file = oggFile({
      serial: 2222,
      head: vorbisIdPacket({ channels: 2, rate: 48000 }),
      comments: vorbisCommentPacket(['TITLE=Second stream']),
      lastGranule: 96000,
      beforeStreams: [theoraBeginPage(1)],
    });
    const info = await probeBytes('mux.ogg', file);
    expect(info.audio).toMatchObject({ codec: 'vorbis', sampleRateHz: 48000 });
    expect(info.tags.title).toBe('Second stream');
    expect(info.durationMs).toBe(2000);
  });

  it('gives the length of the pages that are there when the end of the file is cut off', async () => {
    const full = vorbis();
    const info = await probeBytes('cut.ogg', full.subarray(0, full.length - 60));
    expect(info.audio?.codec).toBe('vorbis');
    expect(info.durationMs).not.toBeNull();
    expect((info.durationMs ?? 0) < 10000).toBe(true);
  });

  it('says so when there is no comment header', async () => {
    const info = await probeBytes('n.ogg', oggFile({ head: vorbisIdPacket({ channels: 2, rate: 44100 }), comments: new Uint8Array(0), lastGranule: null }));
    expect(info.audio?.codec).toBe('vorbis');
    expect(info.warnings.length).toBeGreaterThan(0);
  });
});

describe('Ogg Opus', () => {
  const opus = (o: { entries?: string[]; granule?: number; preSkip?: number; channels?: number } = {}) =>
    oggFile({ head: opusHeadPacket({ channels: o.channels ?? 2, preSkip: o.preSkip ?? 312 }), comments: opusTagsPacket(o.entries ?? []), lastGranule: o.granule ?? 480312 });

  it('reads OpusHead at 48 kHz and takes the pre-skip off the length', async () => {
    const info = await probeBytes('a.opus', opus());
    expect(info.container).toBe('opus');
    expect(info.audio).toMatchObject({ codec: 'opus', sampleRateHz: 48000, channels: 2 });
    expect(info.durationMs).toBe(10000); // (480312 - 312) samples at 48000 Hz
  });

  it('reads a mono stream', async () => {
    expect((await probeBytes('m.opus', opus({ channels: 1 }))).audio?.channels).toBe(1);
  });

  it('reads OpusTags', async () => {
    const info = await probeBytes('t.opus', opus({ entries: ['TITLE=Opus title', 'ARTIST=Opus artist', 'DATE=2022-02-02', 'GENRE=Podcast'] }));
    expect(info.tags).toMatchObject({ title: 'Opus title', artist: 'Opus artist', year: 2022, genre: 'Podcast', declaredKind: 'podcast' });
  });

  it('never gives a negative length when the position is below the pre-skip', async () => {
    const info = await probeBytes('s.opus', opus({ granule: 100 }));
    expect(info.durationMs === null || info.durationMs >= 0).toBe(true);
  });
});

describe('Ogg FLAC', () => {
  it('names the stream and reads its settings', async () => {
    const head = cat([0x7f], 'FLAC', [1, 0], be16(2), 'fLaC', flacBlock(0, flacStreamInfo({ rate: 44100, channels: 2, bits: 16, samples: 88200 })));
    const comments = cat([0x84], [0, 0, 0], vorbisComment(['TITLE=Ogg FLAC']));
    comments.set([0x84, ...Array.from({ length: 3 }, (_, i) => ((comments.length - 4) >> (8 * (2 - i))) & 0xff)]);
    const info = await probeBytes('a.oga', oggFile({ head, comments, lastGranule: 88200 }));
    expect(info.container).toBe('ogg');
    expect(info.audio).toMatchObject({ codec: 'flac', sampleRateHz: 44100, channels: 2, bitDepth: 16 });
    expect(info.durationMs).toBe(2000);
    expect(info.tags.title).toBe('Ogg FLAC');
  });
});

describe('Matroska and WebM', () => {
  const avcPrivate = Uint8Array.from([1, 100, 0, 40, 0xff, 0xe1, 0, 0]);

  it('names the codecs, sizes and length of a Matroska file', async () => {
    const info = await probeBytes(
      'a.mkv',
      mkvFile({
        durationTicks: 60000,
        title: 'Segment title',
        tracks: [
          mkvVideoTrack({ codecId: 'V_MPEG4/ISO/AVC', width: 1920, height: 1080, defaultDurationNs: 41708333, codecPrivate: avcPrivate }),
          mkvAudioTrack({ codecId: 'A_AAC', rate: 48000, channels: 2, codecPrivate: ascLc(AAC_RATE_INDEX[48000], 2) }),
        ],
      }),
    );
    expect(info.container).toBe('mkv');
    expect(info.durationMs).toBe(60000);
    expect(info.video).toEqual({ codec: 'h264', profile: 'High', level: '4.0', width: 1920, height: 1080, fps: 23.976, bitrateKbps: null });
    expect(info.audio).toEqual({ codec: 'aac', sampleRateHz: 48000, channels: 2, bitrateKbps: null });
    expect(info.tags.title).toBe('Segment title');
  });

  it('uses the timecode scale for the length', async () => {
    const info = await probeBytes('s.mkv', mkvFile({ timecodeScale: 500000, durationTicks: 120000, tracks: [mkvAudioTrack({ codecId: 'A_VORBIS', rate: 44100, channels: 2 })] }));
    expect(info.durationMs).toBe(60000);
  });

  it('reads the WebM doc type', async () => {
    const info = await probeBytes('a.webm', mkvFile({ docType: 'webm', durationTicks: 5000, tracks: [mkvVideoTrack({ codecId: 'V_VP9', width: 640, height: 360 }), mkvAudioTrack({ codecId: 'A_OPUS', rate: 48000, channels: 2 })] }));
    expect(info.container).toBe('webm');
    expect(info.video).toMatchObject({ codec: 'vp9', width: 640, height: 360 });
    expect(info.audio).toMatchObject({ codec: 'opus', sampleRateHz: 48000 });
    expect(info.durationMs).toBe(5000);
  });

  it('names the other video codecs', async () => {
    const codec = async (codecId: string) => (await probeBytes('v.mkv', mkvFile({ tracks: [mkvVideoTrack({ codecId, width: 320, height: 240 })] }))).video?.codec;
    expect(await codec('V_MPEGH/ISO/HEVC')).toBe('hevc');
    expect(await codec('V_VP8')).toBe('vp8');
    expect(await codec('V_AV1')).toBe('av1');
    expect(await codec('V_MPEG4/ISO/ASP')).toBe('mpeg4');
    expect(await codec('V_MPEG2')).toBe('mpeg2');
    expect(await codec('V_UNKNOWN')).toBe('unknown');
  });

  it('names the audio codecs', async () => {
    const audio = async (codecId: string, bits?: number) => (await probeBytes('a.mkv', mkvFile({ tracks: [mkvAudioTrack({ codecId, rate: 44100, channels: 2, bits })] }))).audio;
    expect((await audio('A_AC3'))?.codec).toBe('ac3');
    expect((await audio('A_EAC3'))?.codec).toBe('eac3');
    expect((await audio('A_DTS'))?.codec).toBe('dts');
    expect((await audio('A_MPEG/L3'))?.codec).toBe('mp3');
    expect(await audio('A_FLAC', 24)).toMatchObject({ codec: 'flac', bitDepth: 24 });
    expect(await audio('A_PCM/INT/LIT', 16)).toMatchObject({ codec: 'pcm', bitDepth: 16 });
    expect((await audio('A_ALAC'))?.codec).toBe('alac');
    expect((await audio('A_AAC/MPEG4/LC/SBR'))?.codec).toBe('he-aac');
  });

  it('reads HE-AAC from the codec private data', async () => {
    const priv = ascHeExplicit(AAC_RATE_INDEX[24000], AAC_RATE_INDEX[48000], 2);
    const info = await probeBytes('h.mkv', mkvFile({ tracks: [mkvAudioTrack({ codecId: 'A_AAC', rate: 24000, channels: 2, codecPrivate: priv })] }));
    expect(info.audio).toMatchObject({ codec: 'he-aac', sampleRateHz: 48000 });
  });

  it('finds the tracks even when they come after the clusters', async () => {
    const info = await probeBytes('late.mkv', mkvFile({ tracksAfterCluster: true, clusterBytes: 5000, durationTicks: 1000, tracks: [mkvAudioTrack({ codecId: 'A_AAC', rate: 44100, channels: 2 })] }));
    expect(info.audio?.sampleRateHz).toBe(44100);
  });

  it('reads a segment that does not know its size', async () => {
    const info = await probeBytes('live.mkv', mkvFile({ unknownSegmentSize: true, durationTicks: 2000, tracks: [mkvAudioTrack({ codecId: 'A_VORBIS', rate: 44100, channels: 2 })] }));
    expect(info.audio?.codec).toBe('vorbis');
    expect(info.durationMs).toBe(2000);
  });

  it('reports a file with a broken header', async () => {
    const info = await probeBytes('bad.mkv', cat([0x1a, 0x45, 0xdf, 0xa3], el(0x4282, elStr(0x86, 'x')).subarray(0, 3), zeros(20)));
    expect(info.warnings.length).toBeGreaterThan(0);
    expect(info.audio).toBeNull();
  });
});

describe('AVI', () => {
  const avi = (o: { fourcc?: string; height?: number; audioTag?: number } = {}) =>
    aviFile({
      main: aviMainHeader({ microsPerFrame: 40000, totalFrames: 1500, width: 640, height: 480 }),
      streams: [
        [aviStreamHeader({ type: 'vids', handler: o.fourcc ?? 'H264', scale: 1, rate: 25, length: 1500 }), aviVideoFormat({ width: 640, height: o.height ?? 480, compression: o.fourcc ?? 'H264' })],
        [aviStreamHeader({ type: 'auds', handler: '\0\0\0\0', scale: 1, rate: 44100, length: 100 }), aviAudioFormat({ tag: o.audioTag ?? 0x55, channels: 2, rate: 44100, avgBytes: 16000, bits: 0 })],
      ],
    });

  it('names both streams and gives the length', async () => {
    const info = await probeBytes('a.avi', avi());
    expect(info.container).toBe('avi');
    expect(info.durationMs).toBe(60000);
    expect(info.video).toEqual({ codec: 'h264', width: 640, height: 480, fps: 25, bitrateKbps: null });
    expect(info.audio).toEqual({ codec: 'mp3', sampleRateHz: 44100, channels: 2, bitrateKbps: 128 });
  });

  it('names MPEG-4 part 2 codecs and AC-3 audio, and reads a top-down picture height', async () => {
    const xvid = await probeBytes('x.avi', avi({ fourcc: 'XVID', audioTag: 0x2000, height: -480 }));
    expect(xvid.video).toMatchObject({ codec: 'mpeg4', height: 480 });
    expect(xvid.audio?.codec).toBe('ac3');
  });

  it('falls back to the main header for the length', async () => {
    const file = aviFile({
      main: aviMainHeader({ microsPerFrame: 40000, totalFrames: 250, width: 320, height: 240 }),
      streams: [[aviStreamHeader({ type: 'vids', handler: 'DIVX', scale: 0, rate: 0, length: 0 }), aviVideoFormat({ width: 320, height: 240, compression: 'DIVX' })]],
    });
    const info = await probeBytes('b.avi', file);
    expect(info.durationMs).toBe(10000);
    expect(info.video?.fps).toBeNull();
  });
});

describe('ASF (WMA and WMV)', () => {
  it('reads the length, the audio stream and the tags of a WMA file', async () => {
    const file = asfFile([
      asfFileProperties({ playDuration100ns: 600_000_000, prerollMs: 3000 }),
      asfAudioStream({ tag: 0x161, channels: 2, rate: 44100, avgBytes: 16000, bits: 16 }),
      asfContentDescription({ title: 'WMA Title', author: 'WMA Artist', description: 'WMA comment' }),
      asfExtendedContent([
        { name: 'WM/AlbumTitle', type: 'string', value: 'WMA Album' },
        { name: 'WM/AlbumArtist', type: 'string', value: 'WMA Album Artist' },
        { name: 'WM/Genre', type: 'string', value: 'Pop' },
        { name: 'WM/Year', type: 'string', value: '2008' },
        { name: 'WM/TrackNumber', type: 'dword', value: 7 },
        { name: 'WM/PartOfSet', type: 'string', value: '1/2' },
        { name: 'WM/Composer', type: 'string', value: 'WMA Composer' },
      ]),
    ]);
    const info = await probeBytes('a.wma', file);
    expect(info.container).toBe('wma');
    expect(info.durationMs).toBe(57000); // 60 s of play time less 3 s of preroll
    expect(info.audio).toEqual({ codec: 'wma', sampleRateHz: 44100, channels: 2, bitrateKbps: 128 });
    expect(info.tags).toEqual({ title: 'WMA Title', artist: 'WMA Artist', comment: 'WMA comment', album: 'WMA Album', albumArtist: 'WMA Album Artist', genre: 'Pop', year: 2008, trackNumber: 7, discNumber: 1, discTotal: 2, composer: 'WMA Composer' });
  });

  it('reads a video stream', async () => {
    const file = asfFile([
      asfFileProperties({ playDuration100ns: 100_000_000, prerollMs: 0 }),
      asfVideoStream({ width: 640, height: 480, compression: 'WMV3' }),
      asfAudioStream({ tag: 0x162, channels: 2, rate: 48000, avgBytes: 24000, bits: 16 }),
    ]);
    const info = await probeBytes('a.wmv', file);
    expect(info.video).toMatchObject({ codec: 'unknown', width: 640, height: 480 });
    expect(info.audio?.codec).toBe('wma');
    expect(info.durationMs).toBe(10000);
  });

  it('names an H.264 video stream', async () => {
    const info = await probeBytes('h.wmv', asfFile([asfFileProperties({ playDuration100ns: 10_000_000, prerollMs: 0 }), asfVideoStream({ width: 320, height: 240, compression: 'H264' })]));
    expect(info.video?.codec).toBe('h264');
  });

  it('reports a damaged header', async () => {
    const file = asfFile([asfFileProperties({ playDuration100ns: 600_000_000, prerollMs: 0 })]);
    file.set(le64(5), 16); // a header size smaller than the header itself
    const info = await probeBytes('bad.wma', file);
    expect(info.warnings.length).toBeGreaterThan(0);
  });
});

describe('format detection', () => {
  it('goes by the bytes, not the file name', async () => {
    const wav = simpleWav({ dataBytes: 1000 });
    expect((await probeBytes('really-a-wav.mp3', wav)).container).toBe('wav');
    expect((await probeBytes('no-extension', wav)).container).toBe('wav');
    expect((await probeBytes('really-flac.wav', flacFile())).container).toBe('flac');
  });

  it('gives container unknown, with a warning, for something that is not media', async () => {
    const info = await probeBytes('notes.txt', utf8('This is a plain text file and has nothing to do with audio.'.repeat(30)));
    expect(info.container).toBe('unknown');
    expect(info.audio).toBeNull();
    expect(info.video).toBeNull();
    expect(info.durationMs).toBeNull();
    expect(info.warnings.length).toBeGreaterThan(0);
  });

  it('gives container unknown for an empty file', async () => {
    const info = await probeBytes('empty.mp3', new Uint8Array(0));
    expect(info.container).toBe('unknown');
    expect(info.sizeBytes).toBe(0);
    expect(info.warnings.join(' ')).toContain('empty');
  });

  it('reports the file name and size it was given', async () => {
    const wav = simpleWav({ dataBytes: 100 });
    const info = await probeBytes('name here.wav', wav);
    expect(info.fileName).toBe('name here.wav');
    expect(info.sizeBytes).toBe(wav.length);
  });

  it('never invents tags, a cover or chapters for a plain file', async () => {
    const info = await probeBytes('plain.wav', simpleWav({ dataBytes: 100 }));
    expect(info.tags).toEqual({});
    expect(info.artwork).toBeNull();
    expect(info.chapters).toEqual([]);
    expect(info.protected).toBe(false);
  });
});
