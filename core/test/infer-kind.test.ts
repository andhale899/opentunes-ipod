import { describe, expect, it } from 'vitest';
import { inferKind } from '../src/index';
import type { ContentKind, MediaInfo, MediaTags } from '../src/media/types';
import { audioFile, info, videoFile } from './media-fixtures';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function song(tags: MediaTags = {}, file: Partial<MediaInfo> = {}): MediaInfo {
  return audioFile('mp3', { codec: 'mp3' }, { tags, ...file });
}

function clip(tags: MediaTags = {}, file: Partial<MediaInfo> = {}): MediaInfo {
  return videoFile({}, {}, { tags, ...file });
}

describe('inferKind priority order', () => {
  it('uses the person\'s choice over everything else', () => {
    const file = song({ declaredKind: 'audiobook', genre: 'Podcast', podcastCategory: 'News' }, { container: 'm4b' });
    expect(inferKind(file, { userKind: 'music' })).toBe('music');
    expect(inferKind(clip({ show: 'A Show', declaredKind: 'movie' }), { userKind: 'music-video' })).toBe('music-video');
  });

  it('uses what the file declares over the evidence', () => {
    expect(inferKind(song({ declaredKind: 'podcast', genre: 'Audiobook' }))).toBe('podcast');
    expect(inferKind(clip({ declaredKind: 'movie', show: 'A Show' }))).toBe('movie');
    expect(inferKind(song({ declaredKind: 'music' }, { container: 'm4b' }))).toBe('music');
  });

  it('falls through to the evidence when neither is given', () => {
    expect(inferKind(song({ genre: 'Audiobook' }))).toBe('audiobook');
  });

  it('takes the first matching evidence rule: audiobook, then podcast, then TV, then music video, then movie', () => {
    // audiobook beats podcast
    expect(inferKind(song({ genre: 'Audiobook', podcastCategory: 'Books' }))).toBe('audiobook');
    // podcast beats TV
    expect(inferKind(clip({ podcastCategory: 'TV', show: 'A Show' }))).toBe('video-podcast');
    // TV beats music video
    expect(inferKind(clip({ show: 'A Show', artist: 'Someone', album: 'Something' }, { durationMs: 3 * MINUTE }))).toBe('tv-show');
    // music video beats movie
    expect(inferKind(clip({ artist: 'Someone', album: 'Something' }, { durationMs: 3 * MINUTE }))).toBe('music-video');
  });
});

describe('inferKind: audiobook signals (audio only)', () => {
  const cases: Array<[string, MediaInfo, ContentKind]> = [
    ['an m4b container', audioFile('m4b', { codec: 'aac' }), 'audiobook'],
    ['genre "Audiobook"', song({ genre: 'Audiobook' }), 'audiobook'],
    ['genre "audiobooks" in any case with spaces', song({ genre: '  AudioBooks ' }), 'audiobook'],
    ['genre "Audio Book"', song({ genre: 'audio book' }), 'audiobook'],
    ['spoken word with chapters', song({ genre: 'Spoken Word' }, { chapters: [{ startMs: 0, title: 'One' }], durationMs: 20 * MINUTE }), 'audiobook'],
    ['spoken with chapters', song({ genre: 'Spoken' }, { chapters: [{ startMs: 0, title: 'One' }], durationMs: 20 * MINUTE }), 'audiobook'],
    ['spoken word over an hour, no chapters', song({ genre: 'Spoken Word' }, { durationMs: HOUR + 1 }), 'audiobook'],
    ['spoken over an hour and with chapters', song({ genre: 'Spoken' }, { durationMs: 5 * HOUR, chapters: [{ startMs: 0, title: 'A' }, { startMs: 9, title: 'B' }] }), 'audiobook'],
  ];
  it.each(cases)('%s is an audiobook', (_name, file, expected) => {
    expect(inferKind(file)).toBe(expected);
  });

  const notAudiobooks: Array<[string, MediaInfo]> = [
    ['a short spoken word track with no chapters (a poem on an album)', song({ genre: 'Spoken Word' }, { durationMs: 3 * MINUTE })],
    ['a spoken word track of exactly an hour with no chapters', song({ genre: 'Spoken' }, { durationMs: HOUR })],
    ['a spoken word track with no length and no chapters', song({ genre: 'Spoken' }, { durationMs: null })],
    ['a long chaptered file with a music genre (a DJ mix)', song({ genre: 'House' }, { durationMs: 2 * HOUR, chapters: [{ startMs: 0, title: 'Mix' }] })],
    ['a long file with no genre', song({}, { durationMs: 3 * HOUR })],
    ['a video with the Audiobook genre', clip({ genre: 'Audiobook' })],
    ['a video in the m4b container', clip({}, { container: 'm4b' })],
  ];
  it.each(notAudiobooks)('%s is not an audiobook', (_name, file) => {
    expect(inferKind(file)).not.toBe('audiobook');
  });
});

