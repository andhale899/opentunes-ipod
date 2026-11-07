import { applyId3, type Id3Data, readId3v1 } from './id3';
import { readAdtsAudio } from './adts';
import { readMpegAudio } from './mpeg';
import type { Reader } from './reader';
import { addWarning, mergeTags, type ProbeState } from './state';

/**
 * An MP3 file: ID3v2 tags (already read by the caller), the ID3v1 tag at the end, and the audio.
 * `audioStart` is where the audio should begin, just after the ID3v2 tags.
 */
export async function probeMp3(r: Reader, state: ProbeState, audioStart: number, id3: Id3Data | null): Promise<void> {
  state.container = 'mp3';
  applyId3(state, id3);
  const v1 = await readId3v1(r);
  if (v1) mergeTags(state.tags, v1);
  const audioEnd = v1 ? r.size - 128 : r.size;

  const found = await readMpegAudio(r, state, audioStart, audioEnd);
  if (!found) {
    if (!id3 && !v1) state.container = 'unknown';
    addWarning(state, id3 || v1 ? 'No MP3 audio was found after the tags, so the file may be cut short or damaged.' : 'This file was not recognised as audio or video.');
  }
}

/** An AAC file in ADTS frames, with optional ID3v2 tags in front. */
export async function probeAdts(r: Reader, state: ProbeState, audioStart: number, id3: Id3Data | null): Promise<void> {
  state.container = 'aac';
  applyId3(state, id3);
  const v1 = await readId3v1(r);
  if (v1) mergeTags(state.tags, v1);
  const audioEnd = v1 ? r.size - 128 : r.size;
  const found = await readAdtsAudio(r, state, audioStart, audioEnd);
  if (!found) addWarning(state, 'No AAC audio frames were found, so the file may be cut short or damaged.');
}
