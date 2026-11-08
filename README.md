# OpenTunes for iPod

Put music, podcasts, audiobooks and video on an iPod from a web page, without iTunes and without a server. It runs entirely in your browser: pick the iPod's folder, back it up, add files, and the page converts what the iPod cannot play and writes the iPod's library the way iTunes would.

> **Tested on the iPod nano 7th generation only.** Support for other iPods is built from published specifications and has never been tried on a real device.
>
> **Use it at your own risk.** OpenTunes writes to your iPod's database. A bad write can leave an iPod showing an empty or broken library until it is restored. It makes a backup before it writes, reads every write back, undoes itself if anything is off, and can restore the backup, but none of that is a guarantee. It has been tried on **one** device, an iPod nano 7th generation. Other models are listed from specifications and may not work. There is no warranty. Do not use it on an iPod holding the only copy of anything you care about.

Not affiliated with or endorsed by Apple. iPod and iTunes are trademarks of Apple Inc.

## What it does

- **Reads** an iPod's library: model, how its database is signed, tracks and playlists.
- **Backs up** the database files to a folder you choose, with every copy read back and checksummed. Nothing writes until a complete backup exists.
- **Adds** music, podcasts, audiobooks and video, one file or a whole folder with subfolders. Files the iPod cannot play (FLAC, Ogg, Opus, high-resolution WAV, HEVC, VP9 and others) are converted in the page with ffmpeg compiled to WebAssembly. Folder names such as `Audiobooks` or `TV Shows` set what each file is. There is a short guide in the app for how to arrange your files.
- **Organises**: filter, sort, group, select, bulk-edit tags, and manage playlists.
- **Offloads**: copies everything off the iPod to your computer as it sits on the iPod, with a CSV that says which title is which file and the iPod's library files, so one folder can put everything back ("Restore everything").
- **Restores** a backup, after checking its checksums.
- **AI assistant (optional, off by default)**: with your own Claude or OpenAI-style API key, ask in plain words to tidy tags, group audiobook chapters or build playlists. It only proposes changes. You see a preview and approve, and every change goes through the same backup and read-back as everything else. Turning it on sends your tracks' titles, artists, albums and genres (no audio, no file paths) to the provider you choose. See [docs/AI-ORGANISER.md](docs/AI-ORGANISER.md).

Nothing is uploaded unless you turn the AI assistant on, and nothing is downloaded from streaming services: OpenTunes only works with files you already have.

## How well is it tested?

| What | Status |
| --- | --- |
| iPod nano 7th generation (the owner's unit, macOS, Chrome) | Reading, signing, backup, a database rewrite, and a sync of songs, a podcast and videos all worked, as reported by the owner. Not recorded in more detail than that, see [docs/HARDWARE-TESTING.md](docs/HARDWARE-TESTING.md). |
| Every other iPod model | Not tried. Listed from specifications in [docs/DEVICE-SUPPORT.md](docs/DEVICE-SUPPORT.md). |
| Audiobooks with chapters, Apple Lossless, album art, photos | Built or planned, not confirmed on a device. Album art and photos are not written yet. |
| Windows, Linux, Android | Not tried. Chrome or Edge on a computer is what it is built for. |

The code is covered by unit tests, engine tests and headless-Chrome checks that run a whole add, convert, remove and edit flow against an iPod held in memory. Those prove the logic, not that a particular iPod accepts the result.

## Using it safely

1. Plug the iPod in so it appears as a drive on your computer.
2. Open the page in Chrome or Edge on a computer, choose the iPod's folder.
3. **Back up** on the Backup tab and keep that folder.
4. Add one or two songs first. Eject the iPod from your computer, unplug it and check it plays.
5. Only then add more.

## Run it yourself

You need Node 22 or newer and Chrome.

```
npm install
npm run dev
```

Open http://localhost:5173. The iPod engine is built from source in Docker (`npm run engine:build`, Docker must be running) and the converter is copied from `node_modules` when the app is built, so a fresh clone needs both steps once before the page can open an iPod.

```
npm run check        # typecheck, tests and build
npm run engine:build # builds the iPod engine in Docker
npm run engine:test  # tests the built engine in Node
npm run smoke        # builds the app and runs the headless-Chrome checks
npm run docs:check   # fails if docs/DEVICE-SUPPORT.md is out of date
```

To try everything with no iPod, press "Try a practice iPod" on the first screen. It lives in memory and changes are gone when you reload.

## Layout

| Folder | What it holds |
| --- | --- |
| `app/` | The web app (Vite, TypeScript, Preact). |
| `core/` | Pure logic with tests: device registry, capability detection, the media probe and the plan for copy or convert. |
| `engine/` | The iPod database engine (libgpod compiled to WebAssembly): C interface, bindings, the Docker build, patches, and the sync, backup, restore and offload code. |
| `docs/` | Architecture, roadmap, device support, test guides. |

More: [Architecture](docs/ARCHITECTURE.md), [Roadmap](docs/ROADMAP.md), [The engine](docs/ENGINE-BUILD.md), [Hardware tests](docs/HARDWARE-TESTING.md).

## Credits

OpenTunes started from the idea behind [TunesReloaded](https://github.com/rish1p/tunesreloaded), which showed that an iPod can be managed from a web page with libgpod compiled to WebAssembly and the File System Access API. No TunesReloaded code is in this repository.

It stands on [libgpod](https://github.com/gtkpod/libgpod), [dstaley/hashab](https://github.com/dstaley/hashab), [SQLite](https://www.sqlite.org), [libplist](https://github.com/libimobiledevice/libplist), [glib](https://gitlab.gnome.org/GNOME/glib), [libxml2](https://gitlab.gnome.org/GNOME/libxml2), [libffi](https://github.com/libffi/libffi), [zlib](https://zlib.net), [pcre2](https://github.com/PCRE2Project/pcre2), [emscripten](https://emscripten.org), [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) and [FFmpeg](https://ffmpeg.org), [Preact](https://preactjs.com) and [Vite](https://vite.dev). Every component, its licence and where it is used are in [THIRD_PARTY.md](THIRD_PARTY.md), and the app's "About, credits and risk" page shows the same list. Thank you to everyone who made them.

## Licence

OpenTunes is free software under the **GNU General Public License, version 3 or later** (see [LICENSE](LICENSE)). The converter bundles a GPL build of FFmpeg, which is why. The engine is built from pinned sources by [engine/Dockerfile](engine/Dockerfile), with this repository's patches, so anyone can rebuild it.

## Problems

Open an issue and fill in the template: it asks for the iPod model, your browser, whether you made a backup, and the copied report. **Never paste your iPod's serial number or FireWire ID.** This is a hobby project and support is best effort.

If a sync goes wrong: do not use the iPod as it is. Restore the backup from the Backup tab, then check it again.

## Troubleshooting

**`node` fails with `Library not loaded ... libllhttp`.** Homebrew upgraded a library that this Node build links against. `brew reinstall node` fixes it.

**Chrome says USB or folder access is unavailable.** Open "Browser and USB checks" (landing page, or Diagnostics once an iPod is open). It names the missing feature and what to do about it.
