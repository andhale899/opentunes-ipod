# The engine

The engine is libgpod, the library that reads and writes an iPod's databases, compiled to WebAssembly together with a small C interface of our own, [engine/src/engine.c](../engine/src/engine.c). The app talks to it through typed bindings, [engine/js/engine.ts](../engine/js/engine.ts).

## Status

Built from pinned sources and tested in Node. **Not yet tested on hardware.** It handles all seven media kinds (music, movies, music videos, TV shows, podcasts, video podcasts, audiobooks), playlists, chapters, and the signed databases the nano 6G and 7G need.

Gaps, all recorded in [ROADMAP.md](ROADMAP.md):

- **Album artwork and photos.** libgpod needs gdk-pixbuf for them, which is not built. The nano 7G also declares its image formats under newer keys (`AlbumArt2`, `ImageSpecifications2`) that this libgpod does not read.
- **Smart playlists** are written back untouched, but that has not been tested against a real one.
- libgpod does not know the nano 7G's model number. Its checksum and capabilities come from the device's own `SysInfoExtended`, which works. What it costs elsewhere is untested.

## Build and test

You need Docker running.

```
npm run engine:build    # builds in Docker, copies the result to engine/build/
npm run engine:test     # runs the engine tests in Node against that build
```

The first build compiles every dependency from source and takes a few minutes. Later builds reuse Docker's layer cache, so changing only the C interface rebuilds in seconds. The output is `engine/build/engine.js` and `engine.wasm` (about 2.7 MB), which git ignores.

## What goes into it

All versions and SHA-256 checksums are in [engine/Dockerfile](../engine/Dockerfile). A download that does not match its checksum stops the build.

| Piece | Version | Notes |
| --- | --- | --- |
| emscripten | 4.0.23 | The official `emscripten/emsdk` image. |
| zlib, SQLite, libxml2, libplist | pinned | Built from source. SQLite is compiled from the amalgamation, single-threaded. |
| libffi | 3.5.2 | 3.4.6 does not link: it asks emscripten 4.x for JS helpers that were renamed. |
| glib | 2.80.5 | With the emscripten patch series from the emscripten-forge recipe. glib's runtime checks stay on, unlike that recipe. |
| libgpod | `gtkpod/libgpod` commit `7982c55` | The 0.8.2-era tree, last commit May 2012. Plus three patches of ours. |
| hashAB | `dstaley/hashab` commit `f80d464` | Public-domain C code, compiled into the engine. |

The author of the original TunesReloaded build kept a private libgpod fork, so none of this is a copy of their build. It was reconstructed from public sources.

## Our changes

libgpod patches, in `engine/patches/libgpod/`:

1. **`itdb_zlib.h`**: includes glib before using `G_BEGIN_DECLS`. The 2012 code relied on another header having done it.
2. **Public headers**: installs `itdb_device.h` and `itdb_sysinfo_extended_parser.h`. This tree marks them internal, but device information is needed.
3. **hashAB**: libgpod looks for an external `libhashab` shared library and refuses to write a nano 6G or 7G database without it. A WebAssembly module cannot load one, so the patch points libgpod at the built-in `calcHashAB` instead.

Build decisions:

- **Single-threaded.** glib's build records `-pthread` in its pkg-config files. That is stripped, so the engine needs no SharedArrayBuffer and runs in any worker.
- **One glib shim** (`engine/src/glib_shims.c`). The patched glib leaves `g_io_channel_unix_new` undefined, and every `g_assert` pulls in a reference to it. A strict test link showed it is the only missing symbol, so a function returning NULL fixes it. Nothing here uses glib's test framework.
- **Strict warnings.** `engine.c` compiles with `-Wall -Wextra` and no suppressions.

## The C interface

Written for this project, replacing the TunesReloaded wrapper v1 used (which had no declared licence). Its design:

- **Handles, not indexes.** Tracks and playlists are integers that stay valid until the database is closed. Removing one track never changes another's handle.
- **One field table.** Track fields are read and written by name from a single table in `engine.c`, so the JSON the engine returns and the setters cannot disagree. A test checks the TypeScript field lists match it.
- **Kinds are presets.** A track's kind sets libgpod's media type and the flags that belong with it, and keeps podcast playlist membership right.
- **Nothing silent.** Failures return -1 with a reason in `ot_last_error()`, and the bindings throw it as an `EngineError`. v1's wrapper flattened every smart playlist into a plain one before each write. This one leaves existing data alone, and if libgpod cannot write something the write fails with an error.
- **Quiet.** No debug printing. The bindings pass a `verbose` option for libgpod's own messages.

| Kind | Media type | Appears under | Also set |
| --- | --- | --- | --- |
| `music` | 0x01 | Music | |
| `movie` | 0x02 | Movies | movie flag |
| `music-video` | 0x20 | Music Videos | movie flag |
| `tv-show` | 0x40 | TV Shows only | movie flag, show, season and episode fields |
| `podcast` | 0x04 | Podcasts | skip shuffle, remember position, "now playing" style, unplayed bullet, member of the podcast playlist |
| `video-podcast` | 0x06 | Podcasts | as `podcast`, plus movie flag |
| `audiobook` | 0x08 | Audiobooks | skip shuffle, remember position, chapters, saved position |

The values come from libgpod's own documentation of its track structure. The tests check they are written and read back, and that the nano 7G's SQLite library records the same media kind. They do not show what a given iPod displays, which needs hardware.

## What the tests show

`engine/test/` runs against the built module in Node, with the iPod as a folder in memory.

- **Lifecycle:** set up, add, write, restart and reopen, edit, remove, playlists, unicode text, number clamping, and the error messages.
- **Kinds:** every kind with its flags, the podcast playlist, audiobook chapters, TV show fields, and the media kinds in `Library.itdb`, the SQLite file a nano 7G reads, checked with Node's built-in SQLite.
- **hashAB:** all 100 known-answer vectors from the hashab project match the hash compiled into the engine. A nano 7G-style device writes a signed `iTunesCDB` and `Locations.itdb.cbk` and reads them back, and a malformed FireWire ID makes the write fail.

They show the engine builds, writes, reads and signs correctly. **They do not show that a real iPod accepts the result.** That needs a hardware run, see [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

## What was learned about the nano 7G

From a SysInfoExtended dumped from a real nano 7G (`engine/data/`), which the device uses to describe itself:

- libgpod picks the checksum from that file: `DBVersion` 5 means hashAB. No change to libgpod's model table is needed. The app should read the file from the iPod and use the templates only as a fallback.
- The disk format is FAT32, so Android can mount it.
- It declares photo support (a 480x864 full-screen format and an 80x80 thumbnail), podcasts, and these album art sizes: 240x240, 58x58, 57x57 and 50x50. All are RGB565.
- Video: H.264 Baseline, Main and High at level 3.0 up to 720x576, and a separate Baseline entry capped at 640x480. Audio tops out at 48 kHz.
- For this family libgpod writes an empty `iTunesDB`, a signed `iTunesCDB`, and an `iTunes Library.itlp` folder of SQLite files with a signed `Locations.itdb.cbk`.
- libgpod reads `iTunesCDB` first and `iTunesDB` second, so an iPod with only an `iTunesCDB` opens fine (tested). An iPod whose only database is an empty `iTunesDB` is what a never-synced one looks like. libgpod fails on it without a reason, so the engine says so itself.
- The FireWire ID can come from `SysInfoExtended` alone. If it is malformed, the write fails with "an error occurred during Locations.itdb.cbk generation", which says nothing useful. The app must check the ID is 16 hex digits before writing.
- The template was dumped from someone else's unit, with its serial numbers removed. Compare it with the file on your own iPod.

## Next

1. Album artwork and photos: build gdk-pixbuf for WebAssembly, and teach libgpod the `*2` image keys.
2. A hardware run on the nano 7G.
3. Run the engine tests in CI.
