import { describe, expect, it } from 'vitest';
import { adtsFrame, CBR_48K_128, id3v1, id3v2, mp3File, mpegFrame, mpegFrameLength, mpegFrames, textFrame, vbrHeaderFrame } from './build-mp3';
import { cat, probeBytes, zeros } from './helpers';

describe('the MPEG frame builder used by these tests', () => {
  // Known frame sizes, worked out by hand from the format, so a wrong fixture shows up here.
  it('makes frames of the published sizes', () => {
    expect(mpegFrameLength({ bitrate: 128, rate: 44100 })).toBe(417);
    expect(mpegFrameLength({ bitrate: 128, rate: 44100, padding: true })).toBe(418);
    expect(mpegFrameLength({ bitrate: 320, rate: 48000 })).toBe(960);
    expect(mpegFrameLength({ version: 2, bitrate: 64, rate: 24000 })).toBe(192);
    expect(mpegFrameLength({ version: 2.5, bitrate: 8, rate: 8000 })).toBe(72);
    expect(mpegFrameLength({ layer: 2, bitrate: 192, rate: 44100 })).toBe(626);
    expect(mpegFrameLength({ layer: 1, bitrate: 384, rate: 44100 })).toBe(416);
    expect(mpegFrameLength(CBR_48K_128)).toBe(384);
  });
});

describe('MP3 audio', () => {
  it('reads a constant bitrate file: rate, channels, bitrate and a length from the size', async () => {
    // 100 frames of 384 bytes at 128 kbps: 38400 bytes is exactly 2.4 seconds.
    const file = mp3File({ frames: [mpegFrames(CBR_48K_128, 100)] });
    const info = await probeBytes('cbr.mp3', file);
    expect(info.container).toBe('mp3');
    expect(info.audio).toEqual({ codec: 'mp3', sampleRateHz: 48000, channels: 2, bitrateKbps: 128, variableBitrate: false });
    expect(info.durationMs).toBe(2400);
    expect(info.video).toBeNull();
    expect(info.sizeBytes).toBe(38400);
    expect(info.fileName).toBe('cbr.mp3');
    expect(info.warnings).toEqual([]);
  });

  it('does not count the ID3 tags when it calculates the length', async () => {
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'Song')], padding: 4000 });
    const file = mp3File({ id3: tag, frames: [mpegFrames(CBR_48K_128, 100)], id3v1: id3v1({ title: 'Old' }) });
    const info = await probeBytes('tagged.mp3', file);
    expect(info.durationMs).toBe(2400);
    expect(info.tags.title).toBe('Song');
  });

  it('reads MPEG 2 and MPEG 2.5 layer III files and a single channel', async () => {
    const v2 = await probeBytes('v2.mp3', mpegFrames({ version: 2, bitrate: 64, rate: 24000 }, 100));
    expect(v2.audio).toMatchObject({ sampleRateHz: 24000, channels: 2, bitrateKbps: 64 });
    expect(v2.durationMs).toBe(2400);

    const v25 = await probeBytes('v25.mp3', mpegFrames({ version: 2.5, bitrate: 8, rate: 8000, mono: true }, 100));
    expect(v25.audio).toMatchObject({ sampleRateHz: 8000, channels: 1, bitrateKbps: 8 });
    expect(v25.durationMs).toBe(7200);
  });

  it('reads frames that carry a CRC', async () => {
    const info = await probeBytes('crc.mp3', mpegFrames({ ...CBR_48K_128, crc: true }, 50));
    expect(info.audio?.sampleRateHz).toBe(48000);
    expect(info.durationMs).toBe(1200);
  });

  it('does not call layer I or II audio MP3', async () => {
    const layer2 = await probeBytes('l2.mp2', mpegFrames({ layer: 2, bitrate: 192, rate: 44100 }, 20));
    expect(layer2.audio?.codec).toBe('unknown');
    expect(layer2.audio?.sampleRateHz).toBe(44100);
    expect(layer2.warnings.join(' ')).toContain('layer II');

    const layer1 = await probeBytes('l1.mp1', mpegFrames({ layer: 1, bitrate: 384, rate: 44100 }, 20));
    expect(layer1.audio?.codec).toBe('unknown');
    expect(layer1.warnings.join(' ')).toContain('layer I ');
  });

  it('finds the audio after leading junk and says so', async () => {
    const info = await probeBytes('junk.mp3', cat(zeros(700).fill(7), mpegFrames(CBR_48K_128, 50)));
    expect(info.container).toBe('mp3');
    expect(info.audio?.sampleRateHz).toBe(48000);
    expect(info.warnings.join(' ')).toContain('700 bytes');
  });

  it('is not fooled by sync-like bytes in a tag', async () => {
    // 0xFF 0xFB looks like a frame start, but no second frame follows where its length says.
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'x')], padding: 64 });
    const decoy = Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
    const file = cat(tag, decoy, zeros(600), mpegFrames(CBR_48K_128, 40));
    const info = await probeBytes('decoy.mp3', file);
    expect(info.audio?.sampleRateHz).toBe(48000);
    expect(info.audio?.bitrateKbps).toBe(128);
  });
});

