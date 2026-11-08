import { describe, expect, it } from 'vitest';
import { guessFromFolders, kindOfFolderName, mergeMissingTags } from '../src/folderRules';

describe('what a folder name stands for', () => {
  it('knows every name and alias, in any case and spelling of the gaps', () => {
    const names: [string, string][] = [
      ['Music', 'music'], ['SONGS', 'music'], ['songs', 'music'],
      ['Audiobooks', 'audiobook'], ['Audio Books', 'audiobook'], ['audio_books', 'audiobook'], ['Books', 'audiobook'],
      ['Podcasts', 'podcast'], ['podcast', 'podcast'],
      ['Movies', 'movie'], ['Films', 'movie'], ['film', 'movie'],
      ['TV Shows', 'tv-show'], ['tv-shows', 'tv-show'], ['TV', 'tv-show'], ['Series', 'tv-show'], ['Shows', 'tv-show'],
      ['Music Videos', 'music-video'], ['music_videos', 'music-video'], ['MUSIC VIDEO', 'music-video'],
    ];
    for (const [name, kind] of names) expect(kindOfFolderName(name), name).toBe(kind);
  });

  it('does not take other names for a kind', () => {
    for (const name of ['Rock', 'Album', 'Season 1', 'Musical', 'Videos', 'My Music Collection', '']) {
      expect(kindOfFolderName(name), name).toBeUndefined();
    }
  });
});

describe('the kind from the folders', () => {
  it('is undefined when no folder has a known name', () => {
    expect(guessFromFolders(['testmedia', 'Album'], '01 First.wav').kind).toBeUndefined();
    expect(guessFromFolders(['testmedia', 'Album'], '01 First.wav').tags).toEqual({});
  });

  it('lets the chosen folder itself decide', () => {
    expect(guessFromFolders(['Audiobooks', 'Some Author', 'Some Book'], '01 Opening.mp3').kind).toBe('audiobook');
    expect(guessFromFolders(['tv shows', 'Show', 'Season 1'], 'S01E01.mp4').kind).toBe('tv-show');
  });

  it('finds a category folder further down when the chosen folder is something else', () => {
    const guess = guessFromFolders(['My stuff', 'Podcasts', 'The Cast'], '2026-01-05 Pilot.mp3');
    expect(guess.kind).toBe('podcast');
    expect(guess.tags.album).toBe('The Cast');
  });

  it('uses the outermost known folder, so an artist called Books inside Music stays music', () => {
    const guess = guessFromFolders(['Music', 'Books', 'Some Album'], '01 Song.mp3');
    expect(guess.kind).toBe('music');
    expect(guess.tags).toMatchObject({ artist: 'Books', album: 'Some Album', trackNumber: 1, title: 'Song' });
  });
});

describe('audiobooks', () => {
  it('reads author and book from the folders and the chapter number from the name', () => {
    const guess = guessFromFolders(['Audiobooks', 'Ursula Le Guin', 'A Wizard of Earthsea'], '03 - Chapter Three.mp3');
    expect(guess.kind).toBe('audiobook');
    expect(guess.tags).toEqual({ artist: 'Ursula Le Guin', album: 'A Wizard of Earthsea', trackNumber: 3, title: 'Chapter Three' });
  });

  it('takes the folder as the book when there is only one level, and leaves the author alone', () => {
    const guess = guessFromFolders(['Audio Books', 'Some Book'], '01.mp3');
    expect(guess.tags).toEqual({ album: 'Some Book' });
  });

  it('works for one m4b with no number', () => {
    const guess = guessFromFolders(['Audiobooks', 'An Author', 'The Book'], 'The Book.m4b');
    expect(guess.tags).toEqual({ artist: 'An Author', album: 'The Book' });
  });

  it('reads a disc folder as the disc, not as the book', () => {
    const guess = guessFromFolders(['Audiobooks', 'An Author', 'The Book', 'Disc 2'], '04 Part.mp3');
    expect(guess.tags).toMatchObject({ artist: 'An Author', album: 'The Book', discNumber: 2, trackNumber: 4 });
  });

  it('fills only what the file lacks', () => {
    const existing = { album: 'Tagged Album', trackNumber: 9 };
    const guess = guessFromFolders(['Audiobooks', 'An Author', 'The Book'], '01 Opening.mp3', existing);
    expect(guess.tags).toEqual({ artist: 'An Author', title: 'Opening' });
  });

  it('does not take a year for a track number', () => {
    expect(guessFromFolders(['Audiobooks', 'A', 'B'], '1984 - Opening.mp3').tags.trackNumber).toBeUndefined();
    expect(guessFromFolders(['Audiobooks', 'A', 'B'], '1984.mp3').tags.trackNumber).toBeUndefined();
  });
});

describe('music', () => {
  it('reads artist, album and track from Music/Artist/Album/01 Title', () => {
    const guess = guessFromFolders(['Music', 'The Band', 'The Record'], '07 Some Song.mp3');
    expect(guess.tags).toEqual({ artist: 'The Band', album: 'The Record', trackNumber: 7, title: 'Some Song' });
  });

  it('guesses no artist from a single folder, which could be either', () => {
    expect(guessFromFolders(['Music', 'Somebody'], 'Song.mp3').tags).toEqual({});
  });

  it('leaves a name with no number alone, so the file name stays the title', () => {
    expect(guessFromFolders(['Music', 'A', 'B'], 'Song.mp3').tags).toEqual({ artist: 'A', album: 'B' });
  });
});

