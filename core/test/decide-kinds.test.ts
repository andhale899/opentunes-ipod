import { describe, expect, it } from 'vitest';
import { decideForDevice, devices, getDevice } from '../src/index';
import type { MediaInfo } from '../src/media/types';
import { audioFile, audioOnly44, cloneDevice, expectPlainReasons, info, nano, said, smallVideo, videoFile } from './media-fixtures';

const HOUR = 60 * 60 * 1000;
const chapters = [
  { startMs: 0, title: 'One' },
  { startMs: 60_000, title: 'Two' },
];

describe('kinds and output containers', () => {
  it('copies an m4b audiobook with its own extension, and passes on what the registry says about audiobooks', () => {
    const decision = decideForDevice(audioFile('m4b', { codec: 'aac' }, { chapters, durationMs: 5 * HOUR }), nano);
    expect(decision.action).toBe('copy');
    expect(decision.kind).toBe('audiobook');
    expect(decision.outputExtension).toBe('.m4b');
    expect(said(decision)).toContain('About audiobooks on this iPod: The page lists Audible formats. M4B files are not mentioned.');
    expectPlainReasons(decision);
  });

  it('converts a FLAC audiobook to m4b, keeping chapters, artwork and tags', () => {
    const file = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }, {
      tags: { genre: 'Audiobook' },
      chapters,
      artwork: { mime: 'image/jpeg', data: new Uint8Array(10) },
    });
    const decision = decideForDevice(file, nano);
    expect(decision.action).toBe('convert');
    expect(decision.kind).toBe('audiobook');
    expect(decision.outputExtension).toBe('.m4b');
    expect(decision.conversion).toMatchObject({ container: 'm4b', keepChapters: true, keepArtwork: true, keepTags: true });
  });

  it('keeps chapters on an audiobook even when the probe found none', () => {
    const decision = decideForDevice(audioFile('opus', { codec: 'opus', sampleRateHz: 48000 }, { tags: { genre: 'Audiobook' } }), nano);
    expect(decision.conversion?.keepChapters).toBe(true);
    expect(decision.conversion?.container).toBe('m4b');
  });

  it('copies an MP3 audiobook as it is, without changing its extension', () => {
    const decision = decideForDevice(audioFile('mp3', { codec: 'mp3' }, { tags: { genre: 'Audiobook' } }), nano);
    expect(decision.action).toBe('copy');
    expect(decision.kind).toBe('audiobook');
    expect(decision.outputExtension).toBe('.mp3');
  });

  it('converts music and podcasts to m4a, with chapters only when the file has them', () => {
    const flac = { codec: 'flac', bitDepth: 16, bitrateKbps: null } as const;
    const music = decideForDevice(audioFile('flac', flac), nano);
    expect(music.kind).toBe('music');
    expect(music.conversion).toMatchObject({ container: 'm4a', keepChapters: false });
    expect(music.outputExtension).toBe('.m4a');

    const withChapters = decideForDevice(audioFile('flac', flac, { chapters }), nano);
    expect(withChapters.conversion?.keepChapters).toBe(true);

    const podcast = decideForDevice(audioFile('flac', flac, { tags: { genre: 'Podcast' } }), nano);
    expect(podcast.kind).toBe('podcast');
    expect(podcast.conversion).toMatchObject({ container: 'm4a', keepChapters: false });
    expect(podcast.outputExtension).toBe('.m4a');
    expect(decideForDevice(audioFile('flac', flac, { tags: { genre: 'Podcast' }, chapters }), nano).conversion?.keepChapters).toBe(true);
  });

  it('copies a podcast MP3 and passes on what the registry says about podcasts', () => {
    const decision = decideForDevice(audioFile('mp3', { codec: 'mp3' }, { tags: { podcastCategory: 'News' } }), nano);
    expect(decision.action).toBe('copy');
    expect(decision.kind).toBe('podcast');
    expect(said(decision)).toContain("About podcasts on this iPod: Not on Apple's page. The device declares podcast support.");
  });

  it('keeps tags and artwork on every conversion', () => {
    const files: MediaInfo[] = [
      audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }),
      audioFile('opus', { codec: 'opus', sampleRateHz: 48000 }, { tags: { genre: 'Podcast' } }),
      audioFile('wma', { codec: 'wma' }, { tags: { genre: 'Audiobook' } }),
      videoFile({ fps: 60 }),
      videoFile({ codec: 'hevc' }, {}, { tags: { show: 'A Show' } }),
    ];
    for (const file of files) {
      for (const device of [nano, smallVideo, audioOnly44]) {
        const decision = decideForDevice(file, device, { lossless: true });
        if (decision.action === 'convert') expect(decision.conversion, file.fileName).toMatchObject({ keepTags: true, keepArtwork: true });
      }
    }
  });

  it('gives video kinds the m4v container', () => {
    const cases: Array<[string, MediaInfo, string]> = [
      ['a movie', videoFile({ fps: 60 }), 'movie'],
      ['a TV show', videoFile({ fps: 60 }, {}, { fileName: 'Show.S01E02.mkv', container: 'mkv' }), 'tv-show'],
      ['a music video', videoFile({ fps: 60 }, {}, { tags: { artist: 'A', album: 'B' }, durationMs: 200_000 }), 'music-video'],
      ['a video podcast', videoFile({ fps: 60 }, {}, { tags: { genre: 'Podcast' } }), 'video-podcast'],
    ];
    for (const [name, file, kind] of cases) {
      const decision = decideForDevice(file, nano);
      expect(decision.kind, name).toBe(kind);
      expect(decision.conversion?.container, name).toBe('m4v');
      expect(decision.outputExtension, name).toBe('.m4v');
    }
  });
});

