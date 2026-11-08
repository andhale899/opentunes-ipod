# Third-party notices

OpenTunes is released under the GNU General Public License, version 3 or later (see `LICENSE`). The components below are separate works with their own licences, listed as the projects' own files state them. Everything here is used with thanks.

## The idea

[TunesReloaded](https://github.com/rish1p/tunesreloaded) by rish1p showed that an iPod can be managed from a web page, with libgpod compiled to WebAssembly and the File System Access API. OpenTunes started from that idea. No TunesReloaded code is in this repository: the engine's C interface, the build and the app were written for this project. Two device description templates that came from its repository are being replaced (see below).

Versions and checksums for everything the engine builds are in [engine/Dockerfile](engine/Dockerfile). Licences below are what the projects' own files say, read on 2026-11-07 from the pinned sources unless marked otherwise.

## Compiled into the engine

| Component | Licence | Notes |
| --- | --- | --- |
| [libgpod](https://github.com/gtkpod/libgpod) (`gtkpod/libgpod`, commit `7982c55`) | LGPL, version 2 or later (source file headers) | Statically linked. Four patches of ours are in `engine/patches/libgpod/`. GitHub labels the licence "Other" because `COPYING` is the older "Library GPL" text. |
| [libplist](https://github.com/libimobiledevice/libplist) 2.6.0 | LGPL 2.1 (`COPYING.LESSER`) | Statically linked. |
| [glib](https://gitlab.gnome.org/GNOME/glib) 2.80.5 | LGPL 2.1 or later, per the emscripten-forge recipe (not re-read from the source) | Statically linked, with the emscripten patch series from that recipe. |
| [libxml2](https://gitlab.gnome.org/GNOME/libxml2) 2.12.9 | MIT-style (`Copyright` file) | |
| [libffi](https://github.com/libffi/libffi) 3.5.2 | MIT | 3.4.6's licence file was read. 3.5.2's was not. |
| [SQLite](https://www.sqlite.org) 3.47.2 | Public domain | |
| [zlib](https://zlib.net) 1.3.1 | zlib licence | Not re-read from the source. |
| [pcre2](https://github.com/PCRE2Project/pcre2) | BSD, believed | Built by glib's own subproject. Not re-read. |
| [hashab](https://github.com/dstaley/hashab) (`dstaley/hashab`, commit `f80d464`) | The Unlicense (public domain) | Reverse engineered from nano 6G firmware and checked against `libhashab32.so`. |
| [emscripten](https://emscripten.org) runtime and libc | MIT-style, believed | Part of the generated JavaScript and WebAssembly. Not re-read. |

Linking LGPL libraries statically means that anyone given the compiled engine must also be able to get the matching source and rebuild it. The Dockerfile, the patches and the pinned checksums are what would satisfy that. That is why the engine is built from pinned sources by `engine/Dockerfile` in this repository, with our patches, and why `npm run engine:build` reproduces it.

## In the repository

| Component | Where | Licence | Notes |
| --- | --- | --- | --- |
| SysInfoExtended templates | `engine/data/` | Unknown | Dumped from a real nano and kept as a fallback. The device's serial numbers were removed. They come from the same upstream repository. |
| hashAB test vectors | `engine/test/hashab-vectors.json` | The Unlicense | From `dstaley/hashab` at the pinned commit. |

## Loaded by the converter

Copied from `node_modules` into `app/public/ffmpeg/` by `app/scripts/sync-ffmpeg.mjs` (generated, not committed) and served from the app's own origin.

| Component | Licence | Notes |
| --- | --- | --- |
| [`@ffmpeg/ffmpeg`](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12.15 | MIT (package.json) | The JavaScript that starts the worker. Bundled into the app. |
| [`@ffmpeg/core`](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12.10 | GPL 2 or later (package.json) | The WebAssembly build of FFmpeg 5.1.4, single thread. Its own configure line, read from the wasm file, includes `--enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx --enable-libmp3lame --enable-libvorbis --enable-libopus`, so the whole core is GPL. The package ships no licence text of its own, so the licences of the libraries inside it (FFmpeg, [x264](https://www.videolan.org/developers/x264.html), [x265](https://www.x265.org), [libvpx](https://www.webmproject.org/code/), [LAME](https://lame.sourceforge.io), [libvorbis](https://xiph.org/vorbis/), [Opus](https://opus-codec.org)) are those projects' own, and the core as a whole is GPL. OpenTunes is released under the GPL for this reason. Source for FFmpeg is at [ffmpeg.org](https://ffmpeg.org), and the build recipe for this core is in the [ffmpeg.wasm repository](https://github.com/ffmpegwasm/ffmpeg.wasm). |

## Built into the app (npm)

| Component | Licence | Notes |
| --- | --- | --- |
| [Preact](https://preactjs.com) | MIT | The interface. |
| [Vite](https://vite.dev) | MIT | The build tool, not shipped. |
| [TypeScript](https://www.typescriptlang.org), [Vitest](https://vitest.dev), [tsx](https://tsx.is) | Apache-2.0, MIT, MIT | Build and test tools, not shipped. Licences as the projects state them. |

Run `npm ls` and read each package's own licence for the full dependency list.

## Test media

The test files used by the owner during development (`testmedia`, not in this repository) were public-domain or Creative Commons works: LibriVox recordings, Big Buck Bunny (Blender Foundation, CC BY 3.0) and others. They are not redistributed here.

## Apple

iPod, iTunes and Apple are trademarks of Apple Inc. OpenTunes is not affiliated with or endorsed by Apple. It reads and writes the same database files iTunes does, on iPods you own, and checks every write.
