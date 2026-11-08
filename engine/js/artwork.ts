/**
 * Album art for a nano 7G: the thumbnails, the ArtworkDB, and writing them to the iPod.
 *
 * Why this is not libgpod: libgpod needs gdk-pixbuf to write artwork, and the ArtworkDB it
 * writes differs from the one a nano 7G has in several ways (docs/ARTWORK-RESEARCH.md, section
 * 2). This file writes the file the owner's own unit holds, shaped field by field like it:
 *
 * - Four thumbnails per image: format 1010 (240 x 240), 1013 (50), 1015 (58) and 1016 (57), in
 *   RGB565 little endian, each row widened to a multiple of 4 bytes with zero bytes.
 * - Appended to iPod_Control/Artwork/F<format>_1.ithmb at the file's current size.
 * - One mhii record per image in the ArtworkDB, added after the ones already there, which are
 *   left exactly as they are. Only the counts, the lengths and the next id change.
 *
 * What is not covered by any real file, and is therefore refused or flagged rather than guessed:
 * a second .ithmb file per format (a writer stops at the declared size limit), an ArtworkDB that
 * does not look like the one described (it is left alone), and removing art (an image stays in
 * the file when its track goes). A new ArtworkDB on an iPod that has none is made, flagged in
 * the plan, because the two random ids at the top of the file are unexplained.
 *
 * Pure parts (rendering, the ArtworkDB bytes) come first; the part that reads and writes the
 * iPod follows. Written in erasable-only TypeScript so Node can run it directly.
 */

import { fileAt, messageOf, readFrom, same, writeTo, type IpodRoot, type Touched } from './ipod-files.ts';

export class ArtworkError extends Error {}

// ------------------------------------------------------------------ formats

/** One thumbnail format: what the iPod stores, and how many bytes one thumbnail takes. */
export interface CoverFormat {
  id: number;
  width: number;
  height: number;
  /** Bytes in one row, widened to a multiple of 4 (the rows of the 57 pixel format take 116). */
  rowBytes: number;
  /** Bytes one thumbnail takes in its file: `rowBytes * height`. */
  slotBytes: number;
}

function coverFormat(id: number, size: number): CoverFormat {
  const rowBytes = Math.ceil((size * 2) / 4) * 4;
  return { id, width: size, height: size, rowBytes, slotBytes: rowBytes * size };
}

/**
 * The four formats the owner's nano 7G has art in, in the order its ArtworkDB lists them. The
 * device file declares a fifth, 1011, that its own ArtworkDB does not use. Slots: 115,200,
 * 5,000, 6,728 and 6,612 bytes, the same sizes as the owner's .ithmb files.
 */
export const COVER_FORMATS: readonly CoverFormat[] = [coverFormat(1010, 240), coverFormat(1013, 50), coverFormat(1015, 58), coverFormat(1016, 57)];

export const ARTWORK_FOLDER = 'iPod_Control/Artwork';
export const ARTWORK_DB_PATH = `${ARTWORK_FOLDER}/ArtworkDB`;
/** The thumbnail file of a format, from the iPod's top folder. */
export const thumbFilePath = (formatId: number): string => `${ARTWORK_FOLDER}/F${formatId}_1.ithmb`;
/** The only files an artwork write may touch. */
export const ARTWORK_FILE_PATH = /^iPod_Control\/Artwork\/(ArtworkDB|F(1010|1013|1015|1016)_1\.ithmb)$/;

/** MaxThumbFileSize in the device file is 50. Read as megabytes of 1,000,000 bytes, the smaller reading. */
export const DEFAULT_MAX_THUMB_FILE_BYTES = 50 * 1000 * 1000;

/** Image ids start at 100 in the owner's file and in libgpod. */
export const FIRST_IMAGE_ID = 100;

// ------------------------------------------------------------ the device file

export interface CoverSupport {
  ok: boolean;
  /** Why not, when it is not. */
  reason: string | null;
  maxThumbFileBytes: number;
}

type PlistValue = string | number | boolean;

/** The dictionaries of one array in a plist, read without a plist library. Flat dictionaries only. */
function plistDictionaries(xml: string, key: string): Record<string, PlistValue>[] | null {
  const at = xml.indexOf(`<key>${key}</key>`);
  if (at < 0) return null;
  const open = xml.indexOf('<array>', at);
  const close = xml.indexOf('</array>', open);
  const between = xml.slice(at + key.length + 11, open);
  if (open < 0 || close < 0 || between.trim() !== '') return null;
  const dictionaries: Record<string, PlistValue>[] = [];
  for (const dictionary of xml.slice(open, close).matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
    const entries: Record<string, PlistValue> = {};
    for (const entry of (dictionary[1] ?? '').matchAll(/<key>([^<]*)<\/key>\s*(?:<(true|false)\s*\/>|<(integer|real|string)>([^<]*)<\/\3>)/g)) {
      const name = entry[1] as string;
      if (entry[2]) entries[name] = entry[2] === 'true';
      else if (entry[3] === 'string') entries[name] = entry[4] ?? '';
      else entries[name] = Number(entry[4]);
    }
    dictionaries.push(entries);
  }
  return dictionaries;
}

