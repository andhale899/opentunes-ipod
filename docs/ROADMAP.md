# Roadmap

Status key: done, in progress, not started. Nothing below is marked done unless it was run.

## Phase 0: Foundation (done on branch `restructure/foundation`, not merged to `main`)

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

- [x] Read an iPod's database in the browser, read only, and show the device facts, library and playlists (built, with demo iPods and a headless-Chrome smoke test). Run on the owner's nano 7G: it read 942 music tracks and 2 playlists.
- [x] Check, read only, that the signatures iTunes left on an iPod (`iTunesCDB` and `Locations.itdb.cbk`) are what the engine's own hashAB computes. Tested against engine-made files and files signed with other random bytes, and shown in the reader. Run on the owner's nano 7G: both signatures match, so the engine signs the way this iPod expects.
- [x] Back up an iPod's database files to a folder on the computer, with every copy read back and a manifest of checksums (built and tested with in-memory folders, not yet run on a real iPod).
- [x] Rewrite check: write the database in memory as a sync would and compare it with what is on the iPod, including the SQLite files a nano 7G keeps. Run on the owner's nano 7G, see the open questions. Needs a read-only SQL function in the engine, so the engine was rebuilt.
- [x] Write-back and restore: write the rebuilt database back to an iPod after a verified backup, roll back on any failure, and restore a backup after checking its checksums. Built and tested against in-memory iPods, not yet run on a real one. It is the first real test of whether a nano 7G accepts libgpod's rebuilt library.
- [ ] Connect: WebUSB identity alongside the folder pick, model lookup against the registry, a proper device card.
- [x] Probe: tags, codecs, length, chapters and cover art from MP3, AAC, M4A/M4B/M4V/MP4/MOV, FLAC, WAV, AIFF, Ogg and Opus, and codec names from MKV, AVI and WMA (`core/src/media/probe/`). Built with 280 tests on fixtures, damage handling and large virtual files, checked against a few Apple-encoded audio files. Not yet tried on real video, a LAME VBR MP3, an M4B with chapters, FairPlay, Ogg/Opus or MKV, and not in Chrome.
- [x] Plan copy or convert against the registry (`core/src/media/decide.ts`). Unit-tested, not yet fed real probe output.
- [x] Convert in a worker (`app/src/convert/`): audio to AAC-LC or Apple Lossless, video to H.264 within the spec, audiobook merge to m4b with exact chapter marks. Built and browser-tested in headless Chrome (real worker and wasm, outputs read back with ffprobe). Not hardware-tested. Known limits: AV1 video cannot be decoded (the ffmpeg core has no AV1 decoder, so the app refuses it up front), output held in browser memory, capped at 1 GiB. Run on the real test files in `tunes/testmedia` in headless Chrome: FLAC, Ogg, Opus, 96 kHz WAV, H.264 1080p and 360p, HEVC and VP9 all converted (not played on an iPod). Streaming output to disk (OPFS) would lift it. The GPL licence of the ffmpeg core needs a decision before any sharing.
- [x] Sync pipeline (`engine/js/sync.ts`): add, remove, edit tags, playlists and orphan cleanup, with backup, per-file read-back and rollback. Tested against in-memory iPods only. Known gaps: no automatic recovery if the tab dies mid-run (restore the backup, `findOrphans` lists leftover files), no resume, album art not written, Chrome `.crswap` leftovers not detected.
- [x] Library screen (`app/src/AddPanel.tsx`, `ManagePanel.tsx`): pick files, see what happens to each (copy, convert, or why not), convert, plan, copy with the backup in place, then remove tracks, edit title, artist, album and genre, and delete leftover files. Tested in headless Chrome on a practice iPod held in memory, with the real converter (one file copied, one converted, one removed, one title edited). The probe and planner were also run on the real test files in `tunes/testmedia`. Not run on the real nano. Not built yet: playlist editing after the fact (new tracks can go in a named playlist), album art, resume after a crash, picking the model from USB (the model is chosen from a list, nano 7G by default).
- [x] Offload: copy everything off the iPod to a folder as it is, with a library spreadsheet (`engine/js/offload.ts`, Offload tab). Built and tested with in-memory iPods and in headless Chrome on a practice iPod (copy, resume, a failed read, a damaged copy, stop, CSV quoting). Not run on a real iPod: the copy speed over USB, and files bigger than a few hundred MB, are untried.
- [x] Folder guide and folder-name detection in Add music (`FolderGuide.tsx`, `folderRules.ts`): kinds from folder names, missing tags from folder and file names. Unit-tested, and run through the page in headless Chrome with one folder named Audiobooks. Not tried on a real library of files.
- [x] About, credits and risk page and first-visit notice (`About.tsx`), with the credits read from `THIRD_PARTY.md`. Checked in headless Chrome. A person has not yet read it for wording.
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

## Open questions

- Do photos and podcasts work on a real nano 7G? Its own file declares both. Apple's page is silent.
- Does a real nano 7G play video? libgpod cannot tell for a model it does not know (it always says no). The description file from another unit declares video, but the reader does not yet parse the owner's own file to confirm.
- Resolved: the nano 7G accepts the library libgpod rebuilds, for a rewrite with no new songs. The owner wrote it to their iPod after a verified backup and reported that everything looked good. The differences the rewrite check lists (6 of 8 built-in lists not written, played flags, genre order, location kinds, `Genius.itdb` version) did not show. Not yet shown with new songs, with video, podcasts or artwork, or on other iPods.
- Android mounting. The owner's nano 7G looks FAT (it holds System Volume Information and LOST.DIR), and LOST.DIR means Android has mounted it. Not yet tried with this app.
- Resolved: how to write files. Closing a file costs about 0.33 seconds whatever its size (first runs 3.7 and 1.49 seconds, the speed test median 0.327). One 8 MB file ran at 8.1 MB/s and three 4 MB files at once at 13.2 MB/s, so a sync writes three files at a time. A second run agreed (312 ms, 8.9 MB/s for one file, 12.3 MB/s for three at once). Both were one iPod on macOS, so revisit if Android or Linux differ.
- libgpod leaves an empty `iTunesDB` beside `iTunesCDB`. The owner's real nano 7G has no `iTunesDB` at all. Does the iPod mind the empty file? Untested. If it does, the sync can remove the file when the iPod had none.
- Smart playlists are now written back untouched. Does libgpod write a real nano 7G's smart playlists without error? Untested until hardware.
- Does libgpod, which does not know the nano 7G model number, cope everywhere else? Checksum and capabilities work. Artwork does not yet.
- Does Chrome for Android expose the folder picker for an iPod volume? Phase 0 checks this.
- Small known difference, left alone until the nano has been tried: iTunes leaves `Genius.itdb` at library version 2 and libgpod writes 0. The file is empty either way. The fix is one line in libgpod's `mk_Genius` (`PRAGMA user_version = 2` when the file is made), as a fifth patch. Library.itdb's version already matches: the iPod holds 26 and the patched rewrite writes 26.
