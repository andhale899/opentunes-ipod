/**
 * Typed bindings for the OpenTunes engine (engine/src/engine.c).
 *
 * The engine is libgpod compiled to WebAssembly. It works on an iPod folder that exists
 * inside the module's own in-memory file system (`engine.fs`), not on the real device.
 * The app copies the iPod's database files in, calls the engine, and copies changes out.
 *
 * Written in erasable-only TypeScript (no enums, no parameter properties) so that Node can
 * run it directly in tests and Vite can bundle it for the app.
 */

export const API_VERSION = '1';

/** What a track is. It decides the iPod menu it appears under and the flags that go with it. */
export type Kind = 'music' | 'movie' | 'music-video' | 'tv-show' | 'podcast' | 'video-podcast' | 'audiobook';

/** Track fields that hold text. Must match the table in engine.c, a test checks it does. */
export const TEXT_FIELDS = [
  'title', 'album', 'artist', 'albumartist', 'genre', 'composer', 'comment', 'grouping',
  'category', 'description', 'subtitle', 'keywords', 'podcasturl', 'podcastrss', 'tvshow',
  'tvepisode', 'tvnetwork', 'sort_artist', 'sort_title', 'sort_album', 'sort_albumartist',
  'sort_composer', 'sort_tvshow', 'filetype',
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** Track fields that hold numbers and can be set. */
export const NUMBER_FIELDS = [
  'track_nr', 'tracks', 'cd_nr', 'cds', 'year', 'tracklen', 'bitrate', 'samplerate', 'volume',
  'soundcheck', 'rating', 'playcount', 'bookmark_time', 'starttime', 'stoptime', 'BPM',
  'compilation', 'explicit_flag', 'season_nr', 'episode_nr', 'size', 'skip_when_shuffling',
  'remember_playback_position', 'flag4', 'mark_unplayed', 'movie_flag', 'lyrics_flag',
  'visible', 'checked', 'app_rating', 'type1', 'type2', 'pregap', 'postgap', 'samplecount',
  'gapless_data', 'gapless_track_flag', 'gapless_album_flag', 'time_added', 'time_modified',
  'time_played', 'time_released',
] as const;
export type NumberField = (typeof NUMBER_FIELDS)[number];

/** Fields only the engine sets. */
export const READ_ONLY_FIELDS = [
  'id', 'mediatype', 'ipod_path', 'transferred', 'has_artwork', 'artwork_count', 'filetype_marker',
] as const;

export type TrackFields = Partial<Record<TextField, string | null>> & Partial<Record<NumberField, number>>;

export interface Chapter {
  /** Milliseconds from the start. libgpod stores the first chapter at 1 at the earliest. */
  start: number;
  title: string | null;
}

export type TrackInfo = Record<TextField, string | null> &
  Record<NumberField, number> & {
    handle: number;
    kind: string;
    id: number;
    mediatype: number;
    ipod_path: string | null;
    transferred: boolean;
    has_artwork: number;
    artwork_count: number;
    filetype_marker: number;
    chapters: Chapter[];
  };

export interface PlaylistInfo {
  handle: number;
  name: string | null;
  master: boolean;
  podcasts: boolean;
  smart: boolean;
  /** Track handles. */
  tracks: number[];
}

export interface DeviceInfo {
  model_name: string | null;
  generation_name: string | null;
  model_number: string | null;
  generation: number;
  capacity_gb: number;
  ipod_model: number;
  firewire_guid: string | null;
  firewire_id: string | null;
  checksum_type: number;
  checksum: 'none' | 'hash58' | 'hash72' | 'hashAB' | 'unknown';
  serial_number: string | null;
  model_num_str: string | null;
  board_type: string | null;
  has_sysinfo_extended: boolean;
  device_recognized: boolean;
  supports: { artwork: boolean; video: boolean; photo: boolean; podcast: boolean; chapter_image: boolean };
}

export interface KindInfo {
  name: Kind;
  mediatype: number;
}

/** The parts of the Emscripten module these bindings use. */
export interface EngineModule {
  ccall(name: string, returnType: 'number' | 'string' | null, argTypes: string[], args: unknown[]): unknown;
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { size: number; mode: number };
    analyzePath(path: string): { exists: boolean };
    isDir(mode: number): boolean;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _calcHashAB(target: number, sha1: number, uuid: number, rnd: number): void;
}

export type EngineFactory = (overrides?: Record<string, unknown>) => Promise<EngineModule>;

export class EngineError extends Error {}

export interface CreateOptions {
  /** Let libgpod's own progress messages through. Off by default, they are noisy. */
  verbose?: boolean;
}

export async function createEngine(factory: EngineFactory, options: CreateOptions = {}): Promise<Engine> {
  const quiet = options.verbose ? {} : { print: () => {}, printErr: () => {} };
  const engine = new Engine(await factory(quiet));
  const version = engine.apiVersion();
  if (version !== API_VERSION) {
    throw new EngineError(`The engine speaks API version ${version}, these bindings expect ${API_VERSION}.`);
  }
  return engine;
}

export class Engine {
  readonly module: EngineModule;

  constructor(module: EngineModule) {
    this.module = module;
  }

  /** The module's in-memory file system, where the iPod folder lives. */
  get fs(): EngineModule['FS'] {
    return this.module.FS;
  }

  // ----------------------------------------------------------------- plumbing

  #number(name: string, types: string[] = [], args: unknown[] = []): number {
    const result = this.module.ccall(name, 'number', types, args) as number;
    if (result < 0) {
      throw new EngineError(this.lastError() || `${name} failed.`);
    }
    return result;
  }

  /** The engine returns NULL on failure, which ccall turns into an empty string. */
  #text(name: string, types: string[] = [], args: unknown[] = []): string {
    const result = this.module.ccall(name, 'string', types, args) as string;
    if (result === '') {
      throw new EngineError(this.lastError() || `${name} failed.`);
    }
    return result;
  }

  lastError(): string {
    return this.module.ccall('ot_last_error', 'string', [], []) as string;
  }

  apiVersion(): string {
    return this.module.ccall('ot_api_version', 'string', [], []) as string;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Reads the database in `mountpoint`. Use `init` for an iPod that was never set up. */
  open(mountpoint: string): void {
    this.#number('ot_open', ['string'], [mountpoint]);
  }

  /** Sets up an empty iPod with libgpod's own routine, then opens it. */
  init(mountpoint: string, modelNumber: string, name = 'iPod'): void {
    this.#number('ot_init', ['string', 'string', 'string'], [mountpoint, modelNumber, name]);
  }

  /** Writes the database back to the mount point. */
  write(): void {
    this.#number('ot_write');
  }

  close(): void {
    this.module.ccall('ot_close', null, [], []);
  }

  // ------------------------------------------------------------------- device

  device(): DeviceInfo {
    return JSON.parse(this.#text('ot_device_json')) as DeviceInfo;
  }

  kinds(): KindInfo[] {
    return JSON.parse(this.#text('ot_kinds_json')) as KindInfo[];
  }

  // ------------------------------------------------------------------- tracks

  tracks(): TrackInfo[] {
    return JSON.parse(this.#text('ot_tracks_json')) as TrackInfo[];
  }

  /** Creates a track of a kind, with any fields given. Returns its handle. */
  addTrack(kind: Kind, fields: TrackFields = {}): number {
    const handle = this.#number('ot_track_new', ['string'], [kind]);
    this.set(handle, fields);
    return handle;
  }

  setKind(handle: number, kind: Kind): void {
    this.#number('ot_track_set_kind', ['number', 'string'], [handle, kind]);
  }

  setText(handle: number, field: TextField, value: string | null): void {
    this.#number('ot_track_set_string', ['number', 'string', 'string'], [handle, field, value]);
  }

  setNumber(handle: number, field: NumberField, value: number): void {
    this.#number('ot_track_set_number', ['number', 'string', 'number'], [handle, field, value]);
  }

  set(handle: number, fields: TrackFields): void {
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value === 'number') {
        this.setNumber(handle, field as NumberField, value);
      } else {
        this.setText(handle, field as TextField, value ?? null);
      }
    }
  }

  /**
   * Picks a name for a new file on the iPod (Music/F00 to F49) and returns its path under
   * the mount point. Nothing is created. The engine only sees its own in-memory copy of
   * the iPod, so the caller must check the real folder for a clash before writing there.
   */
  destPath(filename: string): string {
    return this.#text('ot_track_dest_path', ['string'], [filename]);
  }

  /** Records that a track's file is now at `destPath` with `size` bytes. */
  commit(handle: number, destPath: string, size: number): void {
    this.#number('ot_track_commit', ['number', 'string', 'number'], [handle, destPath, size]);
  }

  removeTrack(handle: number): void {
    this.#number('ot_track_remove', ['number'], [handle]);
  }

  addChapter(handle: number, startMs: number, title: string): void {
    this.#number('ot_track_add_chapter', ['number', 'number', 'string'], [handle, startMs, title]);
  }

  clearChapters(handle: number): void {
    this.#number('ot_track_clear_chapters', ['number'], [handle]);
  }

  // ---------------------------------------------------------------- playlists

  playlists(): PlaylistInfo[] {
    return JSON.parse(this.#text('ot_playlists_json')) as PlaylistInfo[];
  }

  createPlaylist(name: string): number {
    return this.#number('ot_playlist_create', ['string'], [name]);
  }

  /** Renaming the master playlist renames the iPod itself. */
  renamePlaylist(handle: number, name: string): void {
    this.#number('ot_playlist_rename', ['number', 'string'], [handle, name]);
  }

  deletePlaylist(handle: number): void {
    this.#number('ot_playlist_delete', ['number'], [handle]);
  }

  addToPlaylist(playlist: number, track: number): void {
    this.#number('ot_playlist_add_track', ['number', 'number'], [playlist, track]);
  }

  removeFromPlaylist(playlist: number, track: number): void {
    this.#number('ot_playlist_remove_track', ['number', 'number'], [playlist, track]);
  }
}
