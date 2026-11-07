# Changelog

## Unreleased

### Added
- Environment check page with USB and folder probes.
- Device registry with a verification status per model, and a generated `docs/DEVICE-SUPPORT.md`.
- Browser capability detection and song identity matching in `core/`, with tests.
- Documentation: architecture, roadmap, Android and hardware test guides, engine plan, research notes, third-party notices.

### Changed
- Project restructured into `app/`, `core/`, `engine/` and `docs/`, with npm workspaces.
- Song identity matching now handles non-Latin scripts and accents, keeps live and remix versions distinct from studio tracks, and keeps everything after the first " - " in a title.

### Removed
- The Node server, downloader, Spotify and Last.fm integration, the vendored TunesReloaded fork, the old UI and tests. All are on the `v1-legacy` tag, see `docs/LEGACY.md`.
- The overlapping AI instruction files, replaced by `CLAUDE.md`.

## 1.0.0 (tag `v1-legacy`)

The Node server version, November 2026. See `docs/LEGACY.md`.