describe('the person\'s choice and what the file says', () => {
  it('lets the person say an MP3 is an audiobook, which is still copied as an MP3', () => {
    const decision = decideForDevice(audioFile('mp3', { codec: 'mp3' }), nano, { userKind: 'audiobook' });
    expect(decision.kind).toBe('audiobook');
    expect(decision.action).toBe('copy');
    expect(decision.outputExtension).toBe('.mp3');
  });

  it('lets the person say an m4b is music', () => {
    const decision = decideForDevice(audioFile('m4b', { codec: 'aac' }), nano, { userKind: 'music' });
    expect(decision.kind).toBe('music');
    expect(decision.outputExtension).toBe('.m4b');
  });

  it('follows the kind the file declares', () => {
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3' }, { tags: { declaredKind: 'podcast' } }), nano).kind).toBe('podcast');
  });

  it.each([
    ['movie', 'music'],
    ['tv-show', 'music'],
    ['music-video', 'music'],
    ['video-podcast', 'podcast'],
  ] as const)('treats an audio file the person called %s as %s, and says so', (asked, becomes) => {
    const decision = decideForDevice(audioFile('mp3', { codec: 'mp3' }), nano, { userKind: asked });
    expect(decision.kind).toBe(becomes);
    expect(decision.action).toBe('copy');
    expect(said(decision)).toContain('has no picture');
    expectPlainReasons(decision);
  });

  it.each([
    ['music', 'music-video'],
    ['podcast', 'video-podcast'],
    ['audiobook', 'movie'],
  ] as const)('treats a video the person called %s as %s, and says so', (asked, becomes) => {
    const decision = decideForDevice(videoFile(), nano, { userKind: asked });
    expect(decision.kind).toBe(becomes);
    expect(said(decision)).toContain('has a picture');
    expectPlainReasons(decision);
  });
});

