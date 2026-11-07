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