/**
 * Checks the iPod's own description (SysInfoExtended) lists the four formats with the sizes and
 * pixel layout this writer produces. A format number means nothing without it: libgpod's own tables
 * give 1016 as 140 x 140 on another model. Reads the new key (AlbumArt2) when the old one is empty,
 * as libgpod does.
 */
export function coverSupport(sysInfoExtended: string | null): CoverSupport {
  const no = (reason: string): CoverSupport => ({ ok: false, reason, maxThumbFileBytes: DEFAULT_MAX_THUMB_FILE_BYTES });
  if (!sysInfoExtended) return no("The iPod has no SysInfoExtended file, so there is no description of its album art formats to check against.");
  let declared = plistDictionaries(sysInfoExtended, 'AlbumArt');
  if (!declared || declared.length === 0) declared = plistDictionaries(sysInfoExtended, 'AlbumArt2');
  if (!declared || declared.length === 0) return no('The iPod does not list any album art formats.');
  for (const format of COVER_FORMATS) {
    const entry = declared.find((candidate) => candidate['FormatId'] === format.id);
    if (!entry) return no(`The iPod's description does not list album art format ${format.id}.`);
    const aligned = entry['AlignRowBytes'] === true || entry['RowBytesAlignment'] === 4;
    if (entry['RenderWidth'] !== format.width || entry['RenderHeight'] !== format.height || entry['PixelFormat'] !== '4C353635' || !aligned) {
      return no(`The iPod describes album art format ${format.id} differently (${String(entry['RenderWidth'])} x ${String(entry['RenderHeight'])}, ${String(entry['PixelFormat'])}) from the ${format.width} x ${format.height} 16-bit one this writer makes.`);
    }
  }
  const declaredSize = Number(sysInfoExtended.match(/<key>MaxThumbFileSize<\/key>\s*<integer>(\d+)<\/integer>/)?.[1] ?? 0);
  return { ok: true, reason: null, maxThumbFileBytes: declaredSize > 0 ? Math.min(declaredSize * 1000 * 1000, DEFAULT_MAX_THUMB_FILE_BYTES) : DEFAULT_MAX_THUMB_FILE_BYTES };
}

/**
 * Adds the four cover formats (AlbumArt2, and MaxThumbFileSize 50) to a SysInfoExtended that has
 * none, in the form the real nano 7G's file has them. For the practice iPod and tests, which carry
 * a stripped-down description. A file that already lists album art formats is returned unchanged.
 */
export function withCoverFormats(sysInfoExtended: string): string {
  if (/<key>AlbumArt2?<\/key>\s*<array>\s*<dict>/.test(sysInfoExtended)) return sysInfoExtended;
  const dictionary = (format: CoverFormat): string =>
    `    <dict>\n      <key>FormatId</key>\n      <integer>${format.id}</integer>\n      <key>RenderWidth</key>\n      <integer>${format.width}</integer>\n` +
    `      <key>RenderHeight</key>\n      <integer>${format.height}</integer>\n      <key>PixelFormat</key>\n      <string>4C353635</string>\n` +
    `      <key>Crop</key>\n      <false/>\n      <key>AlignRowBytes</key>\n      <true/>\n    </dict>\n`;
  const added = `  <key>AlbumArt2</key>\n  <array>\n${COVER_FORMATS.map(dictionary).join('')}  </array>\n  <key>MaxThumbFileSize</key>\n  <integer>50</integer>\n`;
  const end = sysInfoExtended.lastIndexOf('</dict>');
  if (end < 0) throw new ArtworkError('That is not a SysInfoExtended file.');
  return sysInfoExtended.slice(0, end) + added + sysInfoExtended.slice(end);
}

// ---------------------------------------------------------------- rendering

/** A decoded picture: RGBA, 8 bits a channel, rows top to bottom, no padding between rows. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Pictures with more pixels than this are refused, so a huge one cannot use up the memory. */
export const MAX_SOURCE_PIXELS = 36_000_000;

/**
 * Resamples one channel set from `from` to `to` pixels along a row or column, averaging every source
 * pixel a target pixel covers (the usual way to shrink, and a smooth blend when enlarging).
 */
function weights(from: number, to: number): { start: number[]; list: Float32Array[] } {
  const start: number[] = [];
  const list: Float32Array[] = [];
  const ratio = from / to;
  for (let target = 0; target < to; target += 1) {
    const low = target * ratio;
    const high = (target + 1) * ratio;
    const first = Math.floor(low);
    const last = Math.min(from - 1, Math.ceil(high) - 1);
    const part = new Float32Array(last - first + 1);
    let sum = 0;
    for (let source = first; source <= last; source += 1) {
      const weight = Math.min(high, source + 1) - Math.max(low, source);
      part[source - first] = weight;
      sum += weight;
    }
    for (let index = 0; index < part.length; index += 1) part[index] = (part[index] as number) / sum;
    start.push(first);
    list.push(part);
  }
  return { start, list };
}

/**
 * One thumbnail in the iPod's own bytes. The picture is fitted inside the square (kept in
 * proportion, centred, nothing cropped, as the device file says Crop is false), the rest is
 * black, a see-through picture is laid over black, and each pixel is packed as RGB565 little
 * endian. Each row is `rowBytes` long, and the bytes after the last pixel are zero.
 */