describe('a kind the model does not list falls back, with a reason', () => {
  const mp3 = audioFile('mp3', { codec: 'mp3' });

  it('plays a podcast as music on a model that does not list podcasts', () => {
    const decision = decideForDevice({ ...mp3, tags: { genre: 'Podcast' } }, audioOnly44);
    expect(decision.kind).toBe('music');
    expect(decision.action).toBe('copy');
    expect(said(decision)).toContain("This iPod's specification does not list podcasts, so the file is added as music instead.");
    expectPlainReasons(decision);
  });

  it('plays an audiobook as music, in m4a, when the model has not confirmed audiobooks', () => {
    const file = audioFile('flac', { codec: 'flac', bitDepth: 16, bitrateKbps: null }, { tags: { genre: 'Audiobook' }, chapters });
    const decision = decideForDevice(file, audioOnly44);
    expect(decision.kind).toBe('music');
    expect(decision.conversion?.container).toBe('m4a');
    expect(decision.outputExtension).toBe('.m4a');
    expect(said(decision)).toContain('OpenTunes has not confirmed that this iPod supports audiobooks, so the file is added as music instead.');
    expectPlainReasons(decision);
  });

  it('says "does not list audiobooks" when the status is not-listed', () => {
    const device = cloneDevice('test-no-audiobooks', (copy) => {
      copy.media!.audiobook = { status: 'not-listed' };
    });
    const decision = decideForDevice(audioFile('m4b', { codec: 'aac' }), device);
    expect(decision.kind).toBe('music');
    expect(said(decision)).toContain('does not list audiobooks');
  });

  it('plays a video podcast as a movie on a model with video but no podcasts', () => {
    const device = cloneDevice('test-no-podcasts', (copy) => {
      copy.media!.podcast = { status: 'not-listed' };
      delete copy.deviceDeclared;
    });
    const decision = decideForDevice(videoFile({}, {}, { tags: { genre: 'Podcast' } }), device);
    expect(decision.kind).toBe('movie');
    expect(decision.action).toBe('copy');
    expect(said(decision)).toContain('does not list podcasts');
    expectPlainReasons(decision);
  });

  it('lets the iPod\'s own description file switch podcasts off, even when the page lists them', () => {
    const device = cloneDevice('test-declared-no-podcasts', (copy) => {
      copy.deviceDeclared!.features!.podcasts = false;
    });
    const decision = decideForDevice({ ...mp3, tags: { genre: 'Podcast' } }, device);
    expect(decision.kind).toBe('music');
    expect(said(decision)).toContain("own description file says it does not support podcasts");
  });

  it('lets the iPod\'s own description file switch podcasts on, even when the page does not list them', () => {
    const device = cloneDevice('test-declared-podcasts', (copy) => {
      copy.media!.podcast = { status: 'not-listed' };
    });
    expect(decideForDevice({ ...mp3, tags: { genre: 'Podcast' } }, device).kind).toBe('podcast');
  });

  it('keeps podcasts and audiobooks on the nano, where the registry lists them', () => {
    expect(decideForDevice({ ...mp3, tags: { genre: 'Podcast' } }, nano).kind).toBe('podcast');
    expect(decideForDevice({ ...mp3, tags: { genre: 'Audiobook' } }, nano).kind).toBe('audiobook');
  });
});

