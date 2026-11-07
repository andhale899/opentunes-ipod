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
- [x] A C interface of our own, replacing v1's wrapper: all seven media kinds with their flags, podcast playlist, chapters, playlists, stable handles. A test for each kind, including the SQLite library a nano 7G reads.
- [x] Typed TypeScript bindings, checked against the C field table by a test.
- [ ] Album artwork and photos: build gdk-pixbuf for WebAssembly and teach libgpod the newer `AlbumArt2` and `ImageSpecifications2` keys the nano 7G uses.
- [ ] Run the engine build and tests in CI.

## Phase 2: Music on the nano 7G

- [x] Read an iPod's database in the browser, read only, and show the device facts, library and playlists (built, with a demo iPod and a headless-Chrome smoke test). Not yet tried on a real iPod.
- [x] Check, read only, that the signatures iTunes left on an iPod (`iTunesCDB` and `Locations.itdb.cbk`) are what the engine's own hashAB computes. Tested against engine-made files and files signed with other random bytes, and shown in the reader. Not yet run on the real iPod, and it is the gate before the first write.
- [ ] Connect: WebUSB identity alongside the folder pick, model lookup against the registry, a proper device card.
- [ ] Add files, probe them, plan copy or convert against the registry.
- [ ] Convert in a worker.
- [ ] Sync with backup, verification and resume.
- [ ] Hardware test on the nano 7G from desktop and from Android, see [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

## Phase 3: More media and management

- [ ] Video, with profiles generated from the registry.
- [ ] Podcasts and audiobooks, including merging files into one M4B with chapters.
- [ ] Library manager: browse, edit, delete, playlists, duplicates, artwork.
- [ ] Playlist import from an Exportify CSV, M3U or Last.fm, matched against files you already own.

## Phase 4: Everything else

- [ ] Photos. The nano 7G declares photo support (480x864 full screen and 80x80 thumbnails), so this applies to it. Needs the engine artwork work from Phase 1.
- [ ] eBooks as Notes on models that have them, see [research/ebooks.md](research/ebooks.md).
- [ ] Shuffle support (a different database format).
- [ ] Capability data for the other generations, each row sourced.
- [ ] Optional download sources, if a dependable route appears, see [research/spotify-youtube.md](research/spotify-youtube.md).

## Open questions

- Do photos and podcasts work on a real nano 7G? Its own file declares both. Apple's page is silent.
- Android mounting. The owner's nano 7G looks FAT (it holds System Volume Information and LOST.DIR), and LOST.DIR means Android has mounted it. Not yet tried with this app.
- Per-file cost of writing to the iPod from Chrome. The first run took 3.7 seconds for a two-byte file, the second 1.49, of which closing the file was 1.47. The speed test compares one file at a time with several at once, and the result decides how a sync writes.
- libgpod leaves an empty `iTunesDB` beside `iTunesCDB`. The owner's real nano 7G has no `iTunesDB` at all. Does the iPod mind the empty file? Untested. If it does, the sync can remove the file when the iPod had none.
- Smart playlists are now written back untouched. Does libgpod write a real nano 7G's smart playlists without error? Untested until hardware.
- Does libgpod, which does not know the nano 7G model number, cope everywhere else? Checksum and capabilities work. Artwork does not yet.
- Does Chrome for Android expose the folder picker for an iPod volume? Phase 0 checks this.