export function renderThumbnail(image: RgbaImage, format: CoverFormat): Uint8Array {
  const { width, height, data } = image;
  if (!(width > 0) || !(height > 0) || data.length < width * height * 4) throw new ArtworkError('The picture has no pixels to use.');
  if (width * height > MAX_SOURCE_PIXELS) throw new ArtworkError(`The picture is ${width} x ${height} pixels, more than the ${MAX_SOURCE_PIXELS.toLocaleString('en-US')} this will decode.`);

  const scale = Math.min(format.width / width, format.height / height);
  const fittedWidth = Math.max(1, Math.min(format.width, Math.round(width * scale)));
  const fittedHeight = Math.max(1, Math.min(format.height, Math.round(height * scale)));
  const columns = weights(width, fittedWidth);
  const rows = weights(height, fittedHeight);

  // Pass 1: every source row down to the fitted width, over black, as floats.
  const across = new Float32Array(height * fittedWidth * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < fittedWidth; x += 1) {
      const part = columns.list[x] as Float32Array;
      const first = columns.start[x] as number;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let index = 0; index < part.length; index += 1) {
        const at = (y * width + first + index) * 4;
        const weight = (part[index] as number) * ((data[at + 3] as number) / 255);
        r += (data[at] as number) * weight;
        g += (data[at + 1] as number) * weight;
        b += (data[at + 2] as number) * weight;
      }
      const out = (y * fittedWidth + x) * 3;
      across[out] = r;
      across[out + 1] = g;
      across[out + 2] = b;
    }
  }

  // Pass 2: down to the fitted height, then into the square and into 16 bits.
  const left = Math.floor((format.width - fittedWidth) / 2);
  const top = Math.floor((format.height - fittedHeight) / 2);
  const bytes = new Uint8Array(format.slotBytes);
  const to5 = (value: number): number => Math.min(31, Math.round((value * 31) / 255));
  const to6 = (value: number): number => Math.min(63, Math.round((value * 63) / 255));
  for (let y = 0; y < fittedHeight; y += 1) {
    const part = rows.list[y] as Float32Array;
    const first = rows.start[y] as number;
    for (let x = 0; x < fittedWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let index = 0; index < part.length; index += 1) {
        const at = ((first + index) * fittedWidth + x) * 3;
        const weight = part[index] as number;
        r += (across[at] as number) * weight;
        g += (across[at + 1] as number) * weight;
        b += (across[at + 2] as number) * weight;
      }
      const pixel = (to5(r) << 11) | (to6(g) << 5) | to5(b);
      const out = (top + y) * format.rowBytes + (left + x) * 2;
      bytes[out] = pixel & 0xff;
      bytes[out + 1] = pixel >> 8;
    }
  }
  return bytes;
}

/** Every thumbnail of one picture, by format id. */
export function renderCover(image: RgbaImage): Map<number, Uint8Array> {
  return new Map(COVER_FORMATS.map((format) => [format.id, renderThumbnail(image, format)]));
}

// -------------------------------------------------------------- ArtworkDB bytes

const MHFD_HEADER = 0x84;
const MHSD_HEADER = 0x60;
const LIST_HEADER = 0x5c;
const MHII_HEADER = 0x98;
const MHNI_HEADER = 0x4c;
const MHIF_HEADER = 0x7c;
const MHOD_HEADER = 0x18;
const MHOD_STRING_LENGTH = 0x40; // header, 12 bytes of string description, and ":F1010_1.ithmb" in UTF-16
const MHOD_THUMBNAIL_LENGTH = MHOD_HEADER + MHNI_HEADER + MHOD_STRING_LENGTH; // 164
const MHOD_AUXILIARY_LENGTH = 0x78;
/** The mhii of an image with all four formats. */
const MHII_LENGTH = MHII_HEADER + COVER_FORMATS.length * MHOD_THUMBNAIL_LENGTH + MHOD_AUXILIARY_LENGTH; // 928

const text = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at] as number, bytes[at + 1] as number, bytes[at + 2] as number, bytes[at + 3] as number);

function putText(bytes: Uint8Array, at: number, value: string): void {
  for (let index = 0; index < 4; index += 1) bytes[at + index] = value.charCodeAt(index);
}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function record(name: string, headerLength: number, totalOrCount: number, length = headerLength): Uint8Array {
  const bytes = new Uint8Array(length);
  putText(bytes, 0, name);
  view(bytes).setUint32(4, headerLength, true);
  view(bytes).setUint32(8, totalOrCount, true);
  return bytes;
}

/** One image with its thumbnails: where each one starts in its file. */
export interface NewImage {
  id: number;
  /** The persistent id of the first track that uses the image. */
  songId: bigint;
  /** Bytes in the original picture. */
  sourceSize: number;
  /** How many tracks use the image. */
  trackCount: number;
  /** Where the thumbnail of each format starts in its file, by format id. */
  offsets: Map<number, number>;
}

const NOT_A_NUMBER = [0, 0, 0, 0, 0, 0, 0xf8, 0x7f];

