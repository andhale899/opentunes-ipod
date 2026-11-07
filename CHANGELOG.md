# Changelog

## Unreleased

### Added
- Environment check page with USB and folder probes.
- Device registry with a verification status per model, and a generated `docs/DEVICE-SUPPORT.md`.
- Browser capability detection and song identity matching in `core/`, with tests.
- Documentation: architecture, roadmap, Android and hardware test guides, engine notes, research notes, third-party notices.
- Reproducible Docker build of the iPod database engine (libgpod to WebAssembly) from pinned, checksum-verified sources, with three libgpod patches.
- hashAB signing compiled into the engine from `dstaley/hashab`, checked against its 100 known-answer vectors.
- Engine tests in Node: lifecycle, every media kind (checked in the SQLite library a nano 7G reads), and signed database writes for a nano 7G-style device.
- A C interface of our own for the engine, with handles, a single field table, and kinds for music, movies, music videos, TV shows, podcasts, video podcasts and audiobooks (with chapters). Typed TypeScript bindings for it.
- Device-declared facts for the nano 7G in the device registry: FAT32, 48 kHz audio limit, video limits, photo and album art formats.
- A read-only iPod reader in the app: loads the engine in the browser, copies an iPod's database files into it (leaving music and macOS clutter behind), and shows device facts, library and playlists. A demo iPod stands in without hardware.
- `npm run smoke`: serves the built app and loads three demo iPods in headless Chrome (a healthy one, a nano 7G-style one with signed databases, and one that was never synced), failing if the engine does not run there or the failure is not explained.
- The environment check now lists what is in `iPod_Control` with file sizes, times each step of the write test, and has a write-speed test.
- USB product ids in the device registry, and a place for facts observed on a real unit. The first is the nano 7G's id, seen on the owner's hardware.
- The reader keeps the list of files it read when something fails, and can copy a diagnostic report.
- An in-memory directory that looks like the browser's, so demo iPods go through the same loader as a real one.
- Size, duration and kind formatting helpers in `core`, with tests.
- A read-only signature check in the engine: it reads the random bytes back out of a signature, then compares the signatures iTunes left on an iPod's `iTunesCDB` and `Locations.itdb.cbk` with what the engine's hashAB computes. The reader shows the result, and includes it in its diagnostic report when a database will not open. Tested with files signed by the engine, files signed with other random bytes, tampered files and a wrong FireWire ID.
- A nano 7G-style demo iPod (iTunesCDB, the iTunes Library.itlp folder, hashAB signatures) and a third smoke scenario that checks its signatures in headless Chrome.
- The second hardware report's facts in the nano 7G's registry entry, and its result in the hardware testing guide.

### Changed
- The reader no longer lists video as supported or unsupported for a model libgpod does not know. libgpod judges video from the model number alone and always said no for the owner's nano 7G.
- The loader leaves out `iTunesControl` and `Device/Radio/RadioBuffer`, two 20 MiB files on a nano 7G that libgpod never opens, and lists them in its report.
- Opening a database that libgpod cannot read, such as a never-synced iPod, now explains why. libgpod gave only "unknown error".
- The nano 7G is recorded as supporting photos and podcasts, because the device declares both. Apple's spec page lists neither.
- Project restructured into `app/`, `core/`, `engine/` and `docs/`, with npm workspaces.
- Song identity matching now handles non-Latin scripts and accents, keeps live and remix versions distinct from studio tracks, and keeps everything after the first " - " in a title.

### Removed
- The Node server, downloader, Spotify and Last.fm integration, the vendored TunesReloaded fork, the old UI and tests. All are on the `v1-legacy` tag, see `docs/LEGACY.md`.
- The overlapping AI instruction files, replaced by `CLAUDE.md`.
- The v1 prebuilt engine files, the hashAB loader and the fake-mutex thread stubs. The engine is now built from source and runs single-threaded.
- The TunesReloaded C wrapper, replaced by our own. The original had no declared licence and flattened smart playlists before each write.

## 1.0.0 (tag `v1-legacy`)

The Node server version, November 2026. See `docs/LEGACY.md`.
