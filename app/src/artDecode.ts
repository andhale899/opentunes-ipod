import { MAX_SOURCE_PIXELS, type RgbaImage } from '@opentunes/engine';

/** Pictures are decoded no larger than this on their longest side. The sync shrinks them to at most 240 pixels anyway. */
const MAX_SIDE = 1200;

/** Why a picture was not read: Chrome could not open it, or it has more pixels than the sync will decode. */
export type DecodeResult = { ok: true; image: RgbaImage } | { ok: false; reason: 'unreadable' } | { ok: false; reason: 'too-large'; width: number; height: number };

/**
 * Reads a cover picture (JPEG, PNG, WebP or anything else Chrome can show) into pixels with the
 * browser's own decoder and a canvas, and says why when it cannot. A picture with more pixels than
 * the sync accepts (`MAX_SOURCE_PIXELS`) is refused before it is drawn. The sync does the resizing
 * and the iPod's pixel format itself.
 */
export async function decodePictureDetailed(picture: { mime: string; data: Uint8Array }): Promise<DecodeResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(picture.data)], { type: picture.mime }));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) return { ok: false, reason: 'too-large', width: bitmap.width, height: bitmap.height };
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return { ok: false, reason: 'unreadable' };
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return { ok: true, image: { width, height, data: context.getImageData(0, 0, width, height).data } };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    bitmap.close();
  }
}

/** The pixels of a cover picture, or null when Chrome cannot read it or it is too large. Used by the sync. */
export async function decodePicture(picture: { mime: string; data: Uint8Array }): Promise<RgbaImage | null> {
  const result = await decodePictureDetailed(picture);
  return result.ok ? result.image : null;
}