describe('files that are not added', () => {
  const documentExtensions = ['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.txt', '.rtf', '.doc', '.docx', '.EPUB', '.Pdf', '.AZW3'];

  it.each(documentExtensions)('refuses %s even when the container is unknown', (extension) => {
    const decision = decideForDevice(info({ fileName: `book${extension}`, container: 'unknown' }), nano);
    expect(decision.action).toBe('unsupported');
    expect(decision.conversion).toBeNull();
    expect(decision.outputExtension).toBe('');
    expect(said(decision)).toContain('Notes or');
    expect(said(decision)).toContain(nano.name);
    expectPlainReasons(decision);
  });

  it('also refuses a document the probe gave a container to', () => {
    const decision = decideForDevice(info({ fileName: 'notes.txt', container: 'mp4' }), nano);
    expect(decision.action).toBe('unsupported');
  });

  it('does not mistake a media file with a document word in its name for a document', () => {
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3' }, { fileName: 'my.epub.mp3' }), nano).action).toBe('copy');
    expect(decideForDevice(audioFile('mp3', { codec: 'mp3' }, { fileName: 'pdf' }), nano).action).toBe('copy');
  });

  describe('the reason follows the registry\'s Notes status', () => {
    const book = info({ fileName: 'book.epub', container: 'unknown' });

    it('says the nano has no Notes or book reader that OpenTunes knows of, as its row says (status unknown)', () => {
      expect(nano.media?.notes?.status).toBe('unknown');
      const reason = decideForDevice(book, nano).reasons[0];
      expect(reason).toBe(
        "The iPod nano (7th generation) has no Notes or book reader that OpenTunes knows of (this is not confirmed either way), and the iPod's own description file does not declare one, so e-books and documents are not put on it.",
      );
    });

    it('cites the specification when the row says Notes is not listed', () => {
      const device = cloneDevice('test-notes-not-listed', (copy) => {
        copy.media!.notes = { status: 'not-listed' };
      });
      const reason = decideForDevice(book, device).reasons[0];
      expect(reason).toContain('The published specification for Test iPod test-notes-not-listed does not list Notes or a book reader');
      expect(reason).toContain("the iPod's own description file does not declare one");
    });

    it('leaves out the description file when the row has none', () => {
      const device = cloneDevice('test-notes-no-file', (copy) => {
        copy.media!.notes = { status: 'not-listed' };
        delete copy.deviceDeclared;
      });
      const reason = decideForDevice(book, device).reasons[0];
      expect(reason).toContain('does not list Notes or a book reader');
      expect(reason).not.toContain('description file');
    });

    it('gives a different reason, and still no conversion, when the row says Notes is supported', () => {
      const device = cloneDevice('test-notes-supported', (copy) => {
        copy.media!.notes = { status: 'supported' };
      });
      const decision = decideForDevice(book, device);
      expect(decision.action).toBe('unsupported');
      expect(decision.reasons[0]).toBe('The Test iPod test-notes-supported lists a Notes feature, but OpenTunes does not put text or book files there yet.');
      expect(said(decision)).not.toContain('not confirmed');
      expect(said(decision)).not.toContain('does not list Notes');
      expectPlainReasons(decision);
    });

    it('says the same about a model with no researched limits at all', () => {
      const classic = getDevice('ipod-classic-7g')!;
      expect(classic.media).toBeNull();
      const decision = decideForDevice(book, classic);
      expect(decision.action).toBe('unsupported');
      expect(decision.reasons[0]).toContain('has no Notes or book reader that OpenTunes knows of');
      expect(decision.reasons[0]).not.toContain('description file');
    });

    it('adds a second reason that says there is nothing to convert it to', () => {
      const decision = decideForDevice(info({ fileName: 'book.azw3', container: 'unknown' }), nano);
      expect(decision.reasons[1]).toBe('AZW3 files are e-books or documents, not music or video, so there is nothing to convert them to.');
    });
  });

  it('refuses a file whose container is unknown, and passes on the probe\'s warnings', () => {
    const decision = decideForDevice(info({ fileName: 'mystery.bin', container: 'unknown', audio: { codec: 'mp3', sampleRateHz: 44100, channels: 2, bitrateKbps: 128 }, warnings: ['The file ends early.'] }), nano);
    expect(decision.action).toBe('unsupported');
    expect(decision.conversion).toBeNull();
    expect(decision.outputExtension).toBe('');
    expect(decision.reasons[0]).toBe('OpenTunes could not tell what kind of file this is, so it cannot be put on the iPod.');
    expect(decision.reasons).toContain('The file ends early.');
    expectPlainReasons(decision);
  });

  it('refuses a file with no sound and no picture, and passes on the probe\'s warnings', () => {
    const decision = decideForDevice(info({ fileName: 'empty.mp4', container: 'mp4', warnings: ['The file has no tracks.'] }), nano);
    expect(decision.action).toBe('unsupported');
    expect(decision.reasons[0]).toBe('This file has no sound and no picture that OpenTunes could find, so there is nothing to put on the iPod.');
    expect(decision.reasons).toContain('The file has no tracks.');
    expectPlainReasons(decision);
  });

  it('refuses every model that has no researched limits yet, naming the model', () => {
    const unresearched = devices.filter((device) => device.media === null);
    expect(unresearched.length).toBeGreaterThan(0);
    for (const device of unresearched) {
      for (const file of [audioFile('mp3', { codec: 'mp3' }), videoFile()]) {
        const decision = decideForDevice(file, device);
        expect(decision.action, device.id).toBe('unsupported');
        expect(decision.reasons[0], device.id).toBe(`OpenTunes has not researched what ${device.name} plays yet, so it cannot plan files for it.`);
        expect(decision.conversion).toBeNull();
        expect(decision.outputExtension).toBe('');
      }
    }
  });

  it('gives an unsupported file a kind and no extension', () => {
    const decision = decideForDevice(info({ fileName: 'show.S01E01.epub', container: 'unknown' }), nano);
    expect(decision.kind).toBe('music');
    expect(decision.outputExtension).toBe('');
  });
});
