# The engine

The engine is libgpod, the library that reads and writes an iPod's databases, compiled to WebAssembly together with a small C wrapper (`engine/src/ipod_manager.c`). The app talks to it through a handful of functions: set a mount point, parse or initialise a database, add and remove tracks, write the database back.

## Status

Built from pinned sources and tested in Node. **Not yet tested on hardware**, and **not yet extended beyond audio**: the wrapper still tags every track as audio, so video, podcasts and audiobooks wait for the next step (see "Next").

## Build and test

You need Docker running.

```
npm run engine:build    # builds in Docker, copies the result to engine/build/
npm run engine:test     # runs the engine tests in Node against that build
```

The first build compiles every dependency from source and takes a few minutes. Later builds reuse Docker's layer cache, so changing only the wrapper rebuilds in seconds. The output is `engine/build/ipod_manager.js` and `ipod_manager.wasm` (about 2.7 MB), which git ignores.

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
2. **Public headers**: installs `itdb_device.h` and `itdb_sysinfo_extended_parser.h`. This tree marks them internal, but device information is needed by the wrapper.
3. **hashAB**: libgpod looks for an external `libhashab` shared library and refuses to write a nano 6G or 7G database without it. A WebAssembly module cannot load one, so the patch points libgpod at the built-in `calcHashAB` instead.

Build decisions:

- **Single-threaded.** glib's build records `-pthread` in its pkg-config files. That is stripped, so the engine needs no SharedArrayBuffer and runs in any worker.
- **One glib shim** (`engine/src/glib_shims.c`). The patched glib leaves `g_io_channel_unix_new` undefined, and every `g_assert` pulls in a reference to it. A strict test link showed it is the only missing symbol, so a function returning NULL fixes it. Nothing here uses glib's test framework.
- **No warning suppression.** v1 hid implicit declarations and integer conversions. The wrapper compiles with `-Wall` and zero warnings against this libgpod.

## What the tests show

`engine/test/` has two files, nine tests.

- **Round trip**: initialise an iPod, check the folders and `mhbd` database header, add a track, write, and read it back in a fresh engine instance.
- **hashAB**: all 100 known-answer vectors from the hashab project match the hash compiled into the engine. A nano 7G-style device (a SysInfoExtended with `DBVersion` 5) selects hashAB, writes a signed `iTunesCDB` and `Locations.itdb.cbk`, and a missing or malformed FireWire ID makes the write fail.

They show the engine builds, writes and reads databases, and produces the signatures hashAB devices expect. **They do not show that a real iPod accepts the result.** That needs a hardware run, see [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

## What was learned about the nano 7G

- libgpod picks the checksum from the device's own `SysInfoExtended` when it exists: `DBVersion` 5 means hashAB. No change to libgpod's model table is needed for that. The app should read the file from the iPod and use the v1 templates in `engine/data/` only as a fallback.
- For this family libgpod writes an empty `iTunesDB`, a signed `iTunesCDB`, and an `iTunes Library.itlp` folder of SQLite files with a signed `Locations.itdb.cbk`.
- The FireWire ID can come from `SysInfoExtended` alone. If it is malformed, the write fails with "an error occurred during Locations.itdb.cbk generation", which says nothing useful. The app must check the ID is 16 hex digits before writing.
- libgpod's model table stops at the nano 6G, so a real nano 7G model number is not recognised. What that costs for artwork formats is untested.
- The two templates in `engine/data/` were dumped from a real device. Its serial and board serial are scrubbed, and the FireWire ID is a placeholder to fill in.

## Next

1. Extend the wrapper: a media type per track (audio, video, podcast, audiobook), the flags that give podcasts and audiobooks their iPod behaviour (remember position, skip when shuffling), and artwork.
2. Typed TypeScript bindings in place of `ccall` strings.
3. Run the engine tests in CI.
4. Rewrite the wrapper rather than extend it, if its licence stays unresolved. GitHub shows no licence on the upstream TunesReloaded repository.
