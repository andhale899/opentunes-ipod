import { describe, expect, it } from 'vitest';
import { normalizeText, songIdentity } from '../src/identity';

describe('songIdentity', () => {
  it('treats a remastered file in another format as the same song', () => {
    const a = songIdentity('Pink Floyd - Time (2011 Remastered Version).mp3');
    const b = songIdentity('Pink Floyd - Time.m4a');
    expect(a.key).toBe(b.key);
  });

  it('ignores featuring credits and video tags', () => {
    const plain = songIdentity('Artist - Song.mp3');
    expect(songIdentity('Artist - Song (feat. Someone).mp3').key).toBe(plain.key);
    expect(songIdentity('Artist - Song [Official Video].mp4').key).toBe(plain.key);
    expect(songIdentity('Artist - Song (Official Music Video).mp4').key).toBe(plain.key);
    expect(songIdentity('Artist - Song (Lyrics).mp3').key).toBe(plain.key);
  });

  it('keeps live, remix and acoustic recordings distinct from the studio track', () => {
    const studio = songIdentity('Artist - Song.mp3').key;
    expect(songIdentity('Artist - Song (Live at Wembley).mp3').key).not.toBe(studio);
    expect(songIdentity('Artist - Song (Remix).mp3').key).not.toBe(studio);
    expect(songIdentity('Artist - Song (Acoustic).mp3').key).not.toBe(studio);
  });

  it('folds accents so tagging differences do not hide duplicates', () => {
    expect(songIdentity('Beyoncé - Halo.mp3').key).toBe(songIdentity('Beyonce - Halo.mp3').key);
  });

  it('keeps titles in non-Latin scripts instead of emptying them', () => {
    const japanese = songIdentity('宇多田ヒカル - First Love.mp3');
    expect(japanese.artist).toBe('宇多田ヒカル');
    expect(japanese.key).not.toBe('');
    const cyrillic = songIdentity('Кино - Группа крови.mp3');
    expect(cyrillic.title).toBe('группа крови');
  });

  it('keeps everything after the first separator as the title', () => {
    const part = songIdentity('Artist - Song - Part 2.mp3');
    expect(part.title).toBe('song part 2');
    expect(part.displayTitle).toBe('Song - Part 2');
  });

  it('falls back to the title alone when there is no artist', () => {
    const id = songIdentity('Untitled Recording.wav');
    expect(id.artist).toBe('');
    expect(id.key).toBe('untitled recording');
  });

  it('does not treat a dot inside a title as an extension', () => {
    expect(songIdentity('Artist - Mr. Brightside.mp3').title).toBe('mr brightside');
  });
});

describe('normalizeText', () => {
  it('lowercases, drops punctuation and collapses spaces', () => {
    expect(normalizeText("  Don't   Stop_Me  Now! ")).toBe('dont stop me now');
  });
});
