import { describe, expect, it } from 'vitest';
import { isNotMedia } from '../src/addFiles';

describe('leaving out what is not media when a folder is chosen', () => {
  it('drops pictures, playlists, logs and hidden or system files', () => {
    for (const name of ['cover.jpg', 'Folder.PNG', 'album.m3u8', 'rip.log', 'notes.txt', '.DS_Store', '._song.mp3', '~lock.mp3', 'Thumbs.db']) {
      expect(isNotMedia(name), name).toBe(true);
    }
  });

  it('keeps music, audiobooks, podcasts and video, including ones the iPod cannot play yet', () => {
    for (const name of ['song.mp3', 'song.FLAC', 'book.m4b', 'ep.m4a', 'film.mkv', 'clip.webm', 'a.ogg', 'b.opus', 'c.wav', 'd.aif', 'e.wma', 'mixed name (1).mp4']) {
      expect(isNotMedia(name), name).toBe(false);
    }
  });
});

import { limitedByConverter } from '../src/addFiles';
import type { MediaInfo, PlanDecision } from '@opentunes/core';

describe('what the converter cannot read', () => {
  const info = (codec: string) => ({ video: { codec } }) as unknown as MediaInfo;
  const convert: PlanDecision = { action: 'convert', reasons: ['x'], kind: 'movie', conversion: { container: 'm4v', audio: null, video: null, keepChapters: false, keepArtwork: false, keepTags: true }, outputExtension: '.m4v' };

  it('turns a conversion of AV1 into a plain not-supported with the reason', () => {
    const result = limitedByConverter(info('av1'), convert);
    expect(result.action).toBe('unsupported');
    expect(result.conversion).toBeNull();
    expect(result.reasons[0]).toMatch(/AV1/);
  });

  it('leaves other video and plain copies alone', () => {
    expect(limitedByConverter(info('hevc'), convert)).toBe(convert);
    expect(limitedByConverter(info('av1'), { ...convert, action: 'copy', conversion: null })).toMatchObject({ action: 'copy' });
  });
});