describe('VBR and LAME headers', () => {
  it('takes the length from the Xing frame count and the bitrate from its byte count', async () => {
    // The data is real size, so the header and the file agree: 1001 frames (the header frame and 1000 more) of 417 bytes.
    const header = vbrHeaderFrame({ kind: 'Xing', bitrate: 128, rate: 44100, frames: 1000, bytes: 417417 });
    const file = mp3File({ frames: [header, mpegFrames({ bitrate: 128, rate: 44100 }, 1000)] });
    const info = await probeBytes('vbr.mp3', file);
    // 1000 frames x 1152 samples / 44100 Hz = 26.1224 s
    expect(info.durationMs).toBe(26122);
    expect(info.audio?.variableBitrate).toBe(true);
    expect(info.audio?.bitrateKbps).toBe(128); // 417417 bytes over 26.1224 s is 127.8 kbps
    expect(info.audio?.sampleRateHz).toBe(44100);
    expect(info.warnings).toEqual([]);
  });

  it('takes the bitrate of a VBR file from the header byte count, not from the first frame', async () => {
    // A header that says the stream is 600000 bytes over 26.1224 s is 183.7 kbps, whatever the first frame says.
    const header = vbrHeaderFrame({ kind: 'Xing', bitrate: 128, rate: 44100, frames: 1000, bytes: 600000 });
    const file = mp3File({ frames: [header, mpegFrames({ bitrate: 128, rate: 44100 }, 1000), zeros(200000)] });
    const info = await probeBytes('vbr2.mp3', file);
    expect(info.audio?.bitrateKbps).toBe(184);
    expect(info.durationMs).toBe(26122);
  });

  it('scales the length and warns when the file is shorter than its VBR header says', async () => {
    const header = vbrHeaderFrame({ kind: 'Xing', bitrate: 128, rate: 44100, frames: 1000, bytes: 417417 });
    const file = mp3File({ frames: [header, mpegFrames({ bitrate: 128, rate: 44100 }, 250)] }); // a quarter of the audio
    const info = await probeBytes('cut-vbr.mp3', file);
    expect(info.warnings.join(' ')).toContain('cut short');
    expect(info.durationMs).toBe(Math.round(26122.4489795918 * (file.length / 417417)));
    expect((info.durationMs ?? 0) < 8000).toBe(true);
  });

  it('does not scale the length for a file that has more bytes than the header counts (tags, padding)', async () => {
    const header = vbrHeaderFrame({ kind: 'Xing', bitrate: 128, rate: 44100, frames: 1000, bytes: 417417 });
    const tag = id3v2({ version: 3, frames: [textFrame(3, 'TIT2', 'Bigger file')], padding: 50000 });
    const info = await probeBytes('padded.mp3', mp3File({ id3: tag, frames: [header, mpegFrames({ bitrate: 128, rate: 44100 }, 1000)] }));
    expect(info.durationMs).toBe(26122);
    expect(info.warnings).toEqual([]);
  });

  it('treats an Info header as constant bitrate and still uses its frame count', async () => {
    const header = vbrHeaderFrame({ kind: 'Info', ...CBR_48K_128, frames: 2500, bytes: 960384 });
    const file = mp3File({ frames: [header, mpegFrames(CBR_48K_128, 2500)] });
    const info = await probeBytes('lame-cbr.mp3', file);
    expect(info.durationMs).toBe(60000); // 2500 x 1152 / 48000
    expect(info.audio?.variableBitrate).toBe(false);
    expect(info.audio?.bitrateKbps).toBe(128);
  });

  it('reads a VBRI header', async () => {
    const header = vbrHeaderFrame({ kind: 'VBRI', bitrate: 128, rate: 44100, frames: 500, bytes: 208917 });
    const file = mp3File({ frames: [header, mpegFrames({ bitrate: 128, rate: 44100 }, 500)] });
    const info = await probeBytes('vbri.mp3', file);
    expect(info.durationMs).toBe(13061); // 500 x 1152 / 44100 = 13.0612 s
    expect(info.audio?.variableBitrate).toBe(true);
    expect(info.audio?.bitrateKbps).toBe(128); // 208917 bytes over 13.061 s is 128.0 kbps
  });

  it('finds the Xing header at the right place for MPEG 2 stereo and MPEG 1 mono', async () => {
    // MPEG 2 layer III: 576 samples per frame. 1000 frames at 24000 Hz is 24 s.
    const v2 = vbrHeaderFrame({ kind: 'Xing', version: 2, bitrate: 64, rate: 24000, frames: 1000 });
    const v2info = await probeBytes('v2vbr.mp3', mp3File({ frames: [v2, mpegFrames({ version: 2, bitrate: 64, rate: 24000 }, 20)] }));
    expect(v2info.durationMs).toBe(24000);
    expect(v2info.audio?.variableBitrate).toBe(true);

    const mono = vbrHeaderFrame({ kind: 'Xing', bitrate: 64, rate: 44100, mono: true, frames: 100 });
    const monoInfo = await probeBytes('monovbr.mp3', mp3File({ frames: [mono, mpegFrames({ bitrate: 64, rate: 44100, mono: true }, 20)] }));
    expect(monoInfo.durationMs).toBe(2612); // 100 x 1152 / 44100 = 2.6122 s
    expect(monoInfo.audio?.channels).toBe(1);
  });

  it('falls back to the size, with a warning, when the Xing header has no frame count', async () => {
    const header = vbrHeaderFrame({ kind: 'Xing', ...CBR_48K_128 });
    const file = mp3File({ frames: [header, mpegFrames(CBR_48K_128, 99)] });
    const info = await probeBytes('nocount.mp3', file);
    expect(info.durationMs).toBe(2400);
    expect(info.warnings.join(' ')).toContain('no frame count');
  });

  it('notices variable bitrate with no VBR header and warns that the length is an estimate', async () => {
    const low = mpegFrame({ bitrate: 128, rate: 48000 });
    const high = mpegFrame({ bitrate: 160, rate: 48000 });
    const frames = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? low : high));
    const file = mp3File({ frames });
    const info = await probeBytes('hidden-vbr.mp3', file);
    expect(info.audio?.variableBitrate).toBe(true);
    expect(info.audio?.bitrateKbps).toBe(144);
    expect(info.warnings.join(' ')).toContain('estimate');
    // 60 frames are 30 x (384 + 480) = 25920 bytes; at an average 144 kbps that is 1440 ms.
    expect(info.durationMs).toBe(1440);
  });
});

