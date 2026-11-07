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
stream file to iPod_Control/Music/Fxx  (File System Access)
   |
   v
add track to database with the right media type (libgpod WASM)
   |
   v
back up iTunesDB, write the new one last, re-read it to verify
```

Writing the database last means an interrupted sync leaves the iPod with its old, working database plus some unreferenced files, which a cleanup tool can remove. The previous database is backed up before the first write.

## Pieces

**Device identity (WebUSB).** Reads the iPod's serial number and FireWire ID. Newer models sign their database with a checksum that needs the FireWire ID, so a sync cannot be written without it.

**iPod storage (File System Access).** You pick the iPod's root folder. The app streams files into it rather than holding them in memory.

**Database engine (libgpod as WebAssembly).** libgpod parses and writes the iTunesDB, assigns file paths, sets media types and writes artwork. It lives in `engine/`. The v1 build is kept as prebuilt files; Phase 1 replaces it with a reproducible Docker build, see [ENGINE-BUILD.md](ENGINE-BUILD.md).

**Checksums.** Newer models refuse a database that is not signed. libgpod handles most signing schemes itself. The nano 7G appears to need hashAB, which libgpod does not provide, so v1 used a separate prebuilt module (`engine/hashab/`). Which model needs which scheme is recorded in the registry as each is confirmed.

**Converter (ffmpeg.wasm).** Runs in a worker, only for files that cannot be copied as they are. Single-threaded conversion works everywhere but is slow on a phone, so the planner copies compatible files untouched wherever it can. Multi-threaded conversion needs cross-origin isolation, which the dev server sets and a hosted copy would need headers or a service worker for.

**Device registry (`core/src/devices`).** The single source of truth for what each model can play. The planner and the generated [DEVICE-SUPPORT.md](DEVICE-SUPPORT.md) both read it, so limits are never typed twice. Each row carries a status: `hardware-tested`, `spec-sourced` or `unverified`.

**Demo iPod (OPFS).** A folder in the browser's private storage that stands in for an iPod. It lets the app, and its automated tests, run the whole sync path without hardware.

## Decisions

| Decision | Why |
| --- | --- |
| No backend | One app for desktop and Android, nothing to host or install. |
| Chrome only | WebUSB and folder access exist only in Chromium browsers. Safari, Firefox and iOS cannot reach an iPod this way. |
| libgpod, not a hand-written database | The v1 app wrote a binary iTunesDB by hand with placeholder values. libgpod already knows every model's format. |
| Registry-driven limits | v1 had a hand-typed profile table with no sources, and some rows disagreed with Apple's published limits. |
| Preact and TypeScript | Small, typed, and the app is a handful of screens. One typed worker API replaces v1's three-way iframe bridge. |
| Database written last, with backup | A failed sync must not leave an iPod unusable. |

## What exists

- `core/`: capability detection, song identity, device registry, with tests.
- `app/`: the environment check page and two hands-on probes (USB, folder read and write).
- `engine/`: the C wrapper and prebuilt files carried over from v1, unchanged. The wrapper tags every track as audio, which is why video, podcasts and audiobooks wait for Phase 1.

Not built yet: the engine rebuild, converter, planner, sync, library manager. See [ROADMAP.md](ROADMAP.md).
