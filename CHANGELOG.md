# Changelog

## Unreleased

### Added
- Environment check page with USB and folder probes.
- Device registry with a verification status per model, and a generated `docs/DEVICE-SUPPORT.md`.
- Browser capability detection and song identity matching in `core/`, with tests.
- Documentation: architecture, roadmap, Android and hardware test guides, engine notes, research notes, third-party notices.
- Reproducible Docker build of the iPod database engine (libgpod to WebAssembly) from pinned, checksum-verified sources, with libgpod patches (the count is in `docs/ENGINE-BUILD.md`).
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

- A read-only SQL function in the engine (`ot_sqlite_query_json`, and `Engine.sqlQuery`) for looking inside the SQLite files of a nano 6G or 7G library. It answers for the collations and functions only Apple's code defines, which a test fixture made for the purpose proves.
- A profile of an SQLite file (rows per table, and how many rows hold a value in each column) and a comparison of two profiles.
- A rewrite check: writes the database into the engine's in-memory copy of an iPod and compares before and after, covering the library as libgpod reads it back, every file, the SQLite files table by table and column by column, and the signatures. It reports what a rewrite would lose, writes nothing to the iPod and leaves track titles out of its report.
- A backup of an iPod's database files (library, device and artwork, no music) to a folder on the computer, with every copy read back, a manifest of SHA-256 checksums and a README on how to put the files back. It refuses an iPod as a destination.
- An in-memory folder that can be written to, for tests.
- Write-back and restore (`engine/js/writeback.ts`): plan which files would change, write them to an iPod only after a complete backup from the session, read each back and check the library and signatures afterwards, and put every changed file back if anything fails. Restore copies a backup back after checking every file against its checksum. Both leave music and artwork alone. Panels for both are in the reader. Tested with in-memory iPods, including a refused write, a damaged write, a failed read-back, an iPod that changed after the plan, a tampered backup and a path that tries to escape.
- Backup folders (`opentunes-backup-*`, `ipod-backups`) are ignored by git, because they hold the device's ID and the library.
- Buttons for the backup and the rewrite check under the reader's result, and a smoke test that runs the rewrite check on the signed demo in headless Chrome.

