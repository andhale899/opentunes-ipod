import { concatBytes, i32le, startsWithAscii, u16le, u32le, u64le } from './bytes';
import { MAX_ARTWORK_BYTES } from './image';
import type { Reader } from './reader';
import { addWarning, type ProbeState } from './state';
import { parseStreamInfo } from './flac';
import { applyVorbisFields, artworkFromPicture, bestPicture, parseVorbisComments } from './vorbis';

/**
 * Ogg: Vorbis, Opus and FLAC in Ogg. The first pages name the codec and hold the tags, and the
 * length comes from the granule position of the last page, so the end of the file is read too.
 */

interface OggPage {
  offset: number;
  headerType: number;
  /** Null for the "no packet ends on this page" marker. */
  granule: number | null;
  serial: number;
  headerLength: number;
  lacing: number[];
  bodyLength: number;
  end: number;
}

async function readPage(r: Reader, pos: number): Promise<OggPage | null> {
  const h = await r.read(pos, 27);
  if (h.length < 27 || !startsWithAscii(h, 'OggS') || h[4] !== 0) return null;
  const segments = h[26] ?? 0;
  const table = segments > 0 ? await r.read(pos + 27, segments) : new Uint8Array(0);
  if (table.length < segments) return null;
  const lacing = Array.from(table);
  const bodyLength = lacing.reduce((sum, n) => sum + n, 0);
  const noGranule = u32le(h, 10) === 0xffffffff && u32le(h, 6) === 0xffffffff;
  return {
    offset: pos,
    headerType: h[5] ?? 0,
    granule: noGranule ? null : u64le(h, 6),
    serial: u32le(h, 14),
    headerLength: 27 + segments,
    lacing,
    bodyLength,
    end: pos + 27 + segments + bodyLength,
  };
}

type StreamKind = 'vorbis' | 'opus' | 'flac';

function kindOfFirstPacket(p: Uint8Array): StreamKind | null {
  if (startsWithAscii(p, 'OpusHead')) return 'opus';
  if (p[0] === 0x01 && startsWithAscii(p, 'vorbis', 1)) return 'vorbis';
  if (p[0] === 0x7f && startsWithAscii(p, 'FLAC', 1)) return 'flac';
  return null;
}

/** The first `want` packets of one logical stream, put back together from their pages. */
async function readPackets(r: Reader, serial: number, want: number): Promise<Uint8Array[]> {
  const packets: Uint8Array[] = [];
  let partial: Uint8Array[] = [];
  let total = 0;
  let pos = 0;
  for (let pages = 0; pages < 20000 && packets.length < want; pages += 1) {
    const page = await readPage(r, pos);
    if (!page) break;
    if (page.serial === serial) {
      const body = await r.read(page.offset + page.headerLength, page.bodyLength);
      total += body.length;
      if (total > 40 * 1024 * 1024) break;
      let at = 0;
      for (const lace of page.lacing) {
        partial.push(body.subarray(at, at + lace));
        at += lace;
        if (lace < 255) {
          packets.push(concatBytes(partial));
          partial = [];
          if (packets.length >= want) break;
        }
      }
    }
    pos = page.end;
  }
  return packets;
}

/** The granule position of the last page of a stream, found by looking at the end of the file. */
async function lastGranule(r: Reader, serial: number): Promise<number | null> {
  const tailLength = Math.min(r.size, 256 * 1024);
  const tail = await r.read(r.size - tailLength, tailLength);
  for (let i = tail.length - 27; i >= 0; i -= 1) {
    if (tail[i] !== 0x4f || !startsWithAscii(tail, 'OggS', i) || tail[i + 4] !== 0) continue;
    const segments = tail[i + 26] ?? 0;
    if (i + 27 + segments > tail.length) continue;
    let body = 0;
    for (let s = 0; s < segments; s += 1) body += tail[i + 27 + s] ?? 0;
    if (i + 27 + segments + body > tail.length) continue; // a page cut off by the end of the file
    if (u32le(tail, i + 14) !== serial) continue;
    if (u32le(tail, i + 6) === 0xffffffff && u32le(tail, i + 10) === 0xffffffff) continue;
    return u64le(tail, i + 6);
  }
  return null;
}