describe('ID3v1', () => {
  it('reads an ID3v1 tag when there is no ID3v2 tag', async () => {
    const file = mp3File({ frames: [mpegFrames(CBR_48K_128, 40)], id3v1: id3v1({ title: 'Old Title', artist: 'Old Artist', album: 'Old Album', year: '1994', comment: 'hello', genre: 17 }) });
    const info = await probeBytes('v1.mp3', file);
    expect(info.tags).toMatchObject({ title: 'Old Title', artist: 'Old Artist', album: 'Old Album', year: 1994, comment: 'hello', genre: 'Rock' });
    expect(info.audio?.bitrateKbps).toBe(128);
  });

  it('reads the track number of an ID3v1.1 tag', async () => {
    const file = mp3File({ frames: [mpegFrames(CBR_48K_128, 40)], id3v1: id3v1({ title: 'T', comment: 'c', track: 7, genre: 8 }) });
    const info = await probeBytes('v11.mp3', file);
    expect(info.tags.trackNumber).toBe(7);
    expect(info.tags.comment).toBe('c');
    expect(info.tags.genre).toBe('Jazz');
  });

  it('uses ID3v1 only for what the ID3v2 tag lacks', async () => {
    const file = mp3File({
      id3: id3v2({ version: 4, frames: [textFrame(4, 'TIT2', 'New Title')] }),
      frames: [mpegFrames(CBR_48K_128, 40)],
      id3v1: id3v1({ title: 'Old Title', artist: 'Old Artist' }),
    });
    const info = await probeBytes('both.mp3', file);
    expect(info.tags.title).toBe('New Title');
    expect(info.tags.artist).toBe('Old Artist');
  });

  it('gives no genre for the "none" value 255', async () => {
    const info = await probeBytes('nogenre.mp3', mp3File({ frames: [mpegFrames(CBR_48K_128, 40)], id3v1: id3v1({ title: 'T' }) }));
    expect(info.tags.genre).toBeUndefined();
  });
});

describe('AAC in ADTS frames', () => {
  const frames = (count: number, sampleRateIndex: number, channelConfig: number, payload = 100) =>
    cat(...Array.from({ length: count }, () => adtsFrame({ sampleRateIndex, channelConfig, payload })));

  it('reads sample rate, channels and an exact length when the whole file fits in the first read', async () => {
    const info = await probeBytes('a.aac', frames(100, 4, 2)); // index 4 is 44100 Hz
    expect(info.container).toBe('aac');
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRateHz: 44100, channels: 2 });
    expect(info.durationMs).toBe(2322); // 100 x 1024 / 44100 = 2.3220 s
    expect(info.warnings).toEqual([]);
    // 107 bytes per frame at 1024 samples and 44100 Hz is 36.8 kbps
    expect(info.audio?.bitrateKbps).toBe(37);
  });

  it('maps the channel configuration, including 7 meaning eight channels', async () => {
    expect((await probeBytes('mono.aac', frames(20, 6, 1))).audio).toMatchObject({ sampleRateHz: 24000, channels: 1 });
    expect((await probeBytes('51.aac', frames(20, 3, 6))).audio).toMatchObject({ sampleRateHz: 48000, channels: 6 });
    expect((await probeBytes('71.aac', frames(20, 3, 7))).audio).toMatchObject({ channels: 8 });
  });

  it('reads an ADTS file with an ID3v2 tag in front', async () => {
    const tag = id3v2({ version: 4, frames: [textFrame(4, 'TIT2', 'Radio Show')] });
    const info = await probeBytes('tagged.aac', cat(tag, frames(40, 5, 2))); // index 5 is 32000 Hz
    expect(info.container).toBe('aac');
    expect(info.tags.title).toBe('Radio Show');
    expect(info.audio?.sampleRateHz).toBe(32000);
  });
});
