# Provenance of the prebuilt files

These files came from the v1 repository and are kept only so Phase 1 has something to compare against. Do not build features on them.

| File | Size (bytes) | SHA-256 |
| --- | --- | --- |
| `engine/prebuilt/ipod_manager.js` | 115689 | `6ebb5c470a3a099b09040b6dfba6c0212d8dd4fb130c347d77bcb90d5922fa69` |
| `engine/prebuilt/ipod_manager.wasm` | 4393084 | `f0e2176ffa91d582bc3c42aa20e6d2bd2b37f48552b0fa357da5bbf0e87d07ec` |
| `engine/hashab/calcHashAB.wasm` | 506338 | `b565e73a7f08939ed097946ca179a2d6eb08087994ba35191578d3e8b5af79f0` |
| `engine/hashab/hashAB.js` | 6797 | `511b26201e2885c849860479de50f823154ca6dcc842187b77eb47ca3c4ef19a` |

## What is known

- `ipod_manager.js` and `.wasm` were built from `engine/src/ipod_manager.c` plus libgpod, using a build script that points at the original author's machine. The v1 task list says the files were rebuilt during v1 to allow video, but the wrapper source in this repo still tags every track as audio. Whether the files match the source exactly is unknown.
- The v1 repository held byte-identical copies of the `.wasm` and `.js` files in two places. One copy is kept here.
- `calcHashAB.wasm` has no recorded origin or licence.

## What is not known

- Which libgpod version and patches went into the build.
- Whether the prebuilt files and `engine/src/ipod_manager.c` are in step.