/** One mhod type 2 record holding the mhni of one thumbnail, with the file name as an mhod type 3. */
function thumbnailRecord(format: CoverFormat, offset: number): Uint8Array {
  const bytes = new Uint8Array(MHOD_THUMBNAIL_LENGTH);
  const data = view(bytes);
  putText(bytes, 0, 'mhod');
  data.setUint32(4, MHOD_HEADER, true);
  data.setUint32(8, MHOD_THUMBNAIL_LENGTH, true);
  data.setUint16(12, 2, true);

  const mhni = MHOD_HEADER;
  putText(bytes, mhni, 'mhni');
  data.setUint32(mhni + 4, MHNI_HEADER, true);
  data.setUint32(mhni + 8, MHNI_HEADER + MHOD_STRING_LENGTH, true);
  data.setUint32(mhni + 0x0c, 1, true);
  data.setUint32(mhni + 0x10, format.id, true);
  data.setUint32(mhni + 0x14, offset, true);
  data.setUint32(mhni + 0x18, format.slotBytes, true);
  data.setUint16(mhni + 0x20, format.height, true);
  data.setUint16(mhni + 0x22, format.width, true);
  data.setUint32(mhni + 0x28, format.slotBytes, true);

  const name = mhni + MHNI_HEADER;
  const fileName = `:F${format.id}_1.ithmb`;
  putText(bytes, name, 'mhod');
  data.setUint32(name + 4, MHOD_HEADER, true);
  data.setUint32(name + 8, MHOD_STRING_LENGTH, true);
  data.setUint16(name + 12, 3, true);
  data.setUint32(name + 0x18, fileName.length * 2, true);
  bytes[name + 0x1c] = 2; // UTF-16 little endian
  for (let index = 0; index < fileName.length; index += 1) data.setUint16(name + 0x24 + index * 2, fileName.charCodeAt(index), true);
  return bytes;
}

/** One mhii record: the image, its four thumbnails and the auxiliary (mhaf) record the owner's file has. */
export function imageRecord(image: NewImage): Uint8Array {
  const bytes = new Uint8Array(MHII_LENGTH);
  const data = view(bytes);
  putText(bytes, 0, 'mhii');
  data.setUint32(4, MHII_HEADER, true);
  data.setUint32(8, MHII_LENGTH, true);
  data.setUint32(0x0c, COVER_FORMATS.length + 1, true);
  data.setUint32(0x10, image.id, true);
  data.setBigUint64(0x14, BigInt.asUintN(64, image.songId), true);
  data.setUint32(0x30, image.sourceSize, true);
  data.setUint32(0x38, Math.max(1, image.trackCount), true);
  data.setUint32(0x3c, 1, true);
  bytes.set(NOT_A_NUMBER, 0x48);
  bytes.set(NOT_A_NUMBER, 0x50);

  let at = MHII_HEADER;
  for (const format of COVER_FORMATS) {
    const offset = image.offsets.get(format.id);
    if (offset === undefined) throw new ArtworkError(`The image has no place in the file for format ${format.id}.`);
    bytes.set(thumbnailRecord(format, offset), at);
    at += MHOD_THUMBNAIL_LENGTH;
  }
  putText(bytes, at, 'mhod');
  data.setUint32(at + 4, MHOD_HEADER, true);
  data.setUint32(at + 8, MHOD_AUXILIARY_LENGTH, true);
  data.setUint16(at + 12, 6, true);
  putText(bytes, at + MHOD_HEADER, 'mhaf');
  data.setUint32(at + MHOD_HEADER + 4, 0x60, true);
  data.setUint32(at + MHOD_HEADER + 8, 0x3c, true);
  return bytes;
}

/** The three ids the top record of an ArtworkDB carries. What they mean is not known. */
export interface DatabaseIds {
  /** 16 bytes at 0x20. */
  first: Uint8Array;
  /** 8 bytes at 0x3c. */
  second: Uint8Array;
}

/** A new ArtworkDB holding `images`. `ids` are taken from a real file, or made at random. */
export function createArtworkDb(images: NewImage[], ids?: DatabaseIds): Uint8Array {
  const records = images.map(imageRecord);
  const imageBytes = records.reduce((sum, bytes) => sum + bytes.length, 0);
  const formatBytes = COVER_FORMATS.length * MHIF_HEADER;
  const imageSet = MHSD_HEADER + LIST_HEADER + imageBytes;
  const albumSet = MHSD_HEADER + LIST_HEADER;
  const formatSet = MHSD_HEADER + LIST_HEADER + formatBytes;
  const total = MHFD_HEADER + imageSet + albumSet + formatSet;

  const bytes = new Uint8Array(total);
  const data = view(bytes);
  bytes.set(record('mhfd', MHFD_HEADER, total), 0);
  data.setUint32(0x10, 6, true);
  data.setUint32(0x14, 3, true);
  const nextId = images.reduce((high, image) => Math.max(high, image.id + 1), FIRST_IMAGE_ID);
  data.setUint32(0x1c, nextId, true);
  const random = ids ?? { first: crypto.getRandomValues(new Uint8Array(16)), second: crypto.getRandomValues(new Uint8Array(8)) };
  bytes.set(random.first.subarray(0, 16), 0x20);
  bytes[0x30] = 1;
  bytes.set(random.second.subarray(0, 8), 0x3c);

  let at = MHFD_HEADER;
  const put = (part: Uint8Array): void => {
    bytes.set(part, at);
    at += part.length;
  };
  const set = (index: number, length: number, list: string, count: number): void => {
    const header = record('mhsd', MHSD_HEADER, length);
    view(header).setUint16(12, index, true);
    put(header);
    put(record(list, LIST_HEADER, count));
  };
  set(1, imageSet, 'mhli', images.length);
  for (const part of records) put(part);
  set(2, albumSet, 'mhla', 0);
  set(3, formatSet, 'mhlf', COVER_FORMATS.length);
  for (const format of COVER_FORMATS) {
    const mhif = record('mhif', MHIF_HEADER, MHIF_HEADER);
    view(mhif).setUint32(0x10, format.id, true);
    view(mhif).setUint32(0x14, format.slotBytes, true);
    put(mhif);
  }
  return bytes;
}

