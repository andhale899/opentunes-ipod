import type { RgbaImage } from '@opentunes/engine';

/** Pictures are decoded no larger than this on their longest side. The sync shrinks them to at most 240 pixels anyway. */
const MAX_SIDE = 1200;

/**
 * Reads a cover picture (JPEG, PNG or anything else Chrome can show) into pixels with the browser's
 * own decoder and a canvas. The sync does the resizing and the iPod's pixel format itself. Returns
 * null for a picture Chrome cannot read.
 */
export async function decodePicture(picture: { mime: string; data: Uint8Array }): Promise<RgbaImage | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(picture.data)], { type: picture.mime }));
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