export async function probeOgg(r: Reader, state: ProbeState): Promise<void> {
  state.container = 'ogg';

  // The first pages of every stream come first. Find the first one that is audio we know.
  let pos = 0;
  let serial: number | null = null;
  let kind: StreamKind | null = null;
  let firstPacket: Uint8Array = new Uint8Array(0);
  let sawOther = false;
  for (let i = 0; i < 16; i += 1) {
    const page = await readPage(r, pos);
    if (!page) break;
    if ((page.headerType & 2) === 0) break; // beginning-of-stream pages are over
    const body = await r.read(page.offset + page.headerLength, Math.min(page.bodyLength, 64));
    const found = kindOfFirstPacket(body);
    if (found) {
      serial = page.serial;
      kind = found;
      firstPacket = body;
      break;
    }
    sawOther = true;
    pos = page.end;
  }
  if (serial === null || kind === null) {
    addWarning(state, sawOther ? 'This Ogg file holds a stream type that is not Vorbis, Opus or FLAC, so its audio details are unknown.' : 'The Ogg file has no readable first page, so it is probably damaged.');
    return;
  }

  const packets = await readPackets(r, serial, 2);
  const head = packets[0] ?? firstPacket;
  const comments = packets[1];
  let preSkip = 0;
  let nominalBitrateKbps: number | null = null;
  let durationFromStreamInfo: number | null = null;

  if (kind === 'opus') {
    state.container = 'opus';
    preSkip = u16le(head, 10);
    state.audio = { codec: 'opus', sampleRateHz: 48000, channels: head[9] ?? 2, bitrateKbps: null, variableBitrate: true };
  } else if (kind === 'vorbis') {
    const nominal = i32le(head, 20);
    nominalBitrateKbps = nominal > 0 ? Math.round(nominal / 1000) : null;
    state.audio = { codec: 'vorbis', sampleRateHz: u32le(head, 12), channels: head[11] ?? 2, bitrateKbps: nominalBitrateKbps, variableBitrate: true };
  } else {
    // FLAC in Ogg: a mapping header, then the "fLaC" marker, a block header and STREAMINFO.
    const info = parseStreamInfo(head, 17);
    if (info.sampleRateHz > 0) {
      state.audio = { codec: 'flac', sampleRateHz: info.sampleRateHz, channels: info.channels, bitrateKbps: null, bitDepth: info.bitDepth };
      if (info.totalSamples > 0) durationFromStreamInfo = (info.totalSamples * 1000) / info.sampleRateHz;
    }
  }

  if (!state.audio || state.audio.sampleRateHz <= 0) {
    addWarning(state, 'The Ogg identification header has no sample rate, so the audio details are unknown.');
  }

  if (comments) {
    const start = kind === 'opus' ? (startsWithAscii(comments, 'OpusTags') ? 8 : -1) : kind === 'vorbis' ? (comments[0] === 3 && startsWithAscii(comments, 'vorbis', 1) ? 7 : -1) : 4;
    if (start >= 0) {
      const pictures = applyVorbisFields(state, parseVorbisComments(comments, start));
      const best = bestPicture(pictures);
      if (best && best.data.length > MAX_ARTWORK_BYTES) addWarning(state, 'The cover picture is too large to read, so it was skipped.');
      else state.artwork = artworkFromPicture(state, best);
    } else {
      addWarning(state, 'The Ogg comment header is not where it should be, so the tags were not read.');
    }
  } else {
    addWarning(state, 'The Ogg file ends before its comment header, so it has no tags.');
  }

  // The length is where the last page says the audio ends.
  const audio = state.audio;
  if (audio && audio.sampleRateHz > 0) {
    const granule = await lastGranule(r, serial);
    if (granule !== null && granule > 0) {
      const samples = kind === 'opus' ? Math.max(0, granule - preSkip) : granule;
      state.durationMs = (samples * 1000) / audio.sampleRateHz;
    } else if (durationFromStreamInfo !== null) {
      state.durationMs = durationFromStreamInfo;
    } else {
      addWarning(state, 'The length of this Ogg file could not be found, because its last page is missing or damaged.');
    }
    if (audio.bitrateKbps === null && state.durationMs && state.durationMs > 0) {
      audio.bitrateKbps = Math.round((r.size * 8) / state.durationMs);
    }
  }
}