// ------------------------------------------------------- reading an ArtworkDB

export interface ArtworkThumb {
  formatId: number;
  offset: number;
  size: number;
  fileName: string;
}

export interface ArtworkImage {
  id: number;
  songId: bigint;
  sourceSize: number;
  trackCount: number;
  thumbs: ArtworkThumb[];
}

export interface ArtworkDbInfo {
  /** The next image id the file records. */
  nextId: number;
  images: ArtworkImage[];
  /** The formats in the file's own list, with their slot sizes. */
  formats: { id: number; slotBytes: number }[];
  /** Where the image set ends, so a new image can be added there. */
  imageSetStart: number;
  imageSetEnd: number;
}

const refuse = (message: string): never => {
  throw new ArtworkError(message);
};

/**
 * Reads an ArtworkDB and checks it is the shape this writer knows. Anything else is refused with a
 * reason, and the file is then left alone. Reads the structure the owner's file has: a top record
 * with three sets (images, albums, formats), images as mhii records holding mhod type 2 records.
 */
export function parseArtworkDb(bytes: Uint8Array): ArtworkDbInfo {
  const data = view(bytes);
  const u32 = (at: number): number => (at + 4 <= bytes.length ? data.getUint32(at, true) : refuse('The ArtworkDB ends in the middle of a record.'));
  if (bytes.length < MHFD_HEADER || text(bytes, 0) !== 'mhfd') return refuse('The ArtworkDB does not start with an mhfd record.');
  if (u32(4) !== MHFD_HEADER) return refuse(`The ArtworkDB's top record has a header of ${u32(4)} bytes, not ${MHFD_HEADER}.`);
  if (u32(8) !== bytes.length) return refuse(`The ArtworkDB says it is ${u32(8)} bytes and the file is ${bytes.length}.`);
  if (u32(0x14) !== 3) return refuse(`The ArtworkDB has ${u32(0x14)} sets, not 3.`);
  const nextId = u32(0x1c);

  let at = MHFD_HEADER;
  const sets: { index: number; start: number; end: number }[] = [];
  for (let count = 0; count < 3; count += 1) {
    if (text(bytes, at) !== 'mhsd' || u32(at + 4) !== MHSD_HEADER) return refuse('The ArtworkDB does not have its three sets where they should be.');
    const length = u32(at + 8);
    if (length < MHSD_HEADER + LIST_HEADER || at + length > bytes.length) return refuse('A set in the ArtworkDB runs past the end of the file.');
    sets.push({ index: data.getUint16(at + 12, true), start: at, end: at + length });
    at += length;
  }
  if (at !== bytes.length) return refuse('There are bytes after the last set of the ArtworkDB.');
  if (sets.map((set) => set.index).join() !== '1,2,3') return refuse('The ArtworkDB sets are not in the order 1, 2, 3.');

  const [imageSet, , formatSet] = sets as [(typeof sets)[number], (typeof sets)[number], (typeof sets)[number]];
  const imageList = imageSet.start + MHSD_HEADER;
  if (text(bytes, imageList) !== 'mhli' || u32(imageList + 4) !== LIST_HEADER) return refuse('The ArtworkDB image list is not where it should be.');
  const imageCount = u32(imageList + 8);
  const images: ArtworkImage[] = [];
  let cursor = imageList + LIST_HEADER;
  for (let index = 0; index < imageCount; index += 1) {
    if (text(bytes, cursor) !== 'mhii') return refuse(`Image ${index + 1} of the ArtworkDB is not an mhii record.`);
    const header = u32(cursor + 4);
    const length = u32(cursor + 8);
    if (header < 0x40 || length < header || cursor + length > imageSet.end) return refuse(`Image ${index + 1} of the ArtworkDB runs past its set.`);
    const thumbs: ArtworkThumb[] = [];
    let child = cursor + header;
    for (let part = u32(cursor + 0x0c); part > 0; part -= 1) {
      if (text(bytes, child) !== 'mhod') return refuse(`Image ${index + 1} of the ArtworkDB holds something that is not an mhod record.`);
      const childLength = u32(child + 8);
      if (childLength < MHOD_HEADER || child + childLength > cursor + length) return refuse(`A record of image ${index + 1} runs past the image.`);
      if (data.getUint16(child + 12, true) === 2) {
        const mhni = child + u32(child + 4);
        if (text(bytes, mhni) !== 'mhni') return refuse(`Image ${index + 1} has a thumbnail record that is not an mhni.`);
        const name = mhni + u32(mhni + 4);
        let fileName = '';
        if (text(bytes, name) === 'mhod' && data.getUint16(name + 12, true) === 3) {
          const stringBytes = u32(name + 0x18);
          for (let letter = 0; letter < stringBytes / 2; letter += 1) fileName += String.fromCharCode(data.getUint16(name + 0x24 + letter * 2, true));
        }
        thumbs.push({ formatId: u32(mhni + 0x10), offset: u32(mhni + 0x14), size: u32(mhni + 0x18), fileName });
      }
      child += childLength;
    }
    images.push({ id: u32(cursor + 0x10), songId: data.getBigUint64(cursor + 0x14, true), sourceSize: u32(cursor + 0x30), trackCount: u32(cursor + 0x38), thumbs });
    cursor += length;
  }
  if (cursor !== imageSet.end) return refuse('The ArtworkDB image list does not fill its set.');

  const formatList = formatSet.start + MHSD_HEADER;
  if (text(bytes, formatList) !== 'mhlf') return refuse('The ArtworkDB format list is not where it should be.');
  const formats: ArtworkDbInfo['formats'] = [];
  let format = formatList + u32(formatList + 4);
  for (let index = u32(formatList + 8); index > 0; index -= 1) {
    if (text(bytes, format) !== 'mhif') return refuse('The ArtworkDB format list holds something that is not an mhif record.');
    formats.push({ id: u32(format + 0x10), slotBytes: u32(format + 0x14) });
    format += u32(format + 8);
  }
  return { nextId, images, formats, imageSetStart: imageSet.start, imageSetEnd: imageSet.end };
}

