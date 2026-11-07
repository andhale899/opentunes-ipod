# Third-party notices

OpenTunes is a personal project and is not distributed. Before it is ever shared, every row below needs its licensing confirmed. The repository's own `LICENSE` is MIT, but that does not cover the components below, and some of them may not be compatible with it.

| Component | Where | Licence, as believed | Status |
| --- | --- | --- | --- |
| libgpod | Compiled into `engine/prebuilt/ipod_manager.wasm` | LGPL 2.1 or later | Source version unknown. To be pinned in the engine build. |
| glib, libplist, libxml2, SQLite, zlib, libiconv, libffi | Statically linked into the same file, per the original build script | Mixed, some LGPL | Versions unknown. To be pinned in the engine build. |
| TunesReloaded wrapper | `engine/src/ipod_manager.c`, `glib_thread_stubs.c` and the original build script | Unknown | v1 vendored a fork of rish1p/tunesreloaded with no licence file. The upstream licence has not been checked. |
| calcHashAB.wasm and hashAB.js | `engine/hashab/` | Unknown | 506 KB prebuilt file, origin not recorded. Needed for the nano 6G and 7G. |
| ffmpeg.wasm | Not included yet | Depends on the build | Planned for the converter. The core may be GPL if it includes x264. Check when added. |

Prebuilt file hashes and what is known about them are in [engine/prebuilt/PROVENANCE.md](engine/prebuilt/PROVENANCE.md).
