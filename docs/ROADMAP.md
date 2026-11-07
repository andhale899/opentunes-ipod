# Roadmap

Status key: done, in progress, not started. Nothing below is marked done unless it was run.

## Phase 0: Foundation (done on branch `restructure/foundation`, not merged to `main`)

- [x] Tag the v1 code as `v1-legacy`.
- [x] New layout: `app/`, `core/`, `engine/`, `docs/`.
- [x] Device registry with a verification status per model, and a generated support document.
- [x] Capability detection and song identity, with tests that import the real code.
- [x] Environment check page with USB and folder probes.
- [x] Typecheck, test and build pass (`npm run check`).
- [ ] Run the environment check on the owner's Android phone and desktop with the nano 7G, see [ANDROID-TESTING.md](ANDROID-TESTING.md).

## Phase 1: Engine

Goal: a libgpod WebAssembly build that anyone with Docker can reproduce, and a C wrapper that knows about more than audio. Plan in [ENGINE-BUILD.md](ENGINE-BUILD.md).

- [x] Docker toolchain image (emscripten 4.0.23).
- [x] Build glib, libplist, libxml2, SQLite, zlib, libffi and libgpod to WebAssembly from pinned, checksum-verified sources (`npm run engine:build`).
- [x] hashAB compiled into the engine and matched against 100 known-answer vectors.
- [x] Round-trip tests in Node: initialise an iPod, add a track, write, re-read. Plus a signed database write for a nano 7G-style device.
- [ ] Extend the wrapper: media type per track, podcast and audiobook flags, remembered playback position, artwork. Round-trip tests for each kind.
- [ ] Typed TypeScript bindings.
- [ ] Run the engine build and tests in CI.

## Phase 2: Music on the nano 7G

- [ ] Connect: WebUSB identity, folder pick, model lookup, device card.
- [ ] Add files, probe them, plan copy or convert against the registry.
- [ ] Convert in a worker.
- [ ] Sync with backup, verification and resume.
- [ ] Demo iPod mode and a headless smoke test against it.
- [ ] Hardware test on the nano 7G from desktop and from Android, see [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

## Phase 3: More media and management

- [ ] Video, with profiles generated from the registry.
- [ ] Podcasts and audiobooks, including merging files into one M4B with chapters.
- [ ] Library manager: browse, edit, delete, playlists, duplicates, artwork.
- [ ] Playlist import from an Exportify CSV, M3U or Last.fm, matched against files you already own.

## Phase 4: Everything else

- [ ] Photos, if the target models support them. The nano 7G specification lists no photo formats, so this may not apply to it.
- [ ] eBooks as Notes on models that have them, see [research/ebooks.md](research/ebooks.md).
- [ ] Shuffle support (a different database format).
- [ ] Capability data for the other generations, each row sourced.
- [ ] Optional download sources, if a dependable route appears, see [research/spotify-youtube.md](research/spotify-youtube.md).

## Open questions

- Does the nano 7G show photos or podcasts at all? The specification page is silent.
- Which disk format does a restored nano 7G use, and does Android mount it?
- Does libgpod, which does not know the nano 7G model number, give a nano 7G the right artwork formats? Untested until hardware.
- The wrapper has no declared licence. Rewrite it, or ask the author? See [../THIRD_PARTY.md](../THIRD_PARTY.md).
- Does Chrome for Android expose the folder picker for an iPod volume? Phase 0 checks this.