/** The id to give the next image: past the file's own next id and past every id in it. */
export function nextImageId(info: ArtworkDbInfo): number {
  return Math.max(info.nextId, FIRST_IMAGE_ID, ...info.images.map((image) => image.id + 1));
}

/**
 * Adds images to an existing ArtworkDB, leaving every byte already in it as it is except the counts,
 * the lengths and the next id. Refuses a file whose format list is not the four this writer makes.
 */
export function addToArtworkDb(existing: Uint8Array, images: NewImage[]): Uint8Array {
  const info = parseArtworkDb(existing);
  const expected = COVER_FORMATS.map((format) => `${format.id}:${format.slotBytes}`).join();
  if (info.formats.map((format) => `${format.id}:${format.slotBytes}`).join() !== expected) {
    return refuse(`The ArtworkDB lists formats ${info.formats.map((format) => format.id).join(', ') || '(none)'}, not ${COVER_FORMATS.map((format) => format.id).join(', ')}, so it was left alone.`);
  }
  const used = new Set(info.images.map((image) => image.id));
  for (const image of images) if (used.has(image.id) || image.id < nextImageId(info)) return refuse(`Image id ${image.id} is already in the ArtworkDB.`);
  if (!images.length) return existing;

  const records = images.map(imageRecord);
  const added = records.reduce((sum, bytes) => sum + bytes.length, 0);
  const result = new Uint8Array(existing.length + added);
  result.set(existing.subarray(0, info.imageSetEnd), 0);
  let at = info.imageSetEnd;
  for (const part of records) {
    result.set(part, at);
    at += part.length;
  }
  result.set(existing.subarray(info.imageSetEnd), at);

  const data = view(result);
  data.setUint32(8, existing.length + added, true);
  data.setUint32(0x1c, Math.max(...images.map((image) => image.id + 1), info.nextId), true);
  data.setUint32(info.imageSetStart + 8, info.imageSetEnd - info.imageSetStart + added, true);
  data.setUint32(info.imageSetStart + MHSD_HEADER + 8, info.images.length + images.length, true);
  return result;
}

// ----------------------------------------------------------------- planning

/** A cover that is to go on the iPod, shared by every track that uses it. */
export interface CoverRequest {
  /** Tells covers apart: the same value means the same picture. */
  key: string;
  /** The persistent id of the first track that uses it. */
  songId: bigint;
  trackCount: number;
  sourceSize: number;
  /** The four thumbnails, from `renderCover`. */
  thumbnails: Map<number, Uint8Array>;
}

export interface PlannedImage {
  id: number;
  key: string;
  songId: bigint;
  trackCount: number;
  sourceSize: number;
  offsets: Map<number, number>;
}

export interface PlannedThumbFile {
  /** From the iPod's top folder. */
  path: string;
  formatId: number;
  sizeBefore: number;
  /** The thumbnails added after the bytes already in the file. */
  append: Uint8Array;
}

/** What an artwork write would do. Holds the bytes, so applying needs no second guess. */
export interface ArtworkPlan {
  /** The ArtworkDB as the iPod holds it, or null when it has none. */
  databaseBefore: Uint8Array | null;
  databaseAfter: Uint8Array;
  /** True when there was no ArtworkDB and a new one is made. */
  createsDatabase: boolean;
  thumbFiles: PlannedThumbFile[];
  images: PlannedImage[];
  /** Covers left out, and why. */
  left: { key: string; reason: string }[];
}