describe('inferKind: podcast signals', () => {
  const audioCases: Array<[string, MediaTags]> = [
    ['genre "Podcast"', { genre: 'Podcast' }],
    ['genre "podcasts" in any case', { genre: ' PODCASTS ' }],
    ['a podcast category', { podcastCategory: 'Technology' }],
    ['a feed address', { podcastFeedUrl: 'https://example.invalid/feed.xml' }],
    ['an episode address', { podcastEpisodeUrl: 'https://example.invalid/ep1.mp3' }],
  ];
  it.each(audioCases)('%s makes an audio file a podcast', (_name, tags) => {
    expect(inferKind(song(tags))).toBe('podcast');
  });
  it.each(audioCases)('%s makes a video a video podcast', (_name, tags) => {
    expect(inferKind(clip(tags))).toBe('video-podcast');
  });

  it('ignores empty podcast fields', () => {
    expect(inferKind(song({ podcastCategory: '  ', podcastFeedUrl: '' }))).toBe('music');
  });
});

describe('inferKind: TV signals (video only)', () => {
  const tagCases: Array<[string, MediaTags]> = [
    ['a show name', { show: 'The Show' }],
    ['a season number', { season: 2 }],
    ['season zero (specials)', { season: 0 }],
    ['an episode number', { episode: 5 }],
    ['an episode id', { episodeId: 'S02E05' }],
  ];
  it.each(tagCases)('%s makes a video a TV show', (_name, tags) => {
    expect(inferKind(clip(tags))).toBe('tv-show');
  });

  const nameCases: Array<[string, boolean]> = [
    ['Show.S02E05.720p.mkv', true],
    ['show s02e05.mp4', true],
    ['S2E5.avi', true],
    ['The_Show-S10E123-final.m4v', true],
    ['classes1e2.mp4', false],
    ['S02E05extra.mp4', false],
    ['Season 2 Episode 5.mp4', false],
    ['holiday.mp4', false],
  ];
  it.each(nameCases)('file name %s is a TV show: %s', (fileName, isTv) => {
    expect(inferKind(clip({}, { fileName })) === 'tv-show').toBe(isTv);
  });

  it('prefers hints.fileName over info.fileName', () => {
    const file = clip({}, { fileName: 'holiday.mp4' });
    expect(inferKind(file)).toBe('movie');
    expect(inferKind(file, { fileName: 'Show.S01E01.mp4' })).toBe('tv-show');
    expect(inferKind(clip({}, { fileName: 'Show.S01E01.mp4' }), { fileName: 'holiday.mp4' })).toBe('movie');
  });

  it('does not call an audio file a TV show', () => {
    expect(inferKind(song({ show: 'The Show', season: 1, episode: 1 }, { fileName: 'Show.S01E01.mp3' }))).toBe('music');
  });
});

describe('inferKind: music video, movie and music', () => {
  it('needs artist and album and a known length under 12 minutes', () => {
    const tags = { artist: 'Someone', album: 'Something' };
    expect(inferKind(clip(tags, { durationMs: 3 * MINUTE }))).toBe('music-video');
    expect(inferKind(clip(tags, { durationMs: 12 * MINUTE - 1 }))).toBe('music-video');
    expect(inferKind(clip(tags, { durationMs: 12 * MINUTE }))).toBe('movie');
    expect(inferKind(clip(tags, { durationMs: 90 * MINUTE }))).toBe('movie');
    expect(inferKind(clip(tags, { durationMs: null }))).toBe('movie');
    expect(inferKind(clip({ artist: 'Someone' }, { durationMs: 3 * MINUTE }))).toBe('movie');
    expect(inferKind(clip({ album: 'Something' }, { durationMs: 3 * MINUTE }))).toBe('movie');
    expect(inferKind(clip({ artist: ' ', album: 'Something' }, { durationMs: 3 * MINUTE }))).toBe('movie');
  });

  it('calls other video a movie', () => {
    expect(inferKind(clip())).toBe('movie');
    expect(inferKind(clip({ genre: 'Drama', title: 'A Film' }, { durationMs: 100 * MINUTE }))).toBe('movie');
  });

  it('calls everything else music', () => {
    expect(inferKind(song())).toBe('music');
    expect(inferKind(song({ genre: 'Rock', artist: 'A', album: 'B' }))).toBe('music');
    expect(inferKind(info())).toBe('music');
  });
});