describe('podcasts', () => {
  it('takes the show folder as the show and album, and the date out of the title', () => {
    const guess = guessFromFolders(['Podcasts', 'Show Name'], '2026-01-05 Episode.mp3');
    expect(guess.kind).toBe('podcast');
    expect(guess.tags).toEqual({ album: 'Show Name', year: 2026, title: 'Episode' });
  });

  it('keeps an undated name as it is', () => {
    expect(guessFromFolders(['Podcasts', 'Show Name'], 'Episode 12.mp3').tags).toEqual({ album: 'Show Name' });
  });

  it('works when the chosen folder is the show itself under Podcasts', () => {
    expect(guessFromFolders(['Podcasts', 'Show Name'], '2025-12-31 - Last one.mp3').tags.title).toBe('Last one');
  });
});

describe('TV shows', () => {
  it('reads show, season and episode from the folders and S01E02', () => {
    const guess = guessFromFolders(['TV Shows', 'Show Name', 'Season 1'], 'S01E02 Title.mp4');
    expect(guess.kind).toBe('tv-show');
    expect(guess.tags).toEqual({ show: 'Show Name', season: 1, episode: 2, episodeId: 'S01E02', title: 'Title' });
  });

  it('reads the 1x02 form', () => {
    const guess = guessFromFolders(['TV', 'Show Name', 'Season 03'], 'Show Name - 3x14 - The One.mp4');
    expect(guess.tags).toEqual({ show: 'Show Name', season: 3, episode: 14, episodeId: 'S03E14', title: 'The One' });
  });

  it('takes the season from the folder when the name has only an episode number or none', () => {
    const guess = guessFromFolders(['Series', 'Show Name', 'Season 2'], 'Pilot.mp4');
    expect(guess.tags).toEqual({ show: 'Show Name', season: 2 });
  });

  it('lets the file name win over the folder for the season', () => {
    expect(guessFromFolders(['TV Shows', 'Show Name', 'Season 1'], 'S02E05.mp4').tags).toMatchObject({ season: 2, episode: 5 });
  });

  it('reads the chosen folder being the show and the season folder being the top', () => {
    expect(guessFromFolders(['TV Shows', 'Season 4'], 'S04E01.mp4').tags).toEqual({ season: 4, episode: 1, episodeId: 'S04E01' });
  });

  it('keeps season 0 for specials', () => {
    const guess = guessFromFolders(['TV Shows', 'Show Name', 'Specials'], 'S00E01 Christmas.mp4');
    expect(guess.tags).toMatchObject({ show: 'Show Name', season: 0, episode: 1 });
  });

  it('does not take letters around the pattern for an episode', () => {
    expect(guessFromFolders(['TV Shows', 'Show'], 'classes1e2x.mp4').tags).toEqual({ show: 'Show' });
  });

  it('fills only what the file lacks', () => {
    const guess = guessFromFolders(['TV Shows', 'Show Name', 'Season 1'], 'S01E02 Title.mp4', { show: 'Tagged Show', season: 1 });
    expect(guess.tags).toEqual({ episode: 2, episodeId: 'S01E02', title: 'Title' });
  });

  it('reads S01E02 in a video even with no folder name to go by, and not in other files', () => {
    expect(guessFromFolders(['Downloads'], 'show.S02E03.mkv', {}, { hasVideo: true }).tags).toEqual({ season: 2, episode: 3, episodeId: 'S02E03' });
    expect(guessFromFolders(['Downloads'], 'show.S02E03.mp3', {}, { hasVideo: false }).tags).toEqual({});
    expect(guessFromFolders(['Downloads'], 'Show 2x03.mkv', {}, { hasVideo: true }).tags).toEqual({});
  });
});

describe('movies and music videos', () => {
  it('reads Title (Year)', () => {
    const guess = guessFromFolders(['Movies'], 'The Film (1999).mp4');
    expect(guess.kind).toBe('movie');
    expect(guess.tags).toEqual({ title: 'The Film', year: 1999 });
  });

  it('leaves a name with no year alone', () => {
    expect(guessFromFolders(['Films'], 'The Film.mp4').tags).toEqual({});
  });

  it('takes the artist folder for a music video', () => {
    const guess = guessFromFolders(['Music Videos', 'The Band'], 'The Song.mp4');
    expect(guess.kind).toBe('music-video');
    expect(guess.tags).toEqual({ artist: 'The Band' });
  });
});

describe('merging', () => {
  it('adds only what is missing, so the tags in the file win', () => {
    const merged = mergeMissingTags({ album: 'In The File', artist: '  ', trackNumber: 0 }, { album: 'From Folder', artist: 'Folder Artist', trackNumber: 4, title: 'T' });
    expect(merged.tags).toEqual({ album: 'In The File', artist: 'Folder Artist', trackNumber: 4, title: 'T' });
    expect(merged.filled.sort()).toEqual(['artist', 'title', 'trackNumber']);
  });

  it('counts a season of 0 as a season the file has', () => {
    expect(mergeMissingTags({ season: 0 }, { season: 2 }).tags.season).toBe(0);
    expect(mergeMissingTags({}, { season: 0 }).tags.season).toBe(0);
  });
});
