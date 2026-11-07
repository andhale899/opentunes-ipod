# Building the engine

Status: **not started.** This is the Phase 1 plan, written from what the v1 files show. Anything marked unknown has to be found out by trying.

## Why this has to be rebuilt

The iPod database engine is libgpod compiled to WebAssembly, wrapped by `engine/src/ipod_manager.c`. v1 shipped it as prebuilt files that cannot be regenerated:

- The original build script ([legacy/build-original.sh](../engine/legacy/build-original.sh)) points at the original author's machine: `/Users/rishipadmanabhan/Documents/GitHub/libgpod-wasm/src` for libgpod and a micromamba environment named `libgpod-wasm-latest` for glib and friends. Neither is in this repo.
- The wrapper hardcodes `ITDB_MEDIATYPE_AUDIO` for every track ([ipod_manager.c:743](../engine/src/ipod_manager.c#L743)), so video, podcasts and audiobooks cannot be written correctly.
- `ipod_update_track` only edits title, artist, album, genre, track number, year and rating.

Every media feature after music needs a change to the C code, and that needs a build we control.

## What the v1 build linked

From the original script: libgpod, libplist, glib (glib, gmodule, gobject, gthread, gio), libiconv, libffi, libxml2, zlib and SQLite, with a small thread-stub file because WebAssembly here is single-threaded. Flags worth keeping: `MODULARIZE`, `ALLOW_MEMORY_GROWTH` (64 MB start, 512 MB cap), `FORCE_FILESYSTEM`, `ASYNCIFY`, and the exported function list in the script.

## Plan

1. **Tooling.** Docker is installed on the dev Mac, but its daemon was not running when checked on 2026-11-07. Start Docker Desktop. Use the official emscripten image as the base.
2. **Find the libgpod source.** Check whether the author's `libgpod-wasm` fork is public. If it is, pin its commit. If not, start from upstream libgpod and re-create whatever patches WebAssembly needs. Unknown how large that is.
3. **Dependencies.** Build glib, libplist, libxml2, SQLite, zlib, libiconv and libffi for WebAssembly from pinned releases with recorded checksums. Glib is the likely hard part. The v1 author used prebuilt emscripten packages for it, which may be the shortcut.
4. **Wrapper changes** (in `engine/src/`):
   - A media type argument on `ipod_add_track` (audio, video, podcast, audiobook).
   - Podcast flag, audiobook flag, remember-position flag, skip-when-shuffling flag.
   - Expose libgpod's own `itdb_init_ipod` as the way to set up an empty iPod. The v1 wrapper already exports `ipod_init_new`, but nothing called it.
   - Keep artwork support (`ipod_track_set_artwork_from_data`).
   - Photos and chapters are Phase 3 and 4 questions.
5. **Bindings.** A typed TypeScript layer over the exported functions, replacing v1's `ccall` strings.
6. **Reproducibility.** One command (`make engine` or an npm script) that produces the `.js` and `.wasm` from a clean checkout. Output goes to `engine/build/`, which is ignored by git. CI builds it on a cache.

## How it will be tested without hardware

Node tests load the built module and run against fixture iPod folders created by libgpod itself:

- Initialise an iPod for a given model number, then parse it back.
- Add one track of each media kind, write the database, re-read it, and assert the media type, paths and counts.
- Write twice and confirm the second write keeps the first track.

This catches most engine mistakes. It cannot prove a checksum is accepted by real hardware, so models stay `spec-sourced` until the owner runs a sync, see [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

## The hashAB module

The nano 6G and 7G need hashAB. v1 used a 506 KB prebuilt `calcHashAB.wasm` plus a loader (`engine/hashab/`). Its origin is not recorded. It stays as it is until its source and licensing are found, see [../THIRD_PARTY.md](../THIRD_PARTY.md). The nano 7G is the only device available for testing, so this module is on the critical path.
