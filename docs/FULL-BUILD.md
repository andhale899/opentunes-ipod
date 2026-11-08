# Full build for the nano 7th generation

The plan for turning what exists (a proven database path: read, rewrite check, backup, write-back, restore) into an app that puts every kind of media the nano 7G supports on it. This is a design and a work split. Nothing in it is claimed to work until it has been run, and the nano 7G stays `spec-sourced` in the registry until a real sync has been recorded in [HARDWARE-TESTING.md](HARDWARE-TESTING.md).

## What "everything" means for this iPod

Built: music (MP3, AAC, Apple Lossless, WAV, AIFF, with conversion of FLAC, Ogg, Opus, WMA and others), podcasts, audiobooks (with chapters, and many files merged into one M4B), movies, music videos, TV shows and video podcasts (H.264, converted when needed), album artwork, photos, playlists, deleting tracks, duplicate detection, and connecting (reading the iPod's ID over USB).

Not built, and why:
- **eBooks.** Apple's page for the nano 7G does not list Notes or books, and the device's own description file does not declare them. The planner reports them as unsupported on this model. [research/ebooks.md](research/ebooks.md).
- **Fetching podcast feeds.** A browser cannot read other sites' feeds without a server, and this project has none. Podcast episodes you already have as files are supported.
- **Downloading from YouTube or Spotify.** Not part of this app.
- **Other iPod models.** The registry holds their data. Only the nano 7G is built for and tested.

## The flow

```
files picked in the browser
  -> probe          read tags, codecs, sizes, chapters, artwork         core/src/media/probe
  -> decide         copy, convert or unsupported, from the registry     core/src/media/decide
  -> convert        ffmpeg.wasm in a worker, only when decide says so   app/src/convert
  -> sync           add tracks, copy files 3 at a time, write the DB,   engine/js/sync.ts
                    verify, roll back on failure (builds on writeback.ts)
  -> images         album art and photos                                 engine + libgpod
  -> library UI     browse, edit, delete, playlists, progress            app/src
```

The shared shapes are in `core/src/media/types.ts` (`MediaInfo`, `FileSource`, `ConversionSpec`, `PlanDecision`, `ContentKind`). Change them only with a good reason, and say so, because every part depends on them.

## The parts

**Probe** (`core/src/media/probe/`, entry `probeMedia(source: FileSource): Promise<MediaInfo>`). No dependencies, runs in Node and the browser, reads a file in pieces. Formats: MP3 (ID3v2.2, 2.3, 2.4, ID3v1, Xing, VBRI and LAME headers for duration), AAC (ADTS), MP4 family (M4A, M4B, M4V, MP4, MOV: iTunes metadata atoms including `stik`, chapters from `chpl` or a chapter text track, codec and size from `stsd`), FLAC (STREAMINFO, Vorbis comments, pictures), WAV, AIFF, Ogg (Vorbis and Opus, tags and duration), and enough of MKV, WebM, AVI and WMA to name the codecs. Cover art comes out as `artwork`. A damaged or truncated file gives warnings, never an exception.

**Decide** (`core/src/media/decide.ts`). `inferKind(info)` and `decideForDevice(info, device, options)` read the registry's media rules (`DeviceModel.media`, `deviceDeclared`) and return a `PlanDecision`: copy when the iPod plays it as it is, convert with a `ConversionSpec` when it can after conversion, unsupported with a plain reason otherwise. Sample rates above the model's limit, bit depths, bitrates, H.264 profile, level, size and frame rate, DRM, and eBooks all feed it. Nothing is hard-coded to the nano 7G: it reads the registry.

**Convert** (`app/src/convert/`). ffmpeg.wasm in a Web Worker, files from the planner's spec: audio to AAC or Apple Lossless, video to H.264 within the model's limits with AAC audio, chapters kept for audiobooks, artwork kept, tags kept, and many audio files merged into one M4B with chapter marks. The wasm is vendored into `app/public/ffmpeg/` by a script, like the engine, and loaded from the same origin. Progress and cancel.

**Sync** (`engine/js/sync.ts`, builds on `writeback.ts`). Takes prepared items (`SyncItem`: the probed info, the kind, the bytes to put on the iPod, field overrides, playlist names), plans against the iPod in memory (duplicates, space, a path for each file from the engine), and applies: needs a complete backup, copies media files three at a time and checks each, adds the tracks and playlists, writes the database with the existing plan and verify path, reads the iPod back, and on any failure puts everything back, including deleting the media files it copied. Also removes tracks (the file and the entry) and edits tags and playlists. Interrupted runs leave files the database does not list, and a cleanup finds and removes them.

**Images** (`engine/js/artwork.ts`, `app/src/albumArt.ts`, `app/src/artLookup.ts`). Album art is built, photos are not. libgpod needs gdk-pixbuf to write either, so the route taken is a writer of our own for the nano 7G's ArtworkDB and thumbnails, with the browser's canvas doing the decoding, see [ARTWORK-RESEARCH.md](ARTWORK-RESEARCH.md) and [ART-LOOKUP.md](ART-LOOKUP.md). The sync writes art only when it is given a decoder, and `engine.canLinkArtwork` says whether the engine build can mark a track as having art. Not tried on a real iPod.

**Connect** (`app/src/connect.ts`). Reads the iPod's USB serial (its FireWire ID), looks the model up by USB product id, and writes `Device/SysInfo` when the file is missing, as the old TunesReloaded did.

**Library UI** (`app/src/`). The device card, browsing and searching the library, editing tags, deleting, playlists, adding files with the plan table, progress, the sync button, and the backup and restore panels that exist.

## Rules for everyone building a part

- Work in your own checkout and branch. Do not merge, push, publish or deploy anything. Nothing goes on the internet.
- Do not touch an iPod, the `bkp` folder, or the dev server on port 5173. Use other ports (the smoke test reads `SMOKE_PORT`).
- Set up with `npm install --no-audit --no-fund`, and copy `engine/build/` from the main checkout when the engine is needed (it is not in git).
- Tests import real code. Say in your report exactly what was run, the commands and the counts, and what was not run.
- Do not edit CHANGELOG.md, ROADMAP.md, README.md, ARCHITECTURE.md, HARDWARE-TESTING.md, DEVICE-SUPPORT.md or the registry's verification fields. Put what should be recorded in your final report. Document your part in code comments and, if needed, one new file in `docs/`.
- Engine code is erasable-only TypeScript (no enums, no parameter properties) so Node can run it directly. No new runtime dependency unless the brief names it.
- Never write a FireWire ID or serial number. Test fixtures use made-up IDs that do not start with 000A27 or 000A95. A test scans every file for those shapes.
- Plain language in comments and messages, no em dashes. Never write "works" for something that was not run on hardware.
- When something is out of reach or too risky, stop and say so with the evidence. A clear partial result beats a hidden hack.
