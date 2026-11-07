# Third-party notices

OpenTunes is a personal project and is not distributed. Before it is ever shared, check this list again. The repository's own `LICENSE` is MIT, and that does not cover the components below.

Versions and checksums for everything the engine builds are in [engine/Dockerfile](engine/Dockerfile). Licences below are what the projects' own files say, read on 2026-11-07 from the pinned sources unless marked otherwise.

## Compiled into the engine

| Component | Licence | Notes |
| --- | --- | --- |
| libgpod (`gtkpod/libgpod`, commit `7982c55`) | LGPL, version 2 or later (source file headers) | Statically linked. Three patches of ours are in `engine/patches/libgpod/`. GitHub labels the licence "Other" because `COPYING` is the older "Library GPL" text. |
| libplist 2.6.0 | LGPL 2.1 (`COPYING.LESSER`) | Statically linked. |
| glib 2.80.5 | LGPL 2.1 or later, per the emscripten-forge recipe (not re-read from the source) | Statically linked, with the emscripten patch series from that recipe. |
| libxml2 2.12.9 | MIT-style (`Copyright` file) | |
| libffi 3.5.2 | MIT | 3.4.6's licence file was read. 3.5.2's was not. |
| SQLite 3.47.2 | Public domain | |
| zlib 1.3.1 | zlib licence | Not re-read from the source. |
| pcre2 | BSD, believed | Built by glib's own subproject. Not re-read. |
| hashab (`dstaley/hashab`, commit `f80d464`) | The Unlicense (public domain) | Reverse engineered from nano 6G firmware and checked against `libhashab32.so`. |
| emscripten runtime and libc | MIT-style, believed | Part of the generated JavaScript and WebAssembly. Not re-read. |

Linking LGPL libraries statically means that anyone given the compiled engine must also be able to get the matching source and rebuild it. The Dockerfile, the patches and the pinned checksums are what would satisfy that. It does not matter for private use.

## In the repository

| Component | Where | Licence | Notes |
| --- | --- | --- | --- |
| SysInfoExtended templates | `engine/data/` | Unknown | Dumped from a real nano and kept as a fallback. The device's serial numbers were removed. They come from the same upstream repository. |
| hashAB test vectors | `engine/test/hashab-vectors.json` | The Unlicense | From `dstaley/hashab` at the pinned commit. |

## Planned

| Component | Notes |
| --- | --- |
| ffmpeg.wasm | For the converter. The core may be GPL if it includes x264. Check when added. |
