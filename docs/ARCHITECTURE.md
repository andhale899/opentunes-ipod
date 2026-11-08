# Architecture

OpenTunes is a static web app. Everything runs in the browser: reading the iPod, converting media, writing the database. There is no server component, which is what lets the same app work on a desktop and a phone.

This document describes the target design. Section "What exists" says what is built.

## How a sync works

```
files you pick
   |
   v
probe (codec, bitrate, tags, art)  -->  plan per file: copy / remux / convert / unsupported
   |                                            ^
   |                                            | limits come from the device registry
   v
convert in a worker (ffmpeg.wasm, only when the plan says so)
   |
   v
stream files to iPod_Control/Music/Fxx, three at a time  (File System Access)
   |
   v
add track to database with the right media type (libgpod WASM)
   |
   v
back up iTunesDB, write the new one last, re-read it to verify
```

Three at a time is measured, not a guess. On the owner's nano 7G over USB from Chrome on macOS, closing a file costs about a third of a second whatever its size, one file at a time ran at 8.1 and 8.9 MB/s and three at once at 13.2 and 12.3 MB/s in two runs, see [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

Writing the database last means an interrupted sync leaves the iPod with its old, working database plus some unreferenced files, which a cleanup tool can remove. The previous database is backed up before the first write.

## Pieces

**Device identity (WebUSB).** Reads the iPod's serial number and FireWire ID. Newer models sign their database with a checksum that needs the FireWire ID, so a sync cannot be written without it. The ID is the USB serial number. The old TunesReloaded flow read it over WebUSB once and saved it as `FirewireGuid` in `iPod_Control/Device/SysInfo`, which is where the owner's iPod still has it. This app reads that file first and falls back to WebUSB.

**iPod storage (File System Access).** You pick the iPod's root folder. The app streams files into it rather than holding them in memory.

**Database engine (libgpod as WebAssembly).** libgpod parses and writes the iPod's databases, assigns file paths and sets media types. Album artwork is not built yet. It lives in `engine/` with a C interface of our own and typed bindings, and is built in Docker from pinned sources, see [ENGINE-BUILD.md](ENGINE-BUILD.md).

**Backup (`engine/js/backup.ts`).** Copies the iPod's `iTunes`, `Device` and `Artwork` folders and the files directly in `iPod_Control` to a folder the person picks, reads each copy back, and writes a manifest with a SHA-256 per file and a README on how to put them back. It refuses a destination that holds an `iPod_Control` folder. It is the safety net before the first write.

**Rewrite check (`engine/js/rewrite.ts`, `engine/js/sqlite.ts`).** libgpod rebuilds a nano 6G or 7G's SQLite library files (`iTunes Library.itlp/*.itdb`) from its own model of the library, so anything in them that the model does not carry is lost. The check writes the database into the engine's in-memory copy, then compares before and after: the library as libgpod reads it back, every file, and every table and column of the SQLite files (rows, and how many rows hold a value), plus the signatures. A small read-only SQL function in the engine (`ot_sqlite_query_json`) lets it look inside those files. Nothing is written to the iPod.

**Write-back and restore (`engine/js/writeback.ts`).** The first code that changes an iPod, built to be undone. Planning reads the iPod, writes its database in the engine's memory and lists exactly which files would change. Applying refuses to start without a complete backup made in the session, writes the files one at a time (the signed `Locations.itdb.cbk` and `iTunesCDB` last, removals after everything else), reads each back, then reads the whole iPod back with the engine and checks the library and the signatures. If any step fails, every file already touched is put back from the bytes read before the write. Restoring checks every file of a backup against its checksum before writing the first, copies them back one by one and deletes nothing. Only files under `iPod_Control/iTunes` and `iPod_Control/Device` are written; music and artwork never are.

**Offload (`engine/js/offload.ts`).** Copies every media file under `iPod_Control/Music/Fxx` off the iPod as it is, to a new `opentunes-offload-YYYY-MM-DD-HHMM` folder inside one the person picks. The library is read with the engine first (the same way `findOrphans` does), so `library.csv` and `playlists.csv` can name each file. Files are read in 4 MiB pieces, three at once, and each copy is checked by size and by reading it back and comparing a CRC-32 that was computed while the file was read, so the iPod is read once. A file already in the folder with the same size is skipped, which is how a stopped run is resumed. It reads the iPod and writes only the destination, and it deletes nothing: a copy that fails its check is emptied, not removed, so a resume does not take it for a good one.

**Offload folder, backup folder and Restore everything (`engine/js/offload.ts`).** An offload folder holds everything; a backup folder holds only the database files. A backup (`opentunes-backup-...`) is the iPod's `iTunes`, `Device` and `Artwork` folders and the files directly in `iPod_Control`, with `backup-info.json` and no music. An offload folder (`opentunes-offload-...`) holds the media in `F00`, `F01` and so on, `library.csv`, `playlists.csv`, `README.txt`, `opentunes-offload.json`, and a `database/` folder that is a backup folder in exactly the format `backupIpod` writes: the offload calls `backupIpod` into that folder (`BackupOptions.folderName`), reads each file back and checksums it, so nothing is duplicated. It copies the database files the same read-only way as the media. The marker `opentunes-offload.json` holds the format version, the date, whether the copy is complete, the database folder name, the counts of media files and bytes, and each media file's size and CRC-32 (kept from the copy, so a restore can check against it). It has no serial number or FireWire ID of its own, but the saved device files contain them as the iPod holds them, so the README tells the person to keep the folder private. A stopped run writes a marker marked incomplete; a resumed run saves the (small) database files again and keeps the CRC of files it skips. `restoreOffload` checks the marker and every database file against its checksum before writing anything (`checkBackup`, the same checks `restoreBackup` runs), then copies back each media file the iPod lacks or holds at a different size into `iPod_Control/Music/Fxx` (making a missing `Fxx` folder), in 4 MiB pieces, three at a time. A file whose size already matches is never touched, nothing is deleted, the offload copy is checked against its kept CRC-32 before it is written, and each copy is read back from the iPod and compared by size and CRC-32. Only when every media file is in place does it call `restoreBackup` on `database/`, so the library never lists a file that is not there. A stop works between and inside files; one failed file is reported by name and leaves the database as it was; a stop or failure never starts the database restore. Files libgpod never opens (`iTunesControl`, the radio buffer) are in neither a backup nor an offload, so a wiped iPod does not get them back. The page asks for write permission first, and needs a complete backup of the current state first.

