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
- `npm run smoke`: serves the built app and loads the demo iPod in headless Chrome, failing if the engine does not run there.
- Size, duration and kind formatting helpers in `core`, with tests.

### Changed
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