export interface ArtworkOnIpod {
  /** The ArtworkDB's bytes, or null when the file is not there. */
  database: Uint8Array | null;
  /** The size of each thumbnail file, by format id. 0 when the file is not there. */
  thumbSizes: Map<number, number>;
}

/**
 * Works out the files that adding `covers` would give, from what the iPod holds. Refuses an
 * ArtworkDB or thumbnail files it does not understand (an ArtworkError). A cover that would take a
 * thumbnail file past `maxThumbFileBytes` is left out and listed, with every cover after it.
 */
export function planArtwork(onIpod: ArtworkOnIpod, covers: CoverRequest[], maxThumbFileBytes = DEFAULT_MAX_THUMB_FILE_BYTES): ArtworkPlan {
  const info = onIpod.database ? parseArtworkDb(onIpod.database) : null;

  // The thumbnail files must be whole thumbnails, and everything the ArtworkDB points at must be there.
  for (const format of COVER_FORMATS) {
    const size = onIpod.thumbSizes.get(format.id) ?? 0;
    if (size % format.slotBytes !== 0) return refuse(`${thumbFilePath(format.id).split('/').pop()} is ${size} bytes, which is not a whole number of ${format.slotBytes} byte thumbnails, so album art was left alone.`);
    for (const image of info?.images ?? []) {
      for (const thumb of image.thumbs) {
        if (thumb.formatId === format.id && thumb.offset + thumb.size > size) return refuse(`The ArtworkDB points past the end of ${thumbFilePath(format.id).split('/').pop()}, so album art was left alone.`);
      }
    }
  }
  if (!info && [...onIpod.thumbSizes.values()].some((size) => size > 0)) return refuse('There are thumbnail files but no ArtworkDB, so album art was left alone.');

  const sizes = new Map(COVER_FORMATS.map((format) => [format.id, onIpod.thumbSizes.get(format.id) ?? 0]));
  const planned: PlannedImage[] = [];
  const left: ArtworkPlan['left'] = [];
  const appended = new Map<number, Uint8Array[]>(COVER_FORMATS.map((format) => [format.id, []]));
  let id = info ? nextImageId(info) : FIRST_IMAGE_ID;
  let full: string | null = null;

  for (const cover of covers) {
    if (full) {
      left.push({ key: cover.key, reason: full });
      continue;
    }
    const tooBig = COVER_FORMATS.find((format) => (sizes.get(format.id) as number) + format.slotBytes > maxThumbFileBytes);
    if (tooBig) {
      full = `${thumbFilePath(tooBig.id).split('/').pop()} would pass ${Math.round(maxThumbFileBytes / 1_000_000)} MB, the limit the iPod declares, and this build does not start a second file.`;
      left.push({ key: cover.key, reason: full });
      continue;
    }
    const offsets = new Map<number, number>();
    for (const format of COVER_FORMATS) {
      const thumbnail = cover.thumbnails.get(format.id);
      if (!thumbnail || thumbnail.length !== format.slotBytes) return refuse(`The thumbnail for format ${format.id} is ${thumbnail?.length ?? 0} bytes and should be ${format.slotBytes}.`);
      offsets.set(format.id, sizes.get(format.id) as number);
      (appended.get(format.id) as Uint8Array[]).push(thumbnail);
      sizes.set(format.id, (sizes.get(format.id) as number) + format.slotBytes);
    }
    planned.push({ id, key: cover.key, songId: cover.songId, trackCount: cover.trackCount, sourceSize: cover.sourceSize, offsets });
    id += 1;
  }

  const images: NewImage[] = planned.map((image) => ({ id: image.id, songId: image.songId, sourceSize: image.sourceSize, trackCount: image.trackCount, offsets: image.offsets }));
  const databaseAfter = onIpod.database ? addToArtworkDb(onIpod.database, images) : createArtworkDb(images);
  const thumbFiles: PlannedThumbFile[] = [];
  for (const format of COVER_FORMATS) {
    const parts = appended.get(format.id) as Uint8Array[];
    if (!parts.length) continue;
    const append = new Uint8Array(parts.length * format.slotBytes);
    parts.forEach((part, index) => append.set(part, index * format.slotBytes));
    thumbFiles.push({ path: thumbFilePath(format.id), formatId: format.id, sizeBefore: onIpod.thumbSizes.get(format.id) ?? 0, append });
  }
  return { databaseBefore: onIpod.database, databaseAfter, createsDatabase: !onIpod.database, thumbFiles, images: planned, left };
}

// ------------------------------------------------- reading the iPod, writing it

/** The ArtworkDB and the thumbnail file sizes as the iPod holds them. Reads only. */
export async function readArtworkOnIpod(root: IpodRoot): Promise<ArtworkOnIpod> {
  const database = await readFrom(root, ARTWORK_DB_PATH);
  const thumbSizes = new Map<number, number>();
  for (const format of COVER_FORMATS) thumbSizes.set(format.id, (await fileAt(root, thumbFilePath(format.id)))?.size ?? 0);
  return { database, thumbSizes };
}