**Folder rules (`app/src/folderRules.ts`).** Pure functions that read a file's folder path inside a chosen folder: which kind the outermost known folder name means, and which tags the folder and file names can fill in. Only tags the file lacks are filled. `addFiles.ts` applies them when a folder is chosen, so the kind becomes the file's `userKind` and the tags reach `SyncItem.info.tags`. The guide people read (`FolderGuide.tsx`) describes the same rules.

**About page (`app/src/About.tsx`, `app/src/credits.ts`).** Reads `THIRD_PARTY.md` and `docs/ENGINE-BUILD.md` into the page at build time and shows each licence as those files state it, so a licence is never typed twice.

**Checksums.** Newer models refuse a database that is not signed. libgpod picks the scheme from the device's own `SysInfoExtended` file and signs the database itself. For the nano 6G and 7G that scheme is hashAB, whose code libgpod does not contain, so the engine compiles the public-domain `dstaley/hashab` implementation in and libgpod calls it directly. Which model needs which scheme is recorded in the registry as each is confirmed.

**Converter (ffmpeg.wasm).** Runs in a worker, only for files that cannot be copied as they are. Single-threaded conversion works everywhere but is slow on a phone, so the planner copies compatible files untouched wherever it can. Multi-threaded conversion needs cross-origin isolation, which the dev server sets and a hosted copy would need headers or a service worker for.

**Device registry (`core/src/devices`).** The single source of truth for what each model can play. The planner and the generated [DEVICE-SUPPORT.md](DEVICE-SUPPORT.md) both read it, so limits are never typed twice. Each row carries a status: `hardware-tested`, `spec-sourced` or `unverified`.

**Demo iPod (OPFS).** A folder in the browser's private storage that stands in for an iPod. It lets the app, and its automated tests, run the whole sync path without hardware.

## Decisions

| Decision | Why |
| --- | --- |
| No backend | One app for desktop and Android, nothing to host or install. |
| Chromium only | WebUSB and folder access exist only in Chromium browsers. Any of them on any OS where the iPod mounts as a drive can work: macOS, Linux and other Unix, ChromeOS, Android (where Chrome offers the folder picker) and Windows (WebUSB may need a driver). Safari, Firefox and iOS cannot reach an iPod this way. |
| libgpod, not a hand-written database | The v1 app wrote a binary iTunesDB by hand with placeholder values. libgpod already knows every model's format. |
| Registry-driven limits | v1 had a hand-typed profile table with no sources, and some rows disagreed with Apple's published limits. |
| Preact and TypeScript | Small, typed, and the app is a handful of screens. One typed worker API replaces v1's three-way iframe bridge. |
| Database written last, with backup | A failed sync must not leave an iPod unusable. |

**AI assistant (`app/src/ai/`, `app/src/AssistantPanel.tsx`).** The one place the page talks to another server, and only after an explicit opt-in. A pure digest (`digest.ts`) turns the library into short numbered lines with no paths; `providers.ts` posts it with `fetch` to Anthropic or an OpenAI-style endpoint with forced tool use; `schema.ts` defines the three tools and validates every answer, dropping what is not allowed. The model proposes only. The ticked proposals become `TrackEdit[]` and `PlaylistChange[]` (`apply.ts`) and go through the same planning, backup gate, read-back and rollback as the Library tab. What is sent and stored is in [AI-ORGANISER.md](AI-ORGANISER.md).

**Find duplicates (`app/src/library/duplicates.ts`, `DuplicatesPanel.tsx`, `app/src/ai/review.ts`).** Pure code groups the same song by the identity helpers in `core` with a length tolerance, keeps live and remix versions apart, recommends one copy to keep by a documented score, and builds the playlist steps that stop a playlist losing a song when its copy goes. Removal reuses `planRemoval` and `applyRemoval` behind the backup gate. An optional AI review sends only the candidate groups and can only change tick boxes.

## What exists

- `core/`: capability detection, song identity, device registry, with tests.
- `app/`: the environment check page with its hands-on probes (USB, folder read and write), and the read-only iPod reader, which loads the engine in the browser, copies an iPod's database files into it, checks the signatures on them and shows what it finds. Demo iPods stand in when there is no hardware.
- `engine/`: a reproducible Docker build of libgpod, a C interface of our own that handles all seven media kinds, playlists and chapters, typed bindings, and tests in Node.

Also built since: offload (copy everything off the iPod), the folder guide and folder-name detection in Add music, and the About page. Not built yet: album artwork and the full library manager. See [ROADMAP.md](ROADMAP.md).