- The rewrite check reports the library version (`PRAGMA user_version`) of every SQLite file before and after, and lists a rewrite that would take a file to an older version as a problem. A fourth libgpod patch sets version 26, and the version the owner's iPod really holds was not yet known.
- A boundary around each panel in the reader, so a panel that fails to draw shows a message instead of taking the page down. It matters most for the panels that change an iPod, where a silent failure to draw would hide whether a write worked. A smoke scenario fails a panel on purpose and checks the message.
- The media probe, the copy-or-convert planner, the converter (ffmpeg.wasm in a worker, loaded from the app's own origin) and the sync pipeline (add, remove, edit, playlists, orphan cleanup, with backup and rollback). All tested without an iPod: probe on fixtures and a few Apple-encoded files, converter in headless Chrome, sync against in-memory iPods. The ffmpeg core is GPL, noted in `THIRD_PARTY.md`.
- The library screen: add files (probe, plan, convert, sync with backup), remove tracks, edit tags, delete leftover files. A practice iPod held in memory to try it with no iPod, and a smoke scenario that runs the whole flow in headless Chrome.
- The sync refuses an iPod whose music folders have gaps (libgpod picks a folder number below the count of folders and expects every one to exist), with a plain reason, instead of libgpod's raw message.
- A redesigned interface: a landing screen to connect an iPod, a device header with storage and status chips, and tabs for Library, Add music, Backup and Diagnostics. The developer checks (device details, rewrite check, write-back test, browser and USB checks) moved under Diagnostics.
- Add music: choose a whole folder through Chrome's own folder picker (a double-click in the old dialog opened the folder instead of choosing it), subfolders included, in album order (pictures, playlists and system files are left out), an option to add files the iPod already has, and a plain reason next to "Put on the iPod" when it is off (no backup, nothing to copy, too big).
- AV1 video is refused up front with a plain reason, because the converter's ffmpeg cannot decode it (it used to fail mid-run with "Missing Sequence Header"). A file that fails to convert no longer stops the rest of a batch: it is listed as left out. `SMOKE_REAL_MEDIA=/folder npm run smoke` runs a folder of real files through the page on a practice iPod.
- Offload (`engine/js/offload.ts`, the Offload tab): copies every media file under `iPod_Control/Music/Fxx` off the iPod as it is, with the same relative path (`F07/XKQT.mp3`), into a new `opentunes-offload-YYYY-MM-DD-HHMM` folder in a folder the person picks. Pieces of 4 MiB, three files at once, each copy checked by size and read back and compared by CRC-32, files already there with the same size skipped (so a stopped copy is finished by copying again into the same folder), a failed file reported without stopping the rest, and Stop. Writes `library.csv` (one row per track, with its playlists and what happened to its file), `playlists.csv` and `README.txt`, UTF-8 with a byte order mark. Tracks whose file is missing on the iPod are listed. Only reads the iPod and deletes nothing. Tested against in-memory iPods (a full copy, resume, a failed read, a damaged copy, a stop, CSV quoting) and in headless Chrome on a practice iPod. Not run on a real iPod, so the speed over USB is not known.
- "How to arrange your files", a collapsible guide at the top of Add music: a folder tree for music, audiobooks, podcasts, movies, TV shows and music videos, what is read from the names, what is copied and what is converted, the 4 GB limit, and that tags in the file win.
- Folder names set the kind (`app/src/folderRules.ts`): Music/Songs, Audiobooks/Audio Books/Books, Podcasts, Movies/Films, TV Shows/TV/Series/Shows and Music Videos, in any case, with the chosen folder's own name counting. Missing tags are filled from the folders and file names (audiobook author and book, podcast show, TV show, season and episode from `Season N` and `S01E02` or `1x02`, track numbers, movie year), and reach the library. The kind can still be changed per file.
- About, credits and risk: a footer link opens a page with plain use-at-your-own-risk text and a credits list read from `THIRD_PARTY.md` and `docs/ENGINE-BUILD.md`, so each licence is shown as those files state it. A short notice shows once on the first visit. `THIRD_PARTY.md` now also lists Preact, Vite, Vitest and TypeScript, with the licence field of their `package.json`.
- Offload folders (`opentunes-offload-*`) are ignored by git.
- `ScratchFolder` files can be read in pieces (`slice`), like the browser's.

### Changed
- libgpod now runs the lowest SQL command set a nano 6G or 7G offers, not the highest. The rewritten library gets the `is_home_video` column and library version 26, as the library iTunes wrote has. A fourth libgpod patch, found by the rewrite check on the owner's nano 7G.
- The rewrite check keeps data it would lose apart from empty tables and columns that are merely missing, so the verdict is not padded with differences where nothing was held.
- The reader no longer lists video as supported or unsupported for a model libgpod does not know. libgpod judges video from the model number alone and always said no for the owner's nano 7G.
- The loader leaves out `iTunesControl` and `Device/Radio/RadioBuffer`, two 20 MiB files on a nano 7G that libgpod never opens, and lists them in its report.
- Opening a database that libgpod cannot read, such as a never-synced iPod, now explains why. libgpod gave only "unknown error".
- The nano 7G is recorded as supporting photos and podcasts, because the device declares both. Apple's spec page lists neither.
- Project restructured into `app/`, `core/`, `engine/` and `docs/`, with npm workspaces.
- Song identity matching now handles non-Latin scripts and accents, keeps live and remix versions distinct from studio tracks, and keeps everything after the first " - " in a title.

### Removed
- The Node server, the downloader, the Spotify and Last.fm integration, the vendored TunesReloaded fork, the old UI and tests. The old code and its history were removed from this repository.
- The overlapping AI instruction files, replaced by `CLAUDE.md`.
- The v1 prebuilt engine files, the hashAB loader and the fake-mutex thread stubs. The engine is now built from source and runs single-threaded.
- The TunesReloaded C wrapper, replaced by our own. The original had no declared licence and flattened smart playlists before each write.

## 1.0.0

The Node server version, November 2026. Removed from this repository.