/** Null when the iPod's artwork files are exactly as the plan was made from them. */
export async function artworkChangedSince(root: IpodRoot, plan: ArtworkPlan): Promise<string | null> {
  const now = await readArtworkOnIpod(root);
  if (plan.databaseBefore ? !now.database || !same(now.database, plan.databaseBefore) : now.database !== null) {
    return 'The ArtworkDB on the iPod is not what it was when the plan was made, so nothing was written. Plan again.';
  }
  for (const file of plan.thumbFiles) {
    if ((now.thumbSizes.get(file.formatId) ?? 0) !== file.sizeBefore) return `${file.path} on the iPod is not what it was when the plan was made, so nothing was written. Plan again.`;
  }
  return null;
}

export interface ArtworkWrite {
  written: { path: string; size: number }[];
  /** What went wrong, or null when every file was written and read back as planned. */
  failure: string | null;
}

/**
 * Writes the thumbnails, then the ArtworkDB, and reads each back. Every file is added to `touched`
 * with the bytes it held before it is written, so the caller can put it back. Stops at the first
 * problem. The ArtworkDB goes last, so it never names thumbnails that are not there.
 */
export async function writeArtwork(root: IpodRoot, plan: ArtworkPlan, touched: Touched[], options: { stopReason?: () => string | null; onStep?: (message: string) => void } = {}): Promise<ArtworkWrite> {
  const result: ArtworkWrite = { written: [], failure: null };
  const steps: { path: string; before: Uint8Array | null; after: (before: Uint8Array | null) => Uint8Array }[] = [
    ...plan.thumbFiles.map((file) => ({
      path: file.path,
      before: null as Uint8Array | null,
      after: (before: Uint8Array | null): Uint8Array => {
        const old = before ?? new Uint8Array(0);
        const joined = new Uint8Array(old.length + file.append.length);
        joined.set(old, 0);
        joined.set(file.append, old.length);
        return joined;
      },
    })),
    { path: ARTWORK_DB_PATH, before: null, after: () => plan.databaseAfter },
  ];
  for (const step of steps) {
    const stop = options.stopReason?.();
    if (stop) {
      result.failure = stop;
      return result;
    }
    options.onStep?.(`Writing ${step.path}`);
    try {
      const before = await readFrom(root, step.path);
      const planned = plan.thumbFiles.find((file) => file.path === step.path);
      if (planned && (before?.length ?? 0) !== planned.sizeBefore) {
        result.failure = `${step.path} on the iPod is not what it was when the plan was made, so nothing more was written. Plan again.`;
        return result;
      }
      if (step.path === ARTWORK_DB_PATH && (plan.databaseBefore ? !before || !same(before, plan.databaseBefore) : before !== null)) {
        result.failure = `${step.path} on the iPod is not what it was when the plan was made, so nothing more was written. Plan again.`;
        return result;
      }
      touched.push({ path: step.path, before });
      const bytes = step.after(before);
      await writeTo(root, step.path, bytes);
      const back = await readFrom(root, step.path);
      if (!back || !same(back, bytes)) {
        result.failure = `${step.path} did not match what was written when it was read back from the iPod.`;
        return result;
      }
      result.written.push({ path: step.path, size: bytes.length });
    } catch (error) {
      result.failure = `${step.path} could not be written: ${messageOf(error)}`;
      return result;
    }
  }
  return result;
}

/**
 * Reads the artwork on the iPod back and checks it holds what was planned: the ArtworkDB parses and
 * has every planned image with the planned song id and thumbnail places, and each thumbnail is
 * in its file at that place. Null when all of that is so.
 */
export async function verifyArtwork(root: IpodRoot, plan: ArtworkPlan): Promise<string | null> {
  const now = await readArtworkOnIpod(root);
  if (!now.database) return 'The ArtworkDB is not on the iPod after the write.';
  let info: ArtworkDbInfo;
  try {
    info = parseArtworkDb(now.database);
  } catch (error) {
    return `The ArtworkDB on the iPod does not read back: ${messageOf(error)}`;
  }
  for (const planned of plan.images) {
    const image = info.images.find((candidate) => candidate.id === planned.id);
    if (!image) return `Image ${planned.id} is not in the ArtworkDB after the write.`;
    if (image.songId !== BigInt.asUintN(64, planned.songId)) return `Image ${planned.id} names a different track in the ArtworkDB than planned.`;
    for (const format of COVER_FORMATS) {
      const thumb = image.thumbs.find((candidate) => candidate.formatId === format.id);
      if (!thumb || thumb.offset !== planned.offsets.get(format.id) || thumb.size !== format.slotBytes) return `Image ${planned.id} has a thumbnail of format ${format.id} in a different place than planned.`;
      if (thumb.fileName !== `:F${format.id}_1.ithmb`) return `Image ${planned.id} names the file ${thumb.fileName} for format ${format.id}.`;
    }
  }
  for (const file of plan.thumbFiles) {
    const size = now.thumbSizes.get(file.formatId) ?? 0;
    if (size !== file.sizeBefore + file.append.length) return `${file.path} is ${size} bytes after the write and should be ${file.sizeBefore + file.append.length}.`;
  }
  return null;
}
