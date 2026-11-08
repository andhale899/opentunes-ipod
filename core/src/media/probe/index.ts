import type { FileSource, MediaInfo } from '../types';
import { fourcc, startsWithAscii, u32be } from './bytes';
import { probeAiff } from './aiff';
import { asfHeaderStartsAt, probeAsf } from './asf';
import { probeAvi } from './avi';
import { probeFlac } from './flac';
import { combineId3, type Id3Data, skipId3v2Tags } from './id3';
import { probeMatroska } from './matroska';
import { probeMp3, probeAdts } from './mp3';
import { probeMp4 } from './mp4';
import { probeOgg } from './ogg';
import { Reader } from './reader';
import { addWarning, createState, finalize, type ProbeState } from './state';
import { probeWav } from './wav';

/** The largest cover picture that is read, from inside a file or chosen by the person. */
export { MAX_ARTWORK_BYTES } from './image';

/**
 * Reads what a media file says about itself: container, codecs, length, tags, chapters, cover art.
 *
 * It reads the file in pieces through `source.slice` and never loads a large file whole. It does
 * not throw for a damaged, truncated or unknown file: the result then has container "unknown" or
 * whatever could be read, and `warnings` says what went wrong in plain sentences.
 *
 * It decides the format from the bytes, not from the file name.
 */
export async function probeMedia(source: FileSource): Promise<MediaInfo> {
  const state = createState();
  let fileName = '';
  let sizeBytes = 0;
  try {
    fileName = typeof source.name === 'string' ? source.name : '';
    sizeBytes = Number.isFinite(source.size) && source.size > 0 ? Math.floor(source.size) : 0;
  } catch {
    // A source whose properties throw still gets a result.
  }
  try {
    const reader = new Reader(source, (message) => addWarning(state, message));
    await probeInto(reader, state);
  } catch {
    addWarning(state, 'Reading stopped early because the file looks damaged.');
  }
  return finalize(state, fileName, sizeBytes);
}

/** Runs one format reader. A reader that fails keeps whatever it had already filled in. */
async function guarded(state: ProbeState, name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    addWarning(state, `Reading the ${name} data stopped early because the file looks damaged, so the information may be incomplete.`);
  }
}

/** Box types a QuickTime file (no ftyp box) can start with. */
const QUICKTIME_FIRST_BOXES = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

async function probeInto(r: Reader, state: ProbeState): Promise<void> {
  if (r.size === 0) {
    addWarning(state, 'The file is empty.');
    return;
  }

  // ID3v2 tags can sit in front of MP3, AAC and some FLAC files, so they are read first.
  let audioStart = 0;
  let id3: Id3Data | null = null;
  if (startsWithAscii(await r.read(0, 3), 'ID3')) {
    const skipped = await skipId3v2Tags(r, 0, (message) => addWarning(state, message));
    audioStart = skipped.audioStart;
    id3 = combineId3(skipped.tags);
  }

  const sig = await r.read(audioStart, 32);
  const b0 = sig[0] ?? 0;
  const b1 = sig[1] ?? 0;

  if (startsWithAscii(sig, 'fLaC')) {
    await guarded(state, 'FLAC', () => probeFlac(r, state, audioStart, id3));
    return;
  }
  if (audioStart === 0) {
    if (startsWithAscii(sig, 'OggS')) {
      await guarded(state, 'Ogg', () => probeOgg(r, state));
      return;
    }
    if ((startsWithAscii(sig, 'RIFF') || startsWithAscii(sig, 'RF64') || startsWithAscii(sig, 'BW64')) && startsWithAscii(sig, 'WAVE', 8)) {
      await guarded(state, 'WAV', () => probeWav(r, state, !startsWithAscii(sig, 'RIFF')));
      return;
    }
    if (startsWithAscii(sig, 'RIFF') && startsWithAscii(sig, 'AVI ', 8)) {
      await guarded(state, 'AVI', () => probeAvi(r, state));
      return;
    }
    if (startsWithAscii(sig, 'FORM') && (startsWithAscii(sig, 'AIFF', 8) || startsWithAscii(sig, 'AIFC', 8))) {
      await guarded(state, 'AIFF', () => probeAiff(r, state, startsWithAscii(sig, 'AIFC', 8)));
      return;
    }
    if (fourcc(sig, 4) === 'ftyp') {
      await guarded(state, 'MP4', () => probeMp4(r, state, true));
      return;
    }
    const size = u32be(sig, 0);
    if (QUICKTIME_FIRST_BOXES.has(fourcc(sig, 4)) && (size >= 8 || size === 0 || size === 1)) {
      await guarded(state, 'QuickTime', () => probeMp4(r, state, false));
      return;
    }
    if (b0 === 0x1a && b1 === 0x45 && sig[2] === 0xdf && sig[3] === 0xa3) {
      await guarded(state, 'Matroska', () => probeMatroska(r, state));
      return;
    }
    if (asfHeaderStartsAt(sig)) {
      await guarded(state, 'ASF', () => probeAsf(r, state));
      return;
    }
  }
  if (b0 === 0xff && (b1 & 0xf6) === 0xf0) {
    await guarded(state, 'AAC', () => probeAdts(r, state, audioStart, id3));
    return;
  }
  // Anything else, including a file that starts with junk, gets one try as MP3. It becomes "unknown" if no audio is found.
  await guarded(state, 'MP3', () => probeMp3(r, state, audioStart, id3));
}
