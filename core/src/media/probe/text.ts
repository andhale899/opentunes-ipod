/** Text decoding for tags. Nothing here throws: bad bytes become replacement characters or are dropped. */

export function latin1(b: Uint8Array): string {
  let text = '';
  for (let i = 0; i < b.length; i += 1) text += String.fromCharCode(b[i] ?? 0);
  return text;
}

export function utf8(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(b);
  } catch {
    return latin1(b);
  }
}

export function utf16(b: Uint8Array, bigEndian: boolean): string {
  let text = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const hi = b[i] ?? 0;
    const lo = b[i + 1] ?? 0;
    text += String.fromCharCode(bigEndian ? (hi << 8) | lo : (lo << 8) | hi);
  }
  return text;
}

/** UTF-16 that may start with a byte order mark. With no mark, little endian is assumed (what Windows writers produce). */
export function utf16WithBom(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), true);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), false);
  return utf16(b, false);
}

/** Drops a leading byte order mark, trailing NUL characters and surrounding whitespace. */
export function cleanText(text: string): string {
  let start = 0;
  while (start < text.length && text.charCodeAt(start) === 0xfeff) start += 1;
  let end = text.length;
  while (end > start && text.charCodeAt(end - 1) === 0) end -= 1;
  return text.slice(start, end).trim();
}

/** ID3 text encodings: 0 ISO-8859-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8. An unknown value is read as ISO-8859-1. */
export function decodeId3Text(encoding: number, b: Uint8Array): string {
  switch (encoding) {
    case 1:
      return utf16WithBom(b);
    case 2:
      return utf16(b, true);
    case 3:
      return utf8(b);
    default:
      return latin1(b);
  }
}

/** Index of the terminator for an ID3 text field, and how wide it is. Index is -1 when there is none. */
export function findId3Terminator(b: Uint8Array, from: number, encoding: number): { index: number; width: number } {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < b.length; i += 2) {
      if (b[i] === 0 && b[i + 1] === 0) return { index: i, width: 2 };
    }
    return { index: -1, width: 2 };
  }
  for (let i = from; i < b.length; i += 1) {
    if (b[i] === 0) return { index: i, width: 1 };
  }
  return { index: -1, width: 1 };
}

/** Splits a decoded ID3 text value on NUL (the ID3v2.4 way to hold several values) and cleans each part. */
export function splitValues(text: string): string[] {
  return text
    .split('\0')
    .map((part) => cleanText(part))
    .filter((part) => part.length > 0);
}

/** Several values for one field are joined like this. */
export const VALUE_SEPARATOR = ' / ';
