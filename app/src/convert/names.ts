/** File name helpers. Pure. */

/** The name without its last extension. "Song.final.flac" gives "Song.final". */
export function stripExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The extension in lower case without the dot, or an empty string. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * The name of the converted file: the input's name with the new container as its extension.
 * Characters a file system dislikes are replaced, and an empty name becomes "converted".
 */
export function outputFileName(inputName: string, container: 'm4a' | 'm4b' | 'm4v'): string {
  const cleaned = stripExtension(inputName).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return `${cleaned || 'converted'}.${container}`;
}

/**
 * A safe name for an input inside ffmpeg's virtual file system. The person's file name can hold
 * characters ffmpeg treats as syntax (":" or "|"), so only the extension is kept, and only
 * when it is plain letters and digits, because a few formats are recognised by it.
 */
export function virtualInputName(stem: string, originalName: string): string {
  const extension = extensionOf(originalName);
  return /^[a-z0-9]{1,5}$/.test(extension) ? `${stem}.${extension}` : `${stem}.bin`;
}
