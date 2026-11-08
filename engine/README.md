# Engine

The iPod database engine: libgpod compiled to WebAssembly, a C interface of our own, and typed bindings. What it contains, how it is built and what the tests show are in [../docs/ENGINE-BUILD.md](../docs/ENGINE-BUILD.md).

```
npm run engine:build    # Docker build, output in engine/build/
npm run engine:test     # Node tests against that build
```

| Folder | What it holds |
| --- | --- |
| `Dockerfile` | The whole build, with every source pinned by version and SHA-256. |
| `src/` | `engine.c`, the C interface, and `glib_shims.c`. |
| `js/` | `engine.ts`, the typed bindings the app and the tests use. |
| `patches/libgpod/` | Our three changes to libgpod, applied in name order. |
| `meson/` | The cross-compilation file used to build glib. |
| `scripts/` | `build.sh` (Docker build and copy out) and `fetch.sh` (download with a checksum check). |
| `data/` | SysInfoExtended template for the nano 7G, used by the demo iPods and tests. It is the owner's own unit's file with the FireWire ID, serial number and MLBN replaced by placeholders. |
| `test/` | Node tests, and the hashAB known-answer vectors. |
| `build/` | Generated output (`engine.js`, `engine.wasm`). Ignored by git. |
